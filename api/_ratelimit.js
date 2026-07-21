// api/_ratelimit.js
// Distributed rate limiting + failed-attempt lockout, backed by Firestore so the
// limits hold across Vercel's concurrent / recycled serverless instances. The old
// per-instance `new Map()` counters (sign-cloudinary.js, translate.js) are
// best-effort only: an attacker spread across instances bypasses them. This is
// authoritative because every instance shares the same Firestore documents.
//
// Primitives:
//   rateLimit(key, {max, windowMs})      -> fixed-window request cap
//   checkLock(keys, {max, windowMs})     -> is any key locked out?
//   registerFailure(keys, {windowMs})    -> +1 failed attempt on each key
//   resetLock(keys)                      -> clear on success
//
// State lives in the `rate_limits` collection. It is denied to all clients in
// firestore.rules (the Admin SDK bypasses rules). Add a Firestore TTL policy on
// the `expireAt` field to auto-purge stale counters.
import { getApps, initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function db() {
  if (!getApps().length) {
    const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
    initializeApp(svc ? { credential: cert(JSON.parse(svc)) } : { credential: applicationDefault() });
  }
  return getFirestore();
}

const col = () => db().collection("rate_limits");

// Best-effort client IP from Vercel's proxy chain. Left-most XFF entry is the
// client; fall back to the socket address. Used so account-rotation (open
// signup) can't trivially reset a per-uid limit.
export function clientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.socket?.remoteAddress || "unknown";
}

// ── Fixed-window request cap ────────────────────────────────────────────────
// Returns { limited, remaining, retryAfterSec }. Fails OPEN (never blocks real
// traffic) if Firestore is unavailable — acceptable for volume throttling.
export async function rateLimit(key, { max = 30, windowMs = 60_000 } = {}) {
  const ref = col().doc(`rl_${key}`);
  const now = Date.now();
  try {
    return await db().runTransaction(async (tx) => {
      const d = (await tx.get(ref)).data();
      let count = d?.count || 0;
      let windowStart = d?.windowStart || 0;
      if (now - windowStart >= windowMs) { count = 0; windowStart = now; } // roll window
      count += 1;
      tx.set(ref, { count, windowStart, expireAt: new Date(windowStart + windowMs) }, { merge: true });
      const retryAfterSec = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
      return { limited: count > max, remaining: Math.max(0, max - count), retryAfterSec };
    });
  } catch (e) {
    console.error(`[ratelimit] rl_${key} failed, allowing: ${e?.message}`);
    return { limited: false, remaining: max, retryAfterSec: 0, degraded: true };
  }
}

// ── Failed-attempt lockout (for credential/secret-guessing endpoints) ───────
// Counts FAILURES per key inside a rolling window; once a key hits `max`, it is
// blocked until the window elapses. Pass several keys (e.g. per-IP AND per-uid)
// and the caller is blocked if ANY is locked. Fails open but logs loudly — the
// entropy of the secret is the primary control; the lockout is defence-in-depth.
export async function checkLock(keys, { max = 5, windowMs = 15 * 60_000 } = {}) {
  const now = Date.now();
  try {
    const snaps = await db().getAll(...keys.map((k) => col().doc(`lock_${k}`)));
    let worst = 0;
    for (const s of snaps) {
      const d = s.data();
      if (!d) continue;
      if (now - (d.windowStart || 0) >= windowMs) continue; // window expired -> not locked
      if ((d.fails || 0) >= max) {
        worst = Math.max(worst, Math.ceil(((d.windowStart || 0) + windowMs - now) / 1000));
      }
    }
    return worst > 0 ? { blocked: true, retryAfterSec: Math.max(1, worst) } : { blocked: false };
  } catch (e) {
    console.error(`[ratelimit] checkLock failed, allowing: ${e?.message}`);
    return { blocked: false, degraded: true };
  }
}

export async function registerFailure(keys, { windowMs = 15 * 60_000 } = {}) {
  const now = Date.now();
  await Promise.all(keys.map((k) => {
    const ref = col().doc(`lock_${k}`);
    return db().runTransaction(async (tx) => {
      const d = (await tx.get(ref)).data();
      let fails = d?.fails || 0;
      let windowStart = d?.windowStart || now;
      if (now - windowStart >= windowMs) { fails = 0; windowStart = now; }
      fails += 1;
      tx.set(ref, { fails, windowStart, expireAt: new Date(windowStart + windowMs) }, { merge: true });
    }).catch((e) => console.error(`[ratelimit] registerFailure lock_${k}: ${e?.message}`));
  }));
}

export async function resetLock(keys) {
  await Promise.all(keys.map((k) =>
    col().doc(`lock_${k}`).delete().catch(() => {})
  ));
}
