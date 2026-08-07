import { verifyBearer, applyCors, getDb } from "./_firebase.js";
import { rateLimit, clientIp } from "./_ratelimit.js";
import { requestLogger } from "./_log.js";
import { ensurePron, PRON_V } from "./_pron.js";

const WORD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RESYNC = 25;
const BUDGET_MAX = 3000;
const DAY_MS = 86_400_000;

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const dayKey = () => new Date().toISOString().slice(0, 10);

async function budgetExhausted(db, key) {
  const snap = await db.doc(`rate_limits/rl_${key}`).get().catch(() => null);
  const d = snap && snap.exists ? snap.data() : null;
  if (!d) return false;
  if (Date.now() - (d.windowStart || 0) >= DAY_MS) return false;
  return (d.count || 0) >= BUDGET_MAX;
}

function wordRef(db, user, isTeacher, wordId, scope) {
  if (!WORD_ID.test(wordId)) throw new HttpError(400, "wordId ungültig");
  if (scope === "global") {
    if (!isTeacher) throw new HttpError(403, "Forbidden");
    return db.doc(`global_words/${wordId}`);
  }
  return db.doc(`users/${user.uid}/words/${wordId}`);
}

function isFresh(word, de) {
  const p = word.pron;
  return !!p && p.v === PRON_V && p.de === de && p.st === "ready";
}

async function processWord(db, ref, L) {
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, "Wort nicht gefunden");
  const word = snap.data();
  const de = String(word.de || "").normalize("NFC").trim();
  if (!de) throw new HttpError(400, "Wort ohne de");

  if (isFresh(word, de)) return { status: "skipped", external: false };

  const { pron, external } = await ensurePron(db, de, L);
  await ref.set({ pron }, { merge: true });
  return { status: pron.st === "ready" ? "done" : "failed", external, pron };
}

export default async function handler(req, res) {
  const L = requestLogger("pronounce", req);
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    L.done("warn", "pron.method_not_allowed", 405, { method: req.method });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await verifyBearer(req);
  if (!user) {
    L.done("warn", "pron.unauthorized", 401, { hadToken: !!req.headers.authorization });
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (process.env.PRON_ENABLED === "0") {
    L.done("warn", "pron.disabled", 503, { uid: user.uid });
    return res.status(503).json({ error: "Aussprache vorübergehend deaktiviert" });
  }

  const body = req.body || {};
  const action = String(body.action || "word");
  const isTeacher = user.teacher === true || user.admin === true;
  const db = getDb();
  const day = dayKey();
  const budgetKey = `pron:budget:${day}`;

  try {
    if (action === "word") {
      const checks = [
        ["min", `pron:uid:${user.uid}`, { max: 20, windowMs: 60_000 }],
        ["day", `pron:day:${user.uid}:${day}`, { max: 200, windowMs: DAY_MS }],
        ["ip", `pron:ip:${clientIp(req)}`, { max: 60, windowMs: 60_000 }],
      ];
      for (const [scope, key, opts] of checks) {
        const r = await rateLimit(key, opts);
        if (r.limited) {
          L.done("warn", "pron.ratelimited", 429, { uid: user.uid, scope, degraded: r.degraded });
          res.setHeader("Retry-After", String(r.retryAfterSec));
          return res.status(429).json({ error: "Too many requests" });
        }
      }

      if (await budgetExhausted(db, budgetKey)) {
        L.done("alert", "pron.budget_exhausted", 503, { uid: user.uid });
        return res.status(503).json({ error: "Aussprache vorübergehend nicht verfügbar" });
      }

      const scope = body.scope === "global" ? "global" : "personal";
      const ref = wordRef(db, user, isTeacher, String(body.wordId || ""), scope);
      const out = await processWord(db, ref, L);
      if (out.external) await rateLimit(budgetKey, { max: BUDGET_MAX, windowMs: DAY_MS });

      L.done("info", "pron.word", 200, { uid: user.uid, scope, status: out.status, external: out.external });
      return res.status(200).json({ ok: true, status: out.status, pron: out.pron || null });
    }

    if (action === "resync") {
      if (!isTeacher) {
        L.done("warn", "pron.forbidden", 403, { uid: user.uid, action });
        return res.status(403).json({ error: "Forbidden" });
      }
      const ids = Array.isArray(body.wordIds) ? body.wordIds.map(String) : [];
      if (!ids.length || ids.length > MAX_RESYNC) {
        L.done("warn", "pron.bad_batch", 400, { uid: user.uid, count: ids.length });
        return res.status(400).json({ error: `1–${MAX_RESYNC} wordIds erwartet` });
      }

      const rl = await rateLimit(`pron:resync:${user.uid}`, { max: 30, windowMs: 60_000 });
      if (rl.limited) {
        L.done("warn", "pron.resync_ratelimited", 429, { uid: user.uid, degraded: rl.degraded });
        res.setHeader("Retry-After", String(rl.retryAfterSec));
        return res.status(429).json({ error: "Too many requests" });
      }
      if (await budgetExhausted(db, budgetKey)) {
        L.done("alert", "pron.budget_exhausted", 503, { uid: user.uid, action });
        return res.status(503).json({ error: "Tagesbudget erreicht" });
      }

      const results = {};
      let done = 0, skipped = 0, failed = 0;
      for (const id of ids) {
        try {
          const out = await processWord(db, wordRef(db, user, isTeacher, id, "global"), L);
          if (out.external) await rateLimit(budgetKey, { max: BUDGET_MAX, windowMs: DAY_MS });
          results[id] = out.pron || null;
          if (out.status === "done") done++;
          else if (out.status === "skipped") skipped++;
          else failed++;
        } catch (e) {
          failed++;
          L.log("warn", "pron.resync_item_failed", { uid: user.uid, wordId: id, err: e?.message });
        }
      }

      L.done("info", "pron.resync", 200, { uid: user.uid, done, skipped, failed });
      return res.status(200).json({ ok: true, done, skipped, failed, results });
    }

    L.done("warn", "pron.bad_action", 400, { uid: user.uid, action });
    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    L.done(status >= 500 ? "error" : "warn", "pron.fail", status, { uid: user.uid, action, err: e?.message });
    return res.status(status).json({ error: status >= 500 ? "Server error" : e.message });
  }
}
