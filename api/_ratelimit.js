import { getDb } from "./_firebase.js";
import { logEvent } from "./_log.js";

function db() { return getDb(); }

const col = () => db().collection("rate_limits");

export { clientIp } from "./_log.js";

export async function rateLimit(key, { max = 30, windowMs = 60_000 } = {}) {
  const ref = col().doc(`rl_${key}`);
  const now = Date.now();
  try {
    return await db().runTransaction(async (tx) => {
      const d = (await tx.get(ref)).data();
      let count = d?.count || 0;
      let windowStart = d?.windowStart || 0;
      if (now - windowStart >= windowMs) { count = 0; windowStart = now; }
      count += 1;
      tx.set(ref, { count, windowStart, expireAt: new Date(windowStart + windowMs) }, { merge: true });
      const retryAfterSec = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
      return { limited: count > max, remaining: Math.max(0, max - count), retryAfterSec };
    });
  } catch (e) {
    logEvent("alert", "ratelimit.degraded", { fn: "rateLimit", key, err: e?.message });
    return { limited: false, remaining: max, retryAfterSec: 0, degraded: true };
  }
}

export async function checkLock(keys, { max = 5, windowMs = 15 * 60_000 } = {}) {
  const now = Date.now();
  try {
    const snaps = await db().getAll(...keys.map((k) => col().doc(`lock_${k}`)));
    let worst = 0;
    for (const s of snaps) {
      const d = s.data();
      if (!d) continue;
      if (now - (d.windowStart || 0) >= windowMs) continue;
      if ((d.fails || 0) >= max) {
        worst = Math.max(worst, Math.ceil(((d.windowStart || 0) + windowMs - now) / 1000));
      }
    }
    return worst > 0 ? { blocked: true, retryAfterSec: Math.max(1, worst) } : { blocked: false };
  } catch (e) {
    logEvent("alert", "ratelimit.degraded", { fn: "checkLock", err: e?.message });
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
    }).catch((e) => logEvent("error", "ratelimit.register_failed", { key: k, err: e?.message }));
  }));
}

export async function resetLock(keys) {
  await Promise.all(keys.map((k) =>
    col().doc(`lock_${k}`).delete().catch(() => {})
  ));
}
