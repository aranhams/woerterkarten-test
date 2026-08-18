import { verifyBearer, applyCors, getDb } from "./_firebase.js";
import { rateLimit } from "./_ratelimit.js";
import { requestLogger } from "./_log.js";

const DAY_MS = 86_400_000;
const CARDS_CAP = 500;
const FOLDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

function toCard(id, w) {
  return {
    id,
    de: String(w.de || ""),
    article: String(w.article || ""),
    deRev: w.deRev || 0,
    folderId: w.folderId ?? null,
    genus: w.pron && "genus" in w.pron ? w.pron.genus : null,
  };
}

export default async function handler(req, res) {
  const L = requestLogger("article-quiz", req);
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    L.done("warn", "article.method_not_allowed", 405, { method: req.method });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await verifyBearer(req);
  if (!user) {
    L.done("warn", "article.unauthorized", 401);
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body || {};
  const isTeacher = user.teacher === true || user.admin === true;
  const rawFolder = body.folderId ? String(body.folderId).slice(0, 64) : null;
  const folderId = rawFolder && FOLDER_ID.test(rawFolder) ? rawFolder : null;
  const db = getDb();

  const day = new Date().toISOString().slice(0, 10);
  const limits = [
    ["min", `article:${user.uid}`, { max: 30, windowMs: 60_000 }],
    ["day", `article:day:${user.uid}:${day}`, { max: 500, windowMs: DAY_MS }],
  ];
  for (const [scope, key, opts] of limits) {
    const r = await rateLimit(key, opts);
    if (r.limited) {
      L.done("warn", "article.ratelimited", 429, { uid: user.uid, scope, degraded: r.degraded });
      res.setHeader("Retry-After", String(r.retryAfterSec));
      return res.status(429).json({ error: "Too many requests" });
    }
  }

  try {
    const cards = [];
    if (isTeacher) {
      // Teacher preview: a single folder's words (no progress is saved).
      if (folderId) {
        const snap = await db.collection("global_words").where("folderId", "==", folderId).limit(CARDS_CAP).get();
        for (const d of snap.docs) cards.push(toCard(d.id, d.data()));
      }
    } else {
      const snap = await db.collection("global_words")
        .where("memberUids", "array-contains", user.uid).limit(CARDS_CAP).get();
      for (const d of snap.docs) {
        const w = d.data();
        if (folderId && (w.folderId ?? null) !== folderId) continue;
        cards.push(toCard(d.id, w));
      }
    }

    L.done("info", "article.quiz", 200, { uid: user.uid, teacher: isTeacher, folderId, returned: cards.length });
    return res.status(200).json({ cards });
  } catch (e) {
    L.done("error", "article.fail", 500, { uid: user.uid, err: e?.message });
    return res.status(500).json({ error: "Server error" });
  }
}
