import { MASTERY_LEVEL, nextReview } from "./srs.js";

export { MASTERY_LEVEL };

export function effCollProgress(question, p) {
  if ((question?.rev || 0) !== (p?.rev || 0)) return { level: 0, due: 0 };
  return p;
}

export function isCollDue(question, p, now = Date.now()) {
  const eff = effCollProgress(question, p);
  return !eff?.due || now >= eff.due;
}

export function answerCollocation(question, p, correct) {
  const eff = effCollProgress(question, p) || { level: 0 };
  const nx = nextReview(eff.level || 0, correct);
  const nm = Math.max(0, ((p?.nm) || 0) + (correct ? -1 : 1));
  return { ...nx, rev: question?.rev || 0, nm };
}

export function shuffle(arr, rng = Math.random) {
  const a = (arr || []).slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function selectDueCollocations(questions, progress, now = Date.now()) {
  const data = progress || {};
  let total = 0, learned = 0;
  const due = [];
  for (const q of questions || []) {
    if (!q || !q.wordId) continue;
    total++;
    const p = data[q.wordId];
    const eff = effCollProgress(q, p);
    if ((eff?.level || 0) >= MASTERY_LEVEL) learned++;
    if (isCollDue(q, p, now)) due.push(q);
  }
  return { due, total, dueCount: due.length, learned };
}

export function buildDeck(questions, progress, rng = Math.random, now = Date.now()) {
  const { due } = selectDueCollocations(questions, progress, now);
  return shuffle(due, rng).map((q) => ({ ...q, shuffled: shuffle(q.options, rng) }));
}

export function reflexiveParts(de) {
  const s = String(de || "").trim();
  const m = s.match(/^sich\s+(.+)$/i);
  return { pron: "sich", verb: (m ? m[1] : s).trim() };
}

const SEPARABLE_PREFIXES = [
  "auseinander", "gegenüber", "entgegen", "zusammen", "voran", "voraus", "vorbei", "vorüber",
  "herunter", "hinunter", "herüber", "hinüber", "herauf", "hinauf", "heraus", "hinaus",
  "herein", "hinein", "zurück", "weiter", "hinweg", "empor",
  "ein", "auf", "aus", "ab", "an", "bei", "mit", "nach", "vor", "zu", "los", "fest",
  "fort", "her", "hin", "weg", "um", "durch", "über", "unter", "wieder", "statt", "frei",
];

export function separableParts(de) {
  const s = String(de || "").trim();
  const lower = s.toLowerCase();
  for (const p of SEPARABLE_PREFIXES) {
    if (lower.length > p.length && lower.startsWith(p)) {
      return { prefix: s.slice(0, p.length), stem: s.slice(p.length) };
    }
  }
  return { prefix: "", stem: s };
}

const ARTICLE_DECLENSION = {
  der: { akk: "den", dat: "dem" },
  die: { akk: "die", dat: "der" },
  das: { akk: "das", dat: "dem" },
  ein: { akk: "einen", dat: "einem" },
  eine: { akk: "eine", dat: "einer" },
};

export function declineStem(article, de, kasus) {
  const de_ = String(de || "").trim();
  const table = ARTICLE_DECLENSION[String(article || "").trim().toLowerCase()];
  const declined = table && table[kasus];
  return `${declined ? declined + " " : article ? article + " " : ""}${de_}`.trim();
}

export function fullPhrase(question, correctText, kasus = "none") {
  const stem = `${question?.article ? question.article + " " : ""}${question?.de || ""}`.trim();
  if (!correctText) return stem;

  const normStem = stem.toLowerCase().replace(/\s+/g, " ");
  const normText = correctText.toLowerCase().replace(/\s+/g, " ");
  if (normText.includes(normStem)) return correctText;

  if (question?.cat === "Reflexivverb") {
    const { pron, verb } = reflexiveParts(question?.de);
    return `${pron} ${correctText} ${verb}`.replace(/\s+/g, " ").trim();
  }

  if (question?.cat === "Trennbares Verb") {
    return `${correctText} ${stem}`.replace(/\s+/g, " ").trim();
  }

  const isAdj = question?.cat === "Adjektiv";
  if (question?.partnerLabel === "Nomen") {
    return isAdj ? `${correctText} ist ${stem}` : `${correctText} ${stem}`;
  }
  if (question?.partnerLabel === "Adjektiv") {
    return `${stem} ${question?.linkVerb || "ist"} ${correctText}`;
  }
  const nounPhrase = declineStem(question?.article, question?.de, kasus);
  return `${nounPhrase} ${correctText}`;
}
