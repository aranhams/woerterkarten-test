import { verifyBearer, applyCors, getDb } from "./_firebase.js";
import { rateLimit, clientIp } from "./_ratelimit.js";
import { requestLogger } from "./_log.js";
import {
  DESC_V, descFresh, mentionsHeadword, buildDescribeRequest, clipDesc, descNfc, descNorm,
} from "./_describe.js";

const WORD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DAY_MS = 86_400_000;
const BUDGET_MAX = 2000;

export default async function handler(req, res) {
  const L = requestLogger("describe", req);
  const DEBUG = process.env.DEBUG_DESCRIBE === "1" || process.env.NODE_ENV !== "production";
  const dbg = (event, extra = {}) => { if (DEBUG) L.log("debug", event, extra); };

  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    L.done("warn", "describe.method_not_allowed", 405, { method: req.method });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await verifyBearer(req);
  if (!user) {
    L.done("warn", "describe.unauthorized", 401, { hadToken: !!req.headers.authorization });
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Teacher-only feature. Students never reach the generator (they also have no UI for
  // it), so descriptions can only be produced by a teacher acting on a course word.
  if (!(user.teacher === true || user.admin === true)) {
    L.done("warn", "describe.forbidden", 403, { uid: user.uid });
    return res.status(403).json({ error: "Forbidden" });
  }

  const body = req.body || {};
  const wordId = String(body.wordId || "").trim();
  const force = body.force === true;
  if (!WORD_ID.test(wordId)) {
    L.done("warn", "describe.bad_word_id", 400, { uid: user.uid });
    return res.status(400).json({ error: "wordId ungültig" });
  }

  const db = getDb();

  // Read the canonical word from Firestore; never trust the client's de/article text.
  let snap;
  try {
    snap = await db.doc(`global_words/${wordId}`).get();
  } catch (e) {
    L.done("error", "describe.read_failed", 500, { uid: user.uid, wordId, err: e?.message });
    return res.status(500).json({ error: "Server error" });
  }
  if (!snap.exists) {
    L.done("warn", "describe.not_found", 404, { uid: user.uid, wordId });
    return res.status(404).json({ error: "Wort nicht gefunden" });
  }

  const data = snap.data();
  const word = descNfc(data.de);
  const article = String(data.article || "").replace(/[^A-Za-zÄÖÜäöüß ]/g, "").slice(0, 10).trim();
  if (!word) {
    L.done("warn", "describe.no_de", 400, { uid: user.uid, wordId });
    return res.status(400).json({ error: "Wort ohne de" });
  }

  // Cache hit: a fresh description already on the doc. Skip the LLM and any write.
  if (!force && descFresh({ de: word, desc: data.desc })) {
    L.done("info", "describe.cache_hit", 200, { uid: user.uid, wordId });
    return res.status(200).json({ description: clipDesc(data.desc.text) });
  }

  if (/\b(ignore|system|assistant|instruction|prompt)\b/i.test(word) || word.length >= 88) {
    L.log("warn", "describe.injection_suspect", { uid: user.uid, word, len: word.length });
  }

  // Rate limits — separate buckets from translate so the two features cannot drain
  // each other's budget.
  const day = new Date().toISOString().slice(0, 10);
  const ip = clientIp(req);
  const checks = [
    ["min", `describe:${user.uid}`, { max: 30, windowMs: 60_000 }],
    ["day", `describe:day:${user.uid}:${day}`, { max: 150, windowMs: DAY_MS }],
    ["ip", `describe:ip:${ip}`, { max: 50, windowMs: 60_000 }],
  ];
  for (const [scope, key, opts] of checks) {
    const r = await rateLimit(key, opts);
    if (r.limited) {
      L.done("warn", "describe.ratelimited", 429, { uid: user.uid, scope, degraded: r.degraded });
      res.setHeader("Retry-After", String(r.retryAfterSec));
      return res.status(429).json({ error: "Too many requests" });
    }
  }

  if (!process.env.ANTHROPIC_KEY) {
    L.done("error", "describe.misconfigured", 500, { uid: user.uid });
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const budget = await rateLimit(`describe:budget:${day}`, { max: BUDGET_MAX, windowMs: DAY_MS });
  if (budget.limited) {
    L.done("alert", "describe.budget_exhausted", 503, { uid: user.uid });
    res.setHeader("Retry-After", String(budget.retryAfterSec));
    return res.status(503).json({ error: "Beschreibung vorübergehend nicht verfügbar" });
  }

  dbg("describe.request", { uid: user.uid, wordId, word, article, force });

  try {
    const first = await callClaude(word, article, { strict: false }, L, user.uid);
    if (first.error) return res.status(first.status).json({ error: first.error });

    let text = first.text;
    // Leak guard: one strict retry if the riddle names the answer; then best-effort.
    if (mentionsHeadword(text, word)) {
      L.log("info", "describe.leak_retry", { uid: user.uid, wordId });
      const retryBudget = await rateLimit(`describe:budget:${day}`, { max: BUDGET_MAX, windowMs: DAY_MS });
      if (!retryBudget.limited) {
        const second = await callClaude(word, article, { strict: true }, L, user.uid);
        if (!second.error && second.text) {
          if (!mentionsHeadword(second.text, word)) text = second.text;
          else { text = second.text; L.log("warn", "describe.leak_persist", { uid: user.uid, wordId }); }
        }
      }
    }

    const out = clipDesc(text);
    if (!out) {
      L.done("error", "describe.empty", 502, { uid: user.uid, wordId });
      return res.status(502).json({ error: "Beschreibung fehlgeschlagen" });
    }

    try {
      await snap.ref.set({ desc: { text: out, de: word, v: DESC_V, st: "ready" } }, { merge: true });
      L.log("info", "describe.cache_write", { uid: user.uid, wordId });
    } catch (e) {
      L.log("error", "describe.cache_write_failed", { uid: user.uid, wordId, err: e?.message });
    }

    L.done("info", "describe.ok", 200, { uid: user.uid, wordId, force });
    return res.status(200).json({ description: out });
  } catch (err) {
    L.done("error", "describe.exception", 500, { uid: user.uid, name: err?.name, err: err?.message });
    return res.status(500).json({ error: "Beschreibung fehlgeschlagen" });
  }
}

async function callClaude(word, article, opts, L, uid) {
  const upstreamStart = Date.now();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      ...buildDescribeRequest(word, article, opts),
    }),
  });
  const upstreamMs = Date.now() - upstreamStart;

  if (!response.ok) {
    const errBody = await response.text().catch(() => "<upstream body unreadable>");
    L.log("error", "describe.upstream_error", { uid, upstreamStatus: response.status, upstreamMs, body: errBody.slice(0, 300) });
    return { error: "Beschreibung fehlgeschlagen", status: 502 };
  }

  const dataR = await response.json();
  L.log("info", "describe.upstream_ok", { uid, upstreamMs, inTokens: dataR?.usage?.input_tokens, outTokens: dataR?.usage?.output_tokens });
  const raw = dataR?.content?.[0]?.text?.trim() || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    L.log("error", "describe.parse_failed", { uid, stopReason: dataR?.stop_reason, err: e.message });
    return { error: "Beschreibung fehlgeschlagen", status: 500 };
  }
  return { text: descNfc(parsed.description) };
}
