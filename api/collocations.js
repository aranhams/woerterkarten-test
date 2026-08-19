import { verifyBearer, applyCors, getDb } from "./_firebase.js";
import { rateLimit, clientIp } from "./_ratelimit.js";
import { requestLogger } from "./_log.js";
import { FieldValue } from "firebase-admin/firestore";
import {
  COLLOC, clip, cleanText, normColloc, makeOption, isEligibleWord, baseCategory,
  countCorrect, countWrong, isPracticeReady, mergeGenerated, answerNormsOf, bumpRev,
  generatePrompt, projectReadyQuestion, summarizeWeakCollocations, copyOptions,
  WORD_CATEGORIES, PARTNER_LABELS, normKasus,
} from "./_collocations.js";
import { fetchWiktionaryWikitext, extractCollocations } from "./_pron.js";

async function korpusPartners(de, L) {
  try {
    const fetched = await fetchWiktionaryWikitext(de);
    if (fetched.status !== "ok") {
      L.log("info", "colloc.korpus_miss", { reason: fetched.status });
      return [];
    }
    const partners = extractCollocations(fetched.wikitext, { word: de });
    L.log("info", "colloc.korpus_hit", { n: partners.length, partners });
    return partners;
  } catch (err) {
    L.log("info", "colloc.korpus_failed", { err: err?.message });
    return [];
  }
}

const DAY_MS = 86_400_000;
const BUDGET_MAX = 2000;
const FOLDER_CAP = 500;
const PRACTICE_CAP = 300;
const GETALL_CHUNK = 150;
const WORD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OPT_ID = /^o_[A-Za-z0-9_]{1,40}$/;
const FOLDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

const TEACHER_ACTIONS = new Set([
  "opt-in", "opt-out", "bulk-opt-in-folder", "bulk-opt-in-ids", "bulk-opt-out-ids", "generate", "resync",
  "set-category", "add-option", "edit-option", "toggle-correct", "remove-option", "weak-collocations",
  "add-variant", "remove-variant", "purge-sets",
]);
const ROSTER_CAP = 500;
const AI_ACTIONS = new Set(["generate"]);
const ALL_ACTIONS = new Set([...TEACHER_ACTIONS, "practice-set"]);

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const setRef = (db, wordId) => db.doc(`collocation_sets/${wordId}`);

function reqWordId(v) {
  const id = String(v || "").trim();
  if (!WORD_ID.test(id)) throw new HttpError(400, "wordId ungültig");
  return id;
}
function reqOptId(v) {
  const id = String(v || "").trim();
  if (!OPT_ID.test(id)) throw new HttpError(400, "optionId ungültig");
  return id;
}
function reqFolderId(v) {
  const id = String(v || "").trim();
  if (!FOLDER_ID.test(id)) throw new HttpError(400, "folderId ungültig");
  return id;
}

async function loadSet(db, wordId) {
  const snap = await setRef(db, wordId).get();
  return snap.exists ? snap.data() : null;
}
async function loadWord(db, wordId) {
  const snap = await db.doc(`global_words/${wordId}`).get();
  if (!snap.exists) throw new HttpError(404, "Wort nicht gefunden");
  return snap.data();
}

async function resolveBaseWord(db, set, wordId) {
  return loadWord(db, set && set.variant ? String(set.baseWordId || "") : wordId);
}

function teacherView(set) {
  const options = Array.isArray(set.options) ? set.options : [];
  return {
    wordId: set.wordId,
    optedIn: set.optedIn === true,
    de: set.de || "",
    article: set.article || "",
    deRev: set.deRev || 0,
    gen: set.gen || 0,
    rev: set.rev || 0,
    cat: set.cat || null,
    partnerLabel: set.partnerLabel || null,
    variant: set.variant === true,
    baseWordId: set.baseWordId || null,
    variants: Array.isArray(set.variants) ? set.variants : [],
    options: options.map((o) => ({ id: o.id, text: o.text, correct: !!o.correct, source: o.source || "manual", kasus: normKasus(o.kasus) })),
  };
}

async function callAnthropic({ system, user, schema, maxTokens }, { L, uid }) {
  if (!process.env.ANTHROPIC_KEY) throw new HttpError(500, "Server misconfigured");
  const upstreamStart = Date.now();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: maxTokens,
      thinking: { type: "disabled" },
      system,
      output_config: { format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: user }],
    }),
  });
  const upstreamMs = Date.now() - upstreamStart;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    L.log("error", "colloc.upstream_error", { uid, upstreamStatus: response.status, upstreamMs, body: body.slice(0, 200) });
    throw new HttpError(502, "KI-Dienst nicht verfügbar");
  }
  const data = await response.json();
  const stopReason = data?.stop_reason;
  L.log("info", "colloc.upstream_ok", { uid, upstreamMs, stopReason, inTokens: data?.usage?.input_tokens, outTokens: data?.usage?.output_tokens });
  const textBlock = Array.isArray(data?.content) ? data.content.find((b) => b?.type === "text") : null;
  const text = textBlock?.text?.trim() || "";
  if (!text) {
    L.log("error", "colloc.no_text", { uid, stopReason, blocks: Array.isArray(data?.content) ? data.content.map((b) => b?.type) : null });
    throw new HttpError(502, stopReason === "max_tokens"
      ? "KI-Antwort wurde abgeschnitten (Token-Limit erreicht). Bitte erneut versuchen."
      : "KI-Antwort ohne Textinhalt.");
  }
  try { return JSON.parse(text); }
  catch (e) { L.log("error", "colloc.parse_failed", { uid, stopReason, err: e.message }); throw new HttpError(502, "KI-Antwort ungültig"); }
}

async function spendBudget(day) {
  const b = await rateLimit(`colloc:budget:${day}`, { max: BUDGET_MAX, windowMs: DAY_MS });
  if (b.limited) throw new HttpError(503, "Tagesbudget für KI erreicht");
}

export default async function handler(req, res) {
  const L = requestLogger("collocations", req);
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    L.done("warn", "colloc.method_not_allowed", 405, { method: req.method });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await verifyBearer(req);
  if (!user) {
    L.done("warn", "colloc.unauthorized", 401, { hadToken: !!req.headers.authorization });
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body || {};
  const action = String(body.action || "");
  if (!ALL_ACTIONS.has(action)) {
    L.done("warn", "colloc.bad_action", 400, { uid: user.uid, action });
    return res.status(400).json({ error: "Unknown action" });
  }
  const isTeacher = user.teacher === true || user.admin === true;
  if (TEACHER_ACTIONS.has(action) && !isTeacher) {
    L.done("warn", "colloc.forbidden", 403, { uid: user.uid, action });
    return res.status(403).json({ error: "Forbidden" });
  }

  const day = new Date().toISOString().slice(0, 10);

  const base = await rateLimit(`colloc:uid:${user.uid}`, { max: 60, windowMs: 60_000 });
  if (base.limited) {
    L.done("warn", "colloc.ratelimited", 429, { uid: user.uid, scope: "min", degraded: base.degraded });
    res.setHeader("Retry-After", String(base.retryAfterSec));
    return res.status(429).json({ error: "Too many requests" });
  }
  if (AI_ACTIONS.has(action)) {
    const ip = clientIp(req);
    const checks = [
      ["day", `colloc:day:${user.uid}:${day}`, { max: 200, windowMs: DAY_MS }],
      ["ip", `colloc:ip:${ip}`, { max: 80, windowMs: 60_000 }],
    ];
    for (const [scope, key, opts] of checks) {
      const r = await rateLimit(key, opts);
      if (r.limited) {
        L.done("warn", "colloc.spend_limited", 429, { uid: user.uid, scope, degraded: r.degraded });
        res.setHeader("Retry-After", String(r.retryAfterSec));
        return res.status(429).json({ error: "Too many requests" });
      }
    }
  }

  const db = getDb();
  const ctx = { L, uid: user.uid, day };
  const stamp = () => FieldValue.serverTimestamp();

  try {
    const result = await dispatch({ db, user, action, body, ctx, stamp, isTeacher });
    L.done("info", `colloc.${action}`, 200, { uid: user.uid });
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    L.done(status >= 500 ? "error" : "warn", `colloc.${action}.fail`, status, { uid: user.uid, err: e?.message });
    return res.status(status).json({ error: status >= 500 ? "Server error" : e.message });
  }
}

async function persist(db, wordId, base, patch, stamp, uid) {
  const full = { wordId, ...patch, updatedAt: stamp(), updatedBy: uid };
  await setRef(db, wordId).set(full, { merge: true });
  return { set: teacherView({ ...base, ...full }) };
}

async function collocationManifest(db, uid) {
  const snap = await db.doc(`users/${uid}/meta/assigned`).get().catch(() => null);
  if (snap && snap.exists && Array.isArray(snap.data().words)) {
    return snap.data().words.map((e) => ({ id: e.i, folderId: e.f ?? null })).filter((e) => e.id);
  }
  const q = await db.collection("global_words").where("memberUids", "array-contains", uid).get();
  return q.docs.map((d) => ({ id: d.id, folderId: d.data().folderId ?? null }));
}

async function teacherManifest(db, folderId = null) {
  if (folderId) {
    const wordSnap = await db.collection("global_words").where("folderId", "==", folderId).limit(FOLDER_CAP).get();
    const wordIds = wordSnap.docs.map((d) => d.id);
    const out = [];
    for (let i = 0; i < wordIds.length; i += GETALL_CHUNK) {
      const slice = wordIds.slice(i, i + GETALL_CHUNK);
      const snaps = slice.length ? await db.getAll(...slice.map((id) => setRef(db, id))) : [];
      for (let j = 0; j < slice.length; j++) {
        const s = snaps[j];
        if (s.exists && s.data().optedIn !== false) out.push({ id: slice[j], folderId });
      }
    }
    return out;
  }
  const snap = await db.collection("collocation_sets").where("optedIn", "==", true).limit(PRACTICE_CAP * 2).get();
  const ids = snap.docs.filter((d) => d.data().variant !== true).map((d) => d.id);
  const wordSnaps = ids.length ? await db.getAll(...ids.map((id) => db.doc(`global_words/${id}`))) : [];
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const w = wordSnaps[i].data();
    out.push({ id: ids[i], folderId: w?.folderId ?? null });
  }
  return out;
}

async function classWordIds(db, cls) {
  const folderIds = [...new Set((cls.folders || []).map((e) => e && e.folderId).filter(Boolean))];
  const looseIds = [...new Set((cls.wordIds || []).map(String).filter(Boolean))];
  const ids = new Set(looseIds);
  for (let i = 0; i < folderIds.length; i += 30) {
    const slice = folderIds.slice(i, i + 30);
    if (!slice.length) continue;
    const snap = await db.collection("global_words").where("folderId", "in", slice).get();
    for (const d of snap.docs) ids.add(d.id);
  }
  return [...ids];
}

async function dispatch({ db, user, action, body, ctx, stamp, isTeacher }) {
  switch (action) {
    case "practice-set": {
      const folderId = body.folderId ? reqFolderId(body.folderId) : null;
      const manifest = isTeacher ? await teacherManifest(db, folderId) : await collocationManifest(db, user.uid);
      const scoped = (folderId && !isTeacher ? manifest.filter((e) => e.folderId === folderId) : manifest).slice(0, PRACTICE_CAP);
      const folderOf = new Map(scoped.map((e) => [e.id, e.folderId]));
      const ids = [...folderOf.keys()];

      const questions = [];
      const variantJobs = [];
      for (let i = 0; i < ids.length; i += GETALL_CHUNK) {
        const slice = ids.slice(i, i + GETALL_CHUNK);
        const refs = slice.flatMap((id) => [setRef(db, id), db.doc(`global_words/${id}`)]);
        const snaps = refs.length ? await db.getAll(...refs) : [];
        for (let j = 0; j < slice.length; j++) {
          const setSnap = snaps[2 * j];
          const wordSnap = snaps[2 * j + 1];
          if (!setSnap.exists || !wordSnap.exists) continue;
          if (!isTeacher) {
            const wm = wordSnap.data().memberUids;
            if (!Array.isArray(wm) || !wm.includes(user.uid)) continue;
          }
          const setData = setSnap.data();
          const folderId2 = folderOf.get(slice[j]) ?? null;
          const imageUrl = wordSnap.data().imageUrl || null;
          const q = projectReadyQuestion(setData);
          if (q) questions.push({ ...q, folderId: folderId2, imageUrl });
          for (const vId of (Array.isArray(setData.variants) ? setData.variants : [])) {
            variantJobs.push({ vId, folderId: folderId2, imageUrl });
          }
        }
      }

      let variantCount = 0;
      for (let i = 0; i < variantJobs.length; i += GETALL_CHUNK) {
        const slice = variantJobs.slice(i, i + GETALL_CHUNK);
        const snaps = slice.length ? await db.getAll(...slice.map((j) => setRef(db, j.vId))) : [];
        for (let j = 0; j < slice.length; j++) {
          const s = snaps[j];
          if (!s.exists) continue;
          const q = projectReadyQuestion(s.data());
          if (q) { questions.push({ ...q, folderId: slice[j].folderId, imageUrl: slice[j].imageUrl }); variantCount++; }
        }
      }

      ctx.L.log("info", "colloc.practice_set", { uid: user.uid, teacher: isTeacher, manifest: manifest.length, served: questions.length, variants: variantCount, folderId });
      return { questions };
    }

    case "weak-collocations": {
      const classId = String(body.classId || "").trim();
      if (!classId) throw new HttpError(400, "classId fehlt");
      const classSnap = await db.doc(`classes/${classId}`).get();
      if (!classSnap.exists) throw new HttpError(404, "Kurs nicht gefunden");
      const cls = classSnap.data();
      const roster = (Array.isArray(cls.memberUids) ? cls.memberUids : []).slice(0, ROSTER_CAP);
      const wordIds = (await classWordIds(db, cls)).slice(0, PRACTICE_CAP);

      const sets = new Map();
      for (let i = 0; i < wordIds.length; i += GETALL_CHUNK) {
        const slice = wordIds.slice(i, i + GETALL_CHUNK);
        const snaps = slice.length ? await db.getAll(...slice.map((id) => setRef(db, id))) : [];
        for (const s of snaps) if (s.exists) sets.set(s.id, s.data());
      }

      const progressByUid = new Map();
      for (let i = 0; i < roster.length; i += GETALL_CHUNK) {
        const slice = roster.slice(i, i + GETALL_CHUNK);
        const snaps = slice.length ? await db.getAll(...slice.map((u) => db.doc(`users/${u}/meta/collocationProgress`))) : [];
        for (let j = 0; j < slice.length; j++) {
          const s = snaps[j];
          progressByUid.set(slice[j], (s && s.exists ? s.data()?.data : null) || {});
        }
      }

      const weak = summarizeWeakCollocations(sets, progressByUid);
      const ready = [...sets.values()].filter((s) => isPracticeReady(s)).length;
      ctx.L.log("info", "colloc.weak", { uid: user.uid, classId, roster: roster.length, ready, weak: weak.length });
      return { weak, readyCount: ready };
    }

    case "opt-in": {
      const wordId = reqWordId(body.wordId);
      const word = await loadWord(db, wordId);
      const de = clip(word.de, COLLOC.deLen);
      if (!de) throw new HttpError(400, "Wort ohne de");
      const existing = await loadSet(db, wordId);
      const article = clip(word.article, COLLOC.articleLen);
      return persist(db, wordId, existing || {}, {
        optedIn: true, de, article, deRev: word.deRev || 0,
        cat: existing?.cat || baseCategory(article).cat,
      }, stamp, user.uid);
    }

    case "opt-out": {
      const wordId = reqWordId(body.wordId);
      const existing = await loadSet(db, wordId);
      if (!existing) return { set: null };
      return persist(db, wordId, existing, { optedIn: false }, stamp, user.uid);
    }

    case "resync": {
      const wordId = reqWordId(body.wordId);
      const existing = await loadSet(db, wordId);
      if (!existing) throw new HttpError(404, "Set nicht gefunden");
      const word = await resolveBaseWord(db, existing, wordId);
      const de = clip(word.de, COLLOC.deLen);
      if (!de) throw new HttpError(400, "Wort ohne de");
      const article = clip(word.article, COLLOC.articleLen);
      return persist(db, wordId, existing, {
        de, article, deRev: word.deRev || 0,
        cat: existing.cat || baseCategory(article).cat,
      }, stamp, user.uid);
    }

    case "set-category": {
      const wordId = reqWordId(body.wordId);
      const existing = await loadSet(db, wordId);
      if (!existing) throw new HttpError(404, "Set nicht gefunden");
      const cat = String(body.cat || "").trim();
      const partnerLabel = String(body.partnerLabel || "").trim();
      if (cat && !WORD_CATEGORIES.includes(cat)) throw new HttpError(400, "Wortart ungültig");
      if (partnerLabel && !PARTNER_LABELS.includes(partnerLabel)) throw new HttpError(400, "Partner-Wortart ungültig");
      return persist(db, wordId, existing, { cat: cat || null, partnerLabel: partnerLabel || null }, stamp, user.uid);
    }

    case "bulk-opt-in-folder": {
      const folderId = reqFolderId(body.folderId);
      const snap = await db.collection("global_words").where("folderId", "==", folderId).limit(FOLDER_CAP).get();
      const eligible = snap.docs.filter((d) => isEligibleWord(d.data()));
      if (eligible.length) {
        const batch = db.batch();
        for (const d of eligible) {
          const w = d.data();
          const article = clip(w.article, COLLOC.articleLen);
          batch.set(setRef(db, d.id), {
            wordId: d.id, optedIn: true,
            de: clip(w.de, COLLOC.deLen), article,
            deRev: w.deRev || 0, updatedAt: stamp(), updatedBy: user.uid,
            cat: baseCategory(article).cat,
          }, { merge: true });
        }
        await batch.commit();
      }
      return { wordIds: eligible.map((d) => d.id), skipped: snap.size - eligible.length };
    }

    case "bulk-opt-in-ids": {
      const rawIds = Array.isArray(body.wordIds) ? body.wordIds : [];
      const ids = rawIds.map(String).filter(Boolean).slice(0, FOLDER_CAP);
      if (!ids.length) return { wordIds: [], skipped: 0 };
      const wordSnaps = ids.length ? await db.getAll(...ids.map((id) => db.doc(`global_words/${id}`))) : [];
      const batch = db.batch();
      let skipped = 0;
      for (let i = 0; i < ids.length; i++) {
        const snap = wordSnaps[i];
        if (!snap.exists) { skipped++; continue; }
        const w = snap.data();
        const de = clip(w.de, COLLOC.deLen);
        if (!de) { skipped++; continue; }
        const article = clip(w.article, COLLOC.articleLen);
        batch.set(setRef(db, ids[i]), {
          wordId: ids[i], optedIn: true,
          de, article, deRev: w.deRev || 0,
          cat: baseCategory(article).cat,
          updatedAt: stamp(), updatedBy: user.uid,
        }, { merge: true });
      }
      await batch.commit();
      return { wordIds: ids, skipped };
    }

    case "bulk-opt-out-ids": {
      const rawIds = Array.isArray(body.wordIds) ? body.wordIds : [];
      const ids = rawIds.map(String).filter(Boolean).slice(0, FOLDER_CAP);
      if (!ids.length) return { wordIds: [], skipped: 0 };
      const batch = db.batch();
      for (const id of ids) {
        batch.set(setRef(db, id), { optedIn: false, updatedAt: stamp(), updatedBy: user.uid }, { merge: true });
      }
      await batch.commit();
      return { wordIds: ids, skipped: 0 };
    }

    case "generate": {
      const wordId = reqWordId(body.wordId);
      const existing = await loadSet(db, wordId);
      if (!existing || existing.optedIn !== true) throw new HttpError(400, "Wort nicht aktiviert");
      if (existing.variant === true) throw new HttpError(400, "Für Duplikate keine KI-Generierung");
      const options = Array.isArray(existing.options) ? existing.options : [];
      if (options.length >= COLLOC.maxOptions) throw new HttpError(400, `Höchstens ${COLLOC.maxOptions} Optionen`);
      const word = await loadWord(db, wordId);
      const de = clip(word.de, COLLOC.deLen);
      const article = clip(word.article, COLLOC.articleLen);
      const korpus = await korpusPartners(de, ctx.L);
      await spendBudget(ctx.day);
      const ai = await callAnthropic(generatePrompt(de, article, options, korpus), ctx);
      const distractorTexts = Array.isArray(ai.distractors)
        ? ai.distractors.map((d) => (d && typeof d === "object" ? d.text : d)).filter((d) => typeof d === "string")
        : [];
      if (!ai || typeof ai.correct !== "string" || distractorTexts.length < 3) {
        ctx.L.log("error", "colloc.generate.invalid_shape", { uid: user.uid, wordId, ai: JSON.stringify(ai).slice(0, 1000) });
        throw new HttpError(502, "KI-Antwort hat nicht das erwartete Format (1 richtige + mindestens 3 falsche Optionen). Bitte erneut versuchen.");
      }
      const targetWord = `${article ? article + " " : ""}${de}`.trim().toLowerCase();
      if (targetWord && ai.correct.toLowerCase().includes(targetWord)) {
        throw new HttpError(502, "KI-Antwort enthält das Zielwort in der richtigen Option. Die Option soll nur den Partner enthalten.");
      }
      const prevAnswers = answerNormsOf(options);
      const merged = mergeGenerated(options, {
        correct: cleanText(ai.correct, COLLOC.optionLen),
        kasus: ai.kasus,
        distractors: distractorTexts.map((d) => cleanText(d, COLLOC.optionLen)),
      }, { uid: user.uid });
      if (merged.length === options.length) {
        throw new HttpError(502, "KI hat keine neuen Optionen geliefert. Alle Vorschläge waren bereits vorhanden. Bitte erneut versuchen oder manuell hinzufügen.");
      }
      return persist(db, wordId, existing, {
        de, article, deRev: word.deRev || 0,
        cat: clip(ai.category, COLLOC.labelLen) || existing.cat || baseCategory(article).cat,
        partnerLabel: existing.partnerLabel || clip(ai.partnerLabel, COLLOC.labelLen) || null,
        gen: (existing.gen || 0) + 1, options: merged, rev: bumpRev(existing.rev, prevAnswers, merged),
      }, stamp, user.uid);
    }

    case "add-option": {
      const wordId = reqWordId(body.wordId);
      const existing = await loadSet(db, wordId);
      if (!existing || existing.optedIn !== true) throw new HttpError(400, "Wort nicht aktiviert");
      const options = Array.isArray(existing.options) ? existing.options.slice() : [];
      if (options.length >= COLLOC.maxOptions) throw new HttpError(400, `Höchstens ${COLLOC.maxOptions} Optionen`);
      const wantCorrect = body.correct === true;
      const opt = makeOption(body.text, wantCorrect, "manual", { uid: user.uid, kasus: normKasus(body.kasus) });
      if (!opt) throw new HttpError(400, "Text erforderlich");
      if (options.some((o) => o.norm === opt.norm)) throw new HttpError(400, "Option existiert bereits");
      options.push(opt);
      return persist(db, wordId, existing, { options }, stamp, user.uid);
    }

    case "edit-option": {
      const wordId = reqWordId(body.wordId);
      const optId = reqOptId(body.optionId);
      const existing = await loadSet(db, wordId);
      if (!existing) throw new HttpError(404, "Set nicht gefunden");
      const options = Array.isArray(existing.options) ? existing.options.slice() : [];
      const idx = options.findIndex((o) => o && o.id === optId);
      if (idx < 0) throw new HttpError(404, "Option nicht gefunden");
      const text = cleanText(body.text, COLLOC.optionLen);
      const norm = normColloc(text);
      if (!norm) throw new HttpError(400, "Text erforderlich");
      if (options.some((o, i) => i !== idx && o.norm === norm)) throw new HttpError(400, "Option existiert bereits");
      const prevAnswers = answerNormsOf(options);
      const kasusPatch = body.kasus !== undefined ? { kasus: normKasus(body.kasus) } : {};
      options[idx] = { ...options[idx], text, norm, ...kasusPatch, updatedAt: Date.now(), updatedBy: user.uid };
      return persist(db, wordId, existing, { options, rev: bumpRev(existing.rev, prevAnswers, options) }, stamp, user.uid);
    }

    case "toggle-correct": {
      const wordId = reqWordId(body.wordId);
      const optId = reqOptId(body.optionId);
      const existing = await loadSet(db, wordId);
      if (!existing) throw new HttpError(404, "Set nicht gefunden");
      const options = Array.isArray(existing.options) ? existing.options.slice() : [];
      const idx = options.findIndex((o) => o && o.id === optId);
      if (idx < 0) throw new HttpError(404, "Option nicht gefunden");
      const makeCorrect = !options[idx].correct;
      if (makeCorrect && countWrong(options) - 1 < COLLOC.servedWrong) {
        throw new HttpError(400, `Es müssen mindestens ${COLLOC.servedWrong} falsche Optionen bleiben`);
      }
      if (!makeCorrect && countCorrect(options) <= 1) {
        throw new HttpError(400, "Mindestens eine richtige Option nötig");
      }
      const prevAnswers = answerNormsOf(options);
      options[idx] = { ...options[idx], correct: makeCorrect, updatedAt: Date.now(), updatedBy: user.uid };
      return persist(db, wordId, existing, { options, rev: bumpRev(existing.rev, prevAnswers, options) }, stamp, user.uid);
    }

    case "remove-option": {
      const wordId = reqWordId(body.wordId);
      const optId = reqOptId(body.optionId);
      const existing = await loadSet(db, wordId);
      if (!existing) throw new HttpError(404, "Set nicht gefunden");
      const options = Array.isArray(existing.options) ? existing.options : [];
      const next = options.filter((o) => o && o.id !== optId);
      if (next.length === options.length) throw new HttpError(404, "Option nicht gefunden");
      const prevAnswers = answerNormsOf(options);
      return persist(db, wordId, existing, { options: next, rev: bumpRev(existing.rev, prevAnswers, next) }, stamp, user.uid);
    }

    case "add-variant": {
      const baseWordId = reqWordId(body.baseWordId);
      const base = await loadSet(db, baseWordId);
      if (!base) throw new HttpError(404, "Set nicht gefunden");
      if (base.variant === true) throw new HttpError(400, "Duplikat kann nicht dupliziert werden");
      const variants = Array.isArray(base.variants) ? base.variants : [];
      if (variants.length >= COLLOC.maxVariants) throw new HttpError(400, `Höchstens ${COLLOC.maxVariants} Duplikate`);
      const word = await loadWord(db, baseWordId);
      const de = clip(word.de, COLLOC.deLen);
      if (!de) throw new HttpError(400, "Wort ohne de");
      const article = clip(word.article, COLLOC.articleLen);
      const partnerLabel = String(body.partnerLabel || "").trim();
      if (partnerLabel && !PARTNER_LABELS.includes(partnerLabel)) throw new HttpError(400, "Partner-Wortart ungültig");
      const cat = String(body.cat || "").trim();
      if (cat && !WORD_CATEGORIES.includes(cat)) throw new HttpError(400, "Wortart ungültig");

      const variantId = `cv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const options = copyOptions(base.options, { uid: user.uid });
      const childBase = {
        wordId: variantId, variant: true, baseWordId, optedIn: true,
        de, article, deRev: word.deRev || 0,
        cat: cat || base.cat || baseCategory(article).cat,
        partnerLabel: partnerLabel || null,
        options, rev: 0, gen: 0,
        updatedAt: stamp(), updatedBy: user.uid,
      };
      await setRef(db, variantId).set(childBase, { merge: true });
      const baseWrite = await persist(db, baseWordId, base, { variants: [...variants, variantId] }, stamp, user.uid);
      return { base: baseWrite.set, variant: teacherView(childBase) };
    }

    case "remove-variant": {
      const variantId = reqWordId(body.variantId);
      const variant = await loadSet(db, variantId);
      if (!variant || variant.variant !== true) throw new HttpError(404, "Duplikat nicht gefunden");
      const baseWordId = String(variant.baseWordId || "");
      await setRef(db, variantId).delete();
      let baseView = null;
      if (baseWordId) {
        const base = await loadSet(db, baseWordId);
        if (base) {
          const variants = (Array.isArray(base.variants) ? base.variants : []).filter((id) => id !== variantId);
          const baseWrite = await persist(db, baseWordId, base, { variants }, stamp, user.uid);
          baseView = baseWrite.set;
        }
      }
      return { base: baseView, removed: variantId };
    }

    case "purge-sets": {
      const wordId = reqWordId(body.wordId);
      const base = await loadSet(db, wordId);
      if (!base) return { deleted: 0 };
      const variants = Array.isArray(base.variants) ? base.variants : [];
      const ids = [wordId, ...variants];
      const batch = db.batch();
      for (const id of ids) batch.delete(setRef(db, id));
      await batch.commit();
      return { deleted: ids.length };
    }

    default:
      throw new HttpError(400, "Unknown action");
  }
}
