import { verifyBearer, applyCors, getDb } from "./_firebase.js";
import { rateLimit } from "./_ratelimit.js";
import { requestLogger } from "./_log.js";
import { listLiveRepeats } from "../shared/repeat.js";

const DAY_MS = 86_400_000;
const CARDS_CAP = 500;

export default async function handler(req, res) {
  const L = requestLogger("repeat", req);
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    L.done("warn", "repeat.method_not_allowed", 405, { method: req.method });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await verifyBearer(req);
  if (!user) {
    L.done("warn", "repeat.unauthorized", 401);
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (user.teacher === true || user.admin === true) {
    L.done("warn", "repeat.teacher_rejected", 403, { uid: user.uid });
    return res.status(403).json({ error: "Forbidden" });
  }

  const body = req.body || {};
  const classId = body.classId ? String(body.classId).slice(0, 128) : null;
  if (!classId || !/^[A-Za-z0-9_-]{1,128}$/.test(classId)) {
    L.done("warn", "repeat.bad_class", 400, { uid: user.uid });
    return res.status(400).json({ error: "classId ungültig" });
  }
  const repeatId = body.repeatId ? String(body.repeatId).slice(0, 64) : null;
  const db = getDb();

  const day = new Date().toISOString().slice(0, 10);
  const limits = [
    ["min", `repeat:${user.uid}`, { max: 30, windowMs: 60_000 }],
    ["day", `repeat:day:${user.uid}:${day}`, { max: 500, windowMs: DAY_MS }],
  ];
  for (const [scope, key, opts] of limits) {
    const r = await rateLimit(key, opts);
    if (r.limited) {
      L.done("warn", "repeat.ratelimited", 429, { uid: user.uid, scope, degraded: r.degraded });
      res.setHeader("Retry-After", String(r.retryAfterSec));
      return res.status(429).json({ error: "Too many requests" });
    }
  }

  try {
    const classSnap = await db.doc(`classes/${classId}`).get();
    if (!classSnap.exists) {
      L.done("warn", "repeat.no_class", 404, { uid: user.uid });
      return res.status(404).json({ error: "Kurs nicht gefunden" });
    }
    const cls = classSnap.data();
    const members = Array.isArray(cls.memberUids) ? cls.memberUids : [];
    if (!members.includes(user.uid)) {
      L.done("warn", "repeat.not_member", 403, { uid: user.uid, classId });
      return res.status(403).json({ error: "Forbidden" });
    }
    const live = listLiveRepeats(cls);
    // Serve a specific repeat when the student names one; otherwise the union of
    // all live repeats for this class.
    const selected = repeatId ? live.filter((e) => e.id === repeatId) : live;
    if (!selected.length) {
      L.done("info", "repeat.inactive", 200, { uid: user.uid, classId, repeatId });
      return res.status(200).json({ words: [], active: false });
    }

    const folderSet = new Set();
    for (const e of selected) {
      for (const fid of e.folderIds) if (/^[A-Za-z0-9_-]{1,64}$/.test(fid)) folderSet.add(fid);
    }
    if (!folderSet.size) {
      L.done("warn", "repeat.bad_folder", 200, { uid: user.uid, classId });
      return res.status(200).json({ words: [], active: false });
    }

    const snap = await db.collection("global_words")
      .where("memberUids", "array-contains", user.uid).limit(CARDS_CAP).get();
    const words = [];
    for (const d of snap.docs) {
      const data = d.data();
      if (!folderSet.has(data.folderId ?? null)) continue;
      const { memberUids, deL, ruL, desc, ...w } = data;
      if (!Array.isArray(memberUids) || !memberUids.includes(user.uid)) continue;
      words.push({ ...w, id: d.id, source: "global" });
    }

    const label = selected.map((e) => e.label).filter(Boolean).join(" · ");
    L.done("info", "repeat.queue", 200, { uid: user.uid, classId, repeatId, folders: folderSet.size, returned: words.length });
    return res.status(200).json({ words, active: true, label, expiresAt: selected[0].expiresAt ?? null });
  } catch (e) {
    L.done("error", "repeat.fail", 500, { uid: user.uid, err: e?.message });
    return res.status(500).json({ error: "Server error" });
  }
}
