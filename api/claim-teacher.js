import crypto from "crypto";
import { verifyBearer, applyCors, getAuth, getDb } from "./_firebase.js";
import { checkLock, registerFailure, resetLock, clientIp } from "./_ratelimit.js";
import { requestLogger } from "./_log.js";
import { getTeacherCode } from "./_admin.js";

const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60_000;

export default async function handler(req, res) {
  const L = requestLogger("claim-teacher", req);
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await verifyBearer(req);
  if (!user) {
    L.done("warn", "teacher.claim.unauthorized", 401);
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { code: expected } = await getTeacherCode(getDb());
  if (!expected) {
    L.done("error", "teacher.claim.misconfigured", 500, { uid: user.uid });
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const keys = [`claim:ip:${clientIp(req)}`, `claim:uid:${user.uid}`];

  const lock = await checkLock(keys, { max: MAX_FAILS, windowMs: WINDOW_MS });
  if (lock.blocked) {
    L.done("alert", "teacher.claim.lockout", 429, { uid: user.uid, retryAfterSec: lock.retryAfterSec });
    res.setHeader("Retry-After", String(lock.retryAfterSec));
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }

  const code = String((req.body && req.body.code) || "");
  const ok = safeEqual(code, expected);

  if (!ok) {
    await registerFailure(keys, { windowMs: WINDOW_MS });
    L.done("warn", "teacher.claim.invalid", 403, { uid: user.uid, attemptedCode: code.slice(0, 64) });
    return res.status(403).json({ error: "Invalid code" });
  }

  await resetLock(keys);
  await getAuth().setCustomUserClaims(user.uid, { teacher: true });
  L.done("alert", "teacher.claim.success", 200, { uid: user.uid, name: user.name });
  return res.status(200).json({ ok: true });
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
