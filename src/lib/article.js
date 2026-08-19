import { MASTERY_LEVEL, nextReview } from "./srs.js";

export { MASTERY_LEVEL };

export const ARTICLE_OPTIONS = ["der", "die", "das"];

const GENUS_ARTICLE = { m: "der", f: "die", n: "das", 0: "die", "0": "die" };
const DEFINITE = new Set(["der", "die", "das"]);

export function resolveArticleAnswer(word) {
  // The /api/article payload flattens genus onto the card; a raw word doc
  // keeps it under pron. Accept either so both call sites resolve identically.
  const genus = word == null ? null
    : word.genus != null ? word.genus
      : word.pron ? word.pron.genus : null;
  const fromGenus = genus != null ? GENUS_ARTICLE[genus] : null;
  if (fromGenus) return { article: fromGenus, source: "wiktionary" };
  const teacher = String(word?.article ?? "").trim().toLowerCase();
  if (DEFINITE.has(teacher)) return { article: teacher, source: "teacher" };
  return null;
}

export function buildArticleCards(words) {
  const out = [];
  for (const w of words || []) {
    if (!w || !w.id) continue;
    const ans = resolveArticleAnswer(w);
    if (!ans) continue;
    out.push({
      id: w.id,
      de: w.de || "",
      folderId: w.folderId ?? null,
      deRev: w.deRev || 0,
      t: w.t || null,
      imageUrl: w.imageUrl || null,
      answer: ans.article,
      answerSource: ans.source,
    });
  }
  return out;
}

export function effArticleProgress(card, p) {
  if ((card?.deRev || 0) !== (p?.rev || 0)) return { level: 0, due: 0 };
  return p;
}

export function isArticleDue(card, p, now = Date.now()) {
  const eff = effArticleProgress(card, p);
  return !eff?.due || now >= eff.due;
}

export function answerArticle(card, p, correct) {
  const eff = effArticleProgress(card, p) || { level: 0 };
  const nx = nextReview(eff.level || 0, correct);
  const nm = Math.max(0, ((p?.nm) || 0) + (correct ? -1 : 1));
  return { ...nx, rev: card?.deRev || 0, nm };
}

export function shuffle(arr, rng = Math.random) {
  const a = (arr || []).slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function selectDueArticles(cards, progress, now = Date.now()) {
  const data = progress || {};
  let total = 0, learned = 0;
  const due = [];
  for (const c of cards || []) {
    if (!c || !c.id) continue;
    total++;
    const p = data[c.id];
    const eff = effArticleProgress(c, p);
    if ((eff?.level || 0) >= MASTERY_LEVEL) learned++;
    if (isArticleDue(c, p, now)) due.push(c);
  }
  return { due, total, dueCount: due.length, learned };
}

export function buildArticleDeck(cards, progress, rng = Math.random, now = Date.now()) {
  const { due } = selectDueArticles(cards, progress, now);
  return shuffle(due, rng);
}
