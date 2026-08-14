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

// Reflexive verbs ("sich"-Verben) are stored with or without the leading pronoun. Split them
// into the fixed pronoun and the verb so the partner (a prepositional phrase) can be slotted
// between them: "sich" [partner] [verb], e.g. "sich" "über das Geschenk" "freuen".
export function reflexiveParts(de) {
  const s = String(de || "").trim();
  const m = s.match(/^sich\s+(.+)$/i);
  return { pron: "sich", verb: (m ? m[1] : s).trim() };
}

// The productive detachable prefixes of German separable verbs, longest-first so "auseinander"
// wins over "aus" and "vorbei" over "vor". Used to mark the prefix on the card so learners see
// which part detaches in a main clause ("ruft den Arzt an").
const SEPARABLE_PREFIXES = [
  "auseinander", "gegenüber", "entgegen", "zusammen", "voran", "voraus", "vorbei", "vorüber",
  "herunter", "hinunter", "herüber", "hinüber", "herauf", "hinauf", "heraus", "hinaus",
  "herein", "hinein", "zurück", "weiter", "hinweg", "empor",
  "ein", "auf", "aus", "ab", "an", "bei", "mit", "nach", "vor", "zu", "los", "fest",
  "fort", "her", "hin", "weg", "um", "durch", "über", "unter", "wieder", "statt", "frei",
];

// Splits a separable verb into its detachable prefix and stem, e.g. "anrufen" -> { prefix: "an",
// stem: "rufen" }. Only splits when a known prefix leaves a non-empty stem; otherwise the whole
// word is the stem with no prefix, so callers can render it unchanged.
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

export function fullPhrase(question, correctText) {
  const stem = `${question?.article ? question.article + " " : ""}${question?.de || ""}`.trim();
  if (!correctText) return stem;

  // Legacy / robustness: if the option already contains the target word, return it unchanged.
  const normStem = stem.toLowerCase().replace(/\s+/g, " ");
  const normText = correctText.toLowerCase().replace(/\s+/g, " ");
  if (normText.includes(normStem)) return correctText;

  if (question?.cat === "Reflexivverb") {
    // Fixed reflexive frame: "sich" [partner] [verb], e.g. "sich über das Geschenk freuen".
    const { pron, verb } = reflexiveParts(question?.de);
    return `${pron} ${correctText} ${verb}`.replace(/\s+/g, " ").trim();
  }

  if (question?.cat === "Trennbares Verb") {
    // Separable verb: stem [partner] prefix, e.g. "rufen den Arzt an".
    const { prefix, stem } = separableParts(question?.de);
    return `${stem} ${correctText} ${prefix}`.replace(/\s+/g, " ").trim();
  }

  const isAdj = question?.cat === "Adjektiv";
  if (question?.partnerLabel === "Nomen") {
    // Blank is before the word: [partner] [word]
    // Adjectives need a copula to form a grammatical sentence.
    return isAdj ? `${correctText} ist ${stem}` : `${correctText} ${stem}`;
  }
  // Blank is after the word: [word] [partner]
  return `${stem} ${correctText}`;
}
