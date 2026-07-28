import crypto from "crypto";
import { verifyBearer, applyCors, getAuth } from "./_firebase.js";
import { checkLock, registerFailure, resetLock, clientIp } from "./_ratelimit.js";

const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60_000;

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await verifyBearer(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const expected = process.env.TEACHER_CODE || "";
  if (!expected) return res.status(500).json({ error: "Server misconfigured" });

  const keys = [`claim:ip:${clientIp(req)}`, `claim:uid:${user.uid}`];

  const lock = await checkLock(keys, { max: MAX_FAILS, windowMs: WINDOW_MS });
  if (lock.blocked) {
    res.setHeader("Retry-After", String(lock.retryAfterSec));
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }

  const code = String((req.body && req.body.code) || "");
  const ok = safeEqual(code, expected);

  if (!ok) {
    await registerFailure(keys, { windowMs: WINDOW_MS });
    return res.status(403).json({ error: "Invalid code" });
  }

  await resetLock(keys);
  await getAuth().setCustomUserClaims(user.uid, { teacher: true });
  return res.status(200).json({ ok: true });
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
