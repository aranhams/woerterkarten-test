export const LONG_MARK = "̲";
export const SHORT_MARK = "̣";

const PRIMARY_STRESS = "ˈ";
const SECONDARY_STRESS = "ˌ";
const LENGTH_MARK = "ː";
const NON_SYLLABIC = "̯";
const SYLLABIC_MARKS = "̩̍";
const HYPHEN_DOT = "·";

const IPA_VOWELS = "aɐɑeəɛiɪoɔøœuʊyʏæʌɒɜɨʉɘɵ";
const VOWEL_LETTERS = "aeiouäöüy";
const DIGRAPHS = ["ei", "ai", "au", "eu", "äu", "ie"];

const isMark = (ch) => /\p{Mn}/u.test(ch);

export function renderBetonung(word, { vokal, vorkommen, laenge }) {
  if (!vokal || !/^[a-zäöüyA-ZÄÖÜY]{1,2}$/.test(vokal)) return null;
  const mark = laenge === "kurz" ? SHORT_MARK : LONG_MARK;
  const lower = word.toLowerCase();
  const needle = vokal.toLowerCase();
  let at = -1;
  for (let n = 0; n < Math.max(1, vorkommen || 1); n++) {
    at = lower.indexOf(needle, at + 1);
    if (at === -1) return null;
  }
  return (
    word.slice(0, at) +
    [...word.slice(at, at + vokal.length)].map((c) => c + mark).join("") +
    word.slice(at + vokal.length)
  );
}

export function stripBetonung(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(new RegExp(`[${LONG_MARK}${SHORT_MARK}]`, "g"), "")
    .normalize("NFC");
}

export function syllabifyIpa(ipa) {
  const s = String(ipa ?? "").normalize("NFD");
  const nuclei = [];
  let pendingStress = false;
  let sawPrimary = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === PRIMARY_STRESS) { pendingStress = true; sawPrimary = true; continue; }
    if (ch === SECONDARY_STRESS) { pendingStress = false; continue; }

    if (SYLLABIC_MARKS.includes(ch)) {
      nuclei.push({ long: false, stressed: pendingStress });
      pendingStress = false;
      continue;
    }
    if (!IPA_VOWELS.includes(ch)) continue;

    let j = i + 1;
    let long = false;
    let glide = false;
    while (j < s.length && (s[j] === LENGTH_MARK || isMark(s[j]))) {
      if (s[j] === LENGTH_MARK) long = true;
      if (s[j] === NON_SYLLABIC) glide = true;
      j++;
    }
    if (glide) {
      if (nuclei.length) nuclei[nuclei.length - 1].long = true;
    } else {
      nuclei.push({ long, stressed: pendingStress });
      pendingStress = false;
    }
    i = j - 1;
  }

  if (!sawPrimary && nuclei.length === 1) nuclei[0].stressed = true;
  return nuclei;
}

function findVowelGroup(syllable) {
  const l = syllable.toLowerCase();
  for (let i = 0; i < l.length; i++) {
    if (DIGRAPHS.includes(l.slice(i, i + 2))) return { at: i, len: 2 };
    if (VOWEL_LETTERS.includes(l[i])) return { at: i, len: 1 };
  }
  return null;
}

function occurrenceOf(word, vokal, absolute) {
  const lower = word.toLowerCase();
  const needle = vokal.toLowerCase();
  let count = 0;
  let at = lower.indexOf(needle);
  while (at !== -1 && at < absolute) { count++; at = lower.indexOf(needle, at + 1); }
  return count + 1;
}

export function splitHyphenation(hyph) {
  return String(hyph ?? "")
    .normalize("NFC")
    .split(HYPHEN_DOT)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function deriveBetonung({ de, hyph, ipa }) {
  const word = String(de ?? "").normalize("NFC").trim();
  const parts = splitHyphenation(hyph);
  if (!word || !parts.length) return null;
  if (parts.join("").toLowerCase() !== word.toLowerCase()) return null;

  const nuclei = syllabifyIpa(ipa);
  if (nuclei.length !== parts.length) return null;

  const at = nuclei.findIndex((n) => n.stressed);
  if (at < 0) return null;

  const offset = parts.slice(0, at).reduce((n, p) => n + p.length, 0);
  const syllable = word.slice(offset, offset + parts[at].length);
  const group = findVowelGroup(syllable);
  if (!group) return null;

  const absolute = offset + group.at;
  const vokal = word.slice(absolute, absolute + group.len);
  const laenge = nuclei[at].long ? "lang" : "kurz";
  const vorkommen = occurrenceOf(word, vokal, absolute);

  const bet = renderBetonung(word, { vokal, vorkommen, laenge });
  if (!bet || stripBetonung(bet) !== word) return null;

  return { bet, vokal, vorkommen, laenge, syllable: at + 1, syllables: parts.length };
}
