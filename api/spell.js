import { verifyBearer, applyCors, getDb } from "./_firebase.js";
import { rateLimit } from "./_ratelimit.js";
import { requestLogger } from "./_log.js";

const DAY_MS = 86_400_000;
const CARDS_CAP = 500;
const FOLDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CLASS_ID = /^[A-Za-z0-9_-]{1,128}$/;
const GETALL_CHUNK = 300;
const DESC_V = 1;

async function classWords(db, cls) {
  const folderIds = [...new Set((cls.folders || []).map((e) => e && e.folderId).filter(Boolean))];
  const looseIds = [...new Set((cls.wordIds || []).map(String).filter(Boolean))];
  const seen = new Map();
  for (let i = 0; i < folderIds.length; i += 30) {
    const slice = folderIds.slice(i, i + 30);
    if (!slice.length) continue;
    const snap = await db.collection("global_words").where("folderId", "in", slice).get();
    for (const d of snap.docs) seen.set(d.id, d.data());
  }
  const missing = looseIds.filter((id) => !seen.has(id));
  for (let i = 0; i < missing.length; i += GETALL_CHUNK) {
    const slice = missing.slice(i, i + GETALL_CHUNK);
    const snaps = await db.getAll(...slice.map((id) => db.doc(`global_words/${id}`)));
    for (const s of snaps) if (s.exists) seen.set(s.id, s.data());
  }
  return seen;
}

function descReady(w) {
  const d = w && w.desc;
  if (!d || d.v !== DESC_V || d.st !== "ready" || !d.text) return false;
  return String(d.de || "").trim().toLowerCase() === String(w.de || "").trim().toLowerCase();
}

function toCard(id, w) {
  return {
    id,
    de: String(w.de || ""),
    article: String(w.article || ""),
    folderId: w.folderId ?? null,
    deRev: w.deRev || 0,
    t: w.t || null,
    ru: String(w.ru || ""),
    imageUrl: w.imageUrl || null,
    desc: descReady(w) ? { text: String(w.desc.text) } : null,
  };
}

export default async function handler(req, res) {
  const L = requestLogger("spell", req);
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    L.done("warn", "spell.method_not_allowed", 405, { method: req.method });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await verifyBearer(req);
  if (!user) {
    L.done("warn", "spell.unauthorized", 401);
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body || {};
  const isTeacher = user.teacher === true || user.admin === true;
  const rawFolder = body.folderId ? String(body.folderId).slice(0, 64) : null;
  const folderId = rawFolder && FOLDER_ID.test(rawFolder) ? rawFolder : null;
  const rawClass = body.classId ? String(body.classId).slice(0, 128) : null;
  const classId = rawClass && CLASS_ID.test(rawClass) ? rawClass : null;
  const db = getDb();

  const day = new Date().toISOString().slice(0, 10);
  const limits = [
    ["min", `spell:${user.uid}`, { max: 30, windowMs: 60_000 }],
    ["day", `spell:day:${user.uid}:${day}`, { max: 500, windowMs: DAY_MS }],
  ];
  for (const [scope, key, opts] of limits) {
    const r = await rateLimit(key, opts);
    if (r.limited) {
      L.done("warn", "spell.ratelimited", 429, { uid: user.uid, scope, degraded: r.degraded });
      res.setHeader("Retry-After", String(r.retryAfterSec));
      return res.status(429).json({ error: "Too many requests" });
    }
  }

  try {
    const cards = [];
    if (isTeacher) {
      if (classId) {
        const clsSnap = await db.doc(`classes/${classId}`).get();
        if (clsSnap.exists) {
          const words = await classWords(db, clsSnap.data());
          for (const [id, w] of words) {
            if (w.spellOff === true) continue;
            cards.push(toCard(id, w));
            if (cards.length >= CARDS_CAP) break;
          }
        }
      } else if (folderId) {
        const snap = await db.collection("global_words").where("folderId", "==", folderId).limit(CARDS_CAP).get();
        for (const d of snap.docs) {
          const w = d.data();
          if (w.spellOff === true) continue;
          cards.push(toCard(d.id, w));
        }
      }
    } else {
      const snap = await db.collection("global_words").where("memberUids", "array-contains", user.uid).limit(CARDS_CAP).get();
      for (const d of snap.docs) {
        const w = d.data();
        if (w.spellOff === true) continue;
        if (folderId && (w.folderId ?? null) !== folderId) continue;
        cards.push(toCard(d.id, w));
      }
    }

    L.done("info", "spell.deck", 200, { uid: user.uid, teacher: isTeacher, folderId, classId, returned: cards.length });
    return res.status(200).json({ cards });
  } catch (e) {
    L.done("error", "spell.fail", 500, { uid: user.uid, err: e?.message });
    return res.status(500).json({ error: "Server error" });
  }
}
