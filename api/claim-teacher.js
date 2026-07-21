// Vercel serverless — grant the teacher role after verifying the enrollment
// code server-side. The code lives in an env var, never in the client bundle;
// success sets a custom claim { teacher: true } on the user.
//
// Hardened: shared (Firestore-backed) failed-attempt lockout keyed on BOTH the
// client IP and the uid — because self-registration is open, a per-uid limit
// alone is bypassable by minting new accounts, so the IP key carries the weight.
//
// Env: TEACHER_CODE  (MUST be high-entropy, e.g. `openssl rand -hex 24`)
import crypto from "crypto";
import { verifyBearer, applyCors, getAuth } from "./_firebase.js";
import { checkLock, registerFailure, resetLock, clientIp } from "./_ratelimit.js";

const MAX_FAILS = 5;              // attempts per window, per key
const WINDOW_MS = 15 * 60_000;    // 15-minute rolling lockout

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await verifyBearer(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const expected = process.env.TEACHER_CODE || "";
  if (!expected) return res.status(500).json({ error: "Server misconfigured" });

  const keys = [`claim:ip:${clientIp(req)}`, `claim:uid:${user.uid}`];

  // 1) Refuse if this IP or uid has burned through its attempts.
  const lock = await checkLock(keys, { max: MAX_FAILS, windowMs: WINDOW_MS });
  if (lock.blocked) {
    res.setHeader("Retry-After", String(lock.retryAfterSec));
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }

  // 2) Constant-time compare (padded so timing doesn't leak the code length).
  const code = String((req.body && req.body.code) || "");
  const ok = safeEqual(code, expected);

  if (!ok) {
    await registerFailure(keys, { windowMs: WINDOW_MS }); // count the miss
    return res.status(403).json({ error: "Invalid code" });
  }

  await resetLock(keys);                                  // clean slate on success
  await getAuth().setCustomUserClaims(user.uid, { teacher: true });
  // Client must call getIdToken(true) to refresh the claim.
  return res.status(200).json({ ok: true });
}

// Length-independent, constant-time equality. Hashing both sides to a fixed
// width removes the previous `a.length === b.length` short-circuit, which was a
// (minor) timing oracle on the secret's length.
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
