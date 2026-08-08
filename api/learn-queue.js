import { verifyBearer, applyCors, getDb } from "./_firebase.js";
import { rateLimit } from "./_ratelimit.js";
import { requestLogger } from "./_log.js";
import { FieldValue } from "firebase-admin/firestore";
import { selectDueQueue } from "./_progress.js";

const GETALL_CHUNK = 300;
const DAY_MS = 86_400_000;

async function buildManifest(db, uid) {
  const snap = await db.collection("global_words").where("memberUids", "array-contains", uid).get();
  const words = snap.docs.map((d) => ({ i: d.id, f: d.data().folderId ?? null, r: d.data().deRev || 0 }));
  await db.doc(`users/${uid}/meta/assigned`).set(
    { v: 1, gen: 1, updatedAt: FieldValue.serverTimestamp(), words },
    { merge: true },
  );
  return words;
}

export default async function handler(req, res) {
  const L = requestLogger("learn-queue", req);
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    L.done("warn", "learn.method_not_allowed", 405, { method: req.method });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await verifyBearer(req);
  if (!user) {
    L.done("warn", "learn.unauthorized", 401);
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (user.teacher === true || user.admin === true) {
    L.done("warn", "learn.teacher_rejected", 403, { uid: user.uid });
    return res.status(403).json({ error: "Forbidden" });
  }

  const day = new Date().toISOString().slice(0, 10);
  for (const [scope, key, opts] of [
    ["min", `learn:${user.uid}`, { max: 30, windowMs: 60_000 }],
    ["day", `learn:day:${user.uid}:${day}`, { max: 500, windowMs: DAY_MS }],
  ]) {
    const r = await rateLimit(key, opts);
    if (r.limited) {
      L.done("warn", "learn.ratelimited", 429, { uid: user.uid, scope, degraded: r.degraded });
      res.setHeader("Retry-After", String(r.retryAfterSec));
      return res.status(429).json({ error: "Too many requests" });
    }
  }

  const body = req.body || {};
  const folderId = body.folderId ? String(body.folderId).slice(0, 64) : null;
  const db = getDb();

  try {
    const [manifestSnap, progressSnap] = await db.getAll(
      db.doc(`users/${user.uid}/meta/assigned`),
      db.doc(`users/${user.uid}/meta/progress`),
    );

    let manifest = manifestSnap.exists && Array.isArray(manifestSnap.data().words)
      ? manifestSnap.data().words
      : null;
    let built = manifest === null;

    // Safety net: any write path that forgets to patch the manifest shows up as a count
    // mismatch here (1 aggregation read) and is repaired on the spot, rather than silently
    // hiding words from Lernen while they stay visible in Wörter.
    if (!built) {
      const live = await db.collection("global_words")
        .where("memberUids", "array-contains", user.uid).count().get()
        .then((s) => s.data().count).catch(() => null);
      if (live !== null && live !== manifest.length) {
        L.log("warn", "learn.manifest_drift", { uid: user.uid, manifest: manifest.length, live });
        manifest = null;
        built = true;
      }
    }
    if (built) manifest = await buildManifest(db, user.uid);

    const gen = built ? 1 : (manifestSnap.data().gen || 0);
    const progress = (progressSnap.exists ? progressSnap.data()?.data : null) || {};
    const { picked, capped, stats } = selectDueQueue(manifest, progress, { folderId });

    const dueWords = [];
    let dropped = 0;
    for (let i = 0; i < picked.length; i += GETALL_CHUNK) {
      const slice = picked.slice(i, i + GETALL_CHUNK);
      const snaps = await db.getAll(...slice.map((id) => db.doc(`global_words/${id}`)));
      for (const s of snaps) {
        if (!s.exists) { dropped++; continue; }
        const { memberUids, deL, ruL, ...w } = s.data();
        if (!Array.isArray(memberUids) || !memberUids.includes(user.uid)) { dropped++; continue; }
        dueWords.push({ ...w, id: s.id, source: "global" });
      }
    }

    if (dropped) L.log("warn", "learn.queue.stale", { uid: user.uid, dropped });
    L.done("info", "learn.queue", 200, {
      uid: user.uid, total: stats.total, due: stats.due, returned: dueWords.length, dropped, built, folderId,
    });

    return res.status(200).json({ dueWords, stats, capped, gen, built });
  } catch (e) {
    L.done("error", "learn.fail", 500, { uid: user.uid, err: e?.message });
    return res.status(500).json({ error: "Server error" });
  }
}
