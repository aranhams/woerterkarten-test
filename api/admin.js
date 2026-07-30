import { verifyBearer, applyCors, getDb } from "./_firebase.js";
import { checkLock, clientIp } from "./_ratelimit.js";
import { requestLogger } from "./_log.js";
import { getTeacherCode, regenTeacherCode } from "./_admin.js";

const MAX_FAILS = 20;
const WINDOW_MS = 15 * 60_000;
const ACTIONS = new Set(["get-teacher-code", "regen-teacher-code"]);

export default async function handler(req, res) {
  const L = requestLogger("admin", req);
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await verifyBearer(req);
  if (!user) {
    L.done("warn", "admin.unauthorized", 401);
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (user.admin !== true) {
    L.done("warn", "admin.forbidden", 403, { uid: user.uid });
    return res.status(403).json({ error: "Forbidden" });
  }

  const action = String((req.body && req.body.action) || "");
  if (!ACTIONS.has(action)) {
    L.done("warn", "admin.bad_action", 400, { uid: user.uid, action });
    return res.status(400).json({ error: "Unknown action" });
  }

  const keys = [`admin:ip:${clientIp(req)}`, `admin:uid:${user.uid}`];
  const lock = await checkLock(keys, { max: MAX_FAILS, windowMs: WINDOW_MS });
  if (lock.blocked) {
    L.done("alert", "admin.lockout", 429, { uid: user.uid, retryAfterSec: lock.retryAfterSec });
    res.setHeader("Retry-After", String(lock.retryAfterSec));
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }

  const db = getDb();
  try {
    if (action === "get-teacher-code") {
      const info = await getTeacherCode(db);
      L.done("info", "admin.get_teacher_code", 200, { uid: user.uid, source: info.source });
      return res.status(200).json({ ok: true, code: info.code, source: info.source });
    }
    const code = await regenTeacherCode(db, user.uid);
    L.done("alert", "admin.regen_teacher_code", 200, { uid: user.uid });
    return res.status(200).json({ ok: true, code, source: "stored" });
  } catch (e) {
    L.done("error", `admin.${action}.fail`, 500, { uid: user.uid, err: e.message });
    return res.status(500).json({ error: "Server error" });
  }
}
