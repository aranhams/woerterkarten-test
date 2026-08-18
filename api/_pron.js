import crypto from "crypto";
import { deriveBetonung, syllabifyIpa } from "../shared/betonung.js";
import { PRON_V } from "../shared/pron.js";

export { PRON_V };

const DEFAULT_VOICE = "de-DE-SeraphinaMultilingualNeural";
const WIKTIONARY_TIMEOUT_MS = 6000;
const AZURE_TIMEOUT_MS = 10000;
const CLOUDINARY_TIMEOUT_MS = 15000;
const MAX_WIKITEXT_BYTES = 512 * 1024;
const MAX_AUDIO_BYTES = 512 * 1024;
const MAX_IPA_LEN = 60;
const MAX_HYPH_LEN = 120;

const LOOKUPABLE = /^[A-Za-zÄÖÜäöüßÉéÈèÊêÍíÓóÚúÑñÇç' .-]{1,60}$/;
const IPA_ALLOWED = /^[\p{L}\p{M}\s.‿]+$/u;
const VOICE_OK = /^[A-Za-z0-9:-]{1,64}$/;
const REGION_OK = /^[a-z0-9-]{1,32}$/;

const nfc = (s) => String(s ?? "").normalize("NFC").trim();
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

export const pronKey = (de) => sha256(nfc(de)).slice(0, 32);
export const audioKeyFor = (de, voice) => sha256(`${nfc(de)}|${voice}|${PRON_V}`).slice(0, 32);

export function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function voiceName(L) {
  const v = String(process.env.AZURE_SPEECH_VOICE || "").trim();
  if (!v) return DEFAULT_VOICE;
  if (VOICE_OK.test(v)) return v;
  L?.log("alert", "pron.voice_rejected", { configured: v.slice(0, 80), using: DEFAULT_VOICE });
  return DEFAULT_VOICE;
}

export function germanSection(wikitext) {
  const lines = String(wikitext ?? "").split("\n");
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (!/^==[^=]/.test(lines[i])) continue;
    if (start === -1) {
      if (/\{\{Sprache\|Deutsch\}\}/.test(lines[i])) start = i;
    } else {
      end = i;
      break;
    }
  }
  return start === -1 ? null : lines.slice(start, end).join("\n");
}

export function definitionBlock(section, template) {
  const re = new RegExp(`\\{\\{${template}\\}\\}[^\\n]*\\n((?::[^\\n]*(?:\\n|$))+)`);
  const m = section.match(re);
  return m ? m[1] : null;
}

export function extractHyphenation(section, word) {
  const block = definitionBlock(section, "Worttrennung");
  if (!block) return null;
  const line = block.split("\n")[0].replace(/^:/, "");
  const candidate = line.split(",")[0].replace(/\{\{[^}]*\}\}/g, "");
  const cleaned = [...candidate].filter((c) => /[\p{L}\p{M}·]/u.test(c)).join("");
  if (!cleaned || cleaned.length > MAX_HYPH_LEN) return null;
  if (cleaned.replace(/·/g, "").normalize("NFC").toLowerCase() !== nfc(word).toLowerCase()) return null;
  return cleaned.normalize("NFC");
}

export function extractIpaVariants(section) {
  const block = definitionBlock(section, "Aussprache");
  if (!block) return [];
  const line = block.split("\n").find((l) => /\{\{IPA\}\}/.test(l));
  if (!line) return [];
  return [...line.matchAll(/\{\{Lautschrift\|([^}|]*)\}\}/g)]
    .map((m) => m[1].trim())
    .filter((v) => v && v.length <= MAX_IPA_LEN && IPA_ALLOWED.test(v));
}

export const GENUS_ARTICLE = { m: "der", f: "die", n: "das", 0: "die" };

export function extractGenus(section) {
  const lines = String(section ?? "").split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^==+/.test(lines[i]) && /\{\{Wortart\|Substantiv\|Deutsch\}\}/.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return { genus: null, ambiguous: false, isNoun: false };

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^==+/.test(lines[i])) { end = i; break; }
  }
  const headline = lines[start];
  if (/\{\{(mf|mn|fn|nf|fm|nm)\}\}/.test(headline)) return { genus: null, ambiguous: true, isNoun: true };

  const tags = new Set([...headline.matchAll(/\{\{([mfn])\}\}/g)].map((m) => m[1]));
  const block = lines.slice(start, end).join("\n");
  for (const m of block.matchAll(/\|\s*Genus(?:\s*\d+)?\s*=\s*([mfn0])/g)) tags.add(m[1]);

  if (tags.size === 0) return { genus: null, ambiguous: false, isNoun: true };
  if (tags.size > 1) return { genus: null, ambiguous: true, isNoun: true };
  return { genus: [...tags][0], ambiguous: false, isNoun: true };
}

const MAX_COLLOC_PARTNER = 40;
const DEFAULT_COLLOC_MAX = 24;
const collNorm = (s) => nfc(s).toLowerCase();

const COLLOC_STOPWORDS = new Set([
  "der", "die", "das", "ein", "eine", "einen", "einem", "einer", "eines",
  "und", "oder", "aber", "nicht", "kein", "keine", "sich", "es", "man",
  "in", "an", "auf", "aus", "bei", "mit", "nach", "von", "vor", "zu", "zum", "zur",
  "wieder", "sehr", "auch", "noch", "schon", "so", "wie", "als", "etwas", "jemand",
]);

export function extractCollocations(wikitext, { word = "", max = DEFAULT_COLLOC_MAX } = {}) {
  const section = germanSection(wikitext);
  if (!section) return [];
  const block = definitionBlock(section, "Charakteristische Wortkombinationen");
  if (!block) return [];
  const skip = collNorm(word);
  const seen = new Set();
  const out = [];
  for (const m of block.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    const partner = (m[1] || "").split("#")[0].trim();
    const norm = collNorm(partner);
    if (!partner || !norm || partner.length > MAX_COLLOC_PARTNER) continue;
    if (norm === skip || seen.has(norm) || COLLOC_STOPWORDS.has(norm)) continue;
    seen.add(norm);
    out.push(partner);
    if (out.length >= max) break;
  }
  return out;
}

const stressIndexOf = (ipa) => syllabifyIpa(ipa).findIndex((n) => n.stressed);

export function parseWiktionary(wikitext, word) {
  const section = germanSection(wikitext);
  if (!section) return null;

  const variants = extractIpaVariants(section);
  if (!variants.length) return null;

  const first = stressIndexOf(variants[0]);
  const ambiguous = variants.some((v) => {
    const at = stressIndexOf(v);
    return at >= 0 && first >= 0 && at !== first;
  });
  if (ambiguous) return { ambiguous: true, hyph: null, ipa: null, bet: null };

  const hyph = extractHyphenation(section, word);
  const ipa = variants[0];
  const derived = hyph ? deriveBetonung({ de: nfc(word), hyph, ipa }) : null;
  return { ambiguous: false, hyph, ipa, bet: derived ? derived.bet : null };
}

async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function isLookupable(de) {
  return LOOKUPABLE.test(nfc(de));
}

export async function fetchWiktionaryWikitext(de) {
  const word = nfc(de);
  if (!LOOKUPABLE.test(word)) return { status: "charset" };
  const url =
    "https://de.wiktionary.org/w/api.php?action=parse&prop=wikitext&format=json&formatversion=2&redirects=1&page=" +
    encodeURIComponent(word);
  const contact = String(process.env.APP_ORIGIN || "").split(",")[0].trim() || "https://woerterkarten.app";

  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": `Woerterkarten/1.0 (+${contact})`, Accept: "application/json" },
  }, WIKTIONARY_TIMEOUT_MS);

  if (!res.ok) return { status: "http", httpStatus: res.status };
  const body = (await res.text()).slice(0, MAX_WIKITEXT_BYTES);
  let data;
  try { data = JSON.parse(body); } catch { return { status: "no_wikitext" }; }
  const wikitext = data?.parse?.wikitext;
  if (typeof wikitext !== "string") return { status: "no_wikitext" };
  return { status: "ok", wikitext, revid: Number.isInteger(data?.parse?.revid) ? data.parse.revid : null };
}

async function lookupWiktionary(de, L) {
  const word = nfc(de);
  const fetched = await fetchWiktionaryWikitext(word);
  if (fetched.status === "charset") {
    L.log("info", "pron.wiktionary_skipped", { reason: "charset" });
    return null;
  }
  if (fetched.status === "http") {
    L.log("info", "pron.wiktionary_miss", { status: fetched.httpStatus });
    return null;
  }
  if (fetched.status !== "ok") {
    L.log("info", "pron.wiktionary_miss", { reason: "no_wikitext" });
    return null;
  }
  const { wikitext, revid } = fetched;

  const section = germanSection(wikitext);
  const g = section ? extractGenus(section) : { genus: null };
  const genus = g.genus;

  const parsed = parseWiktionary(wikitext, word);
  if (!parsed) {
    L.log("info", "pron.wiktionary_miss", { reason: "no_german_ipa" });
    return { hyph: null, ipa: null, bet: null, genus, revid };
  }
  if (parsed.ambiguous) {
    L.log("info", "pron.homograph_skip", { word });
    return { hyph: null, ipa: null, bet: null, genus, revid };
  }
  if (parsed.hyph && !parsed.bet) L.log("info", "pron.derive_abort", { word });
  return { hyph: parsed.hyph, ipa: parsed.ipa, bet: parsed.bet, genus, revid };
}

export function buildSsml(de, voice) {
  const name = VOICE_OK.test(voice) ? voice : DEFAULT_VOICE;
  const parts = name.split("-");
  const locale = parts.length >= 3 ? `${parts[0]}-${parts[1]}` : "de-DE";
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">` +
    `<voice name="${xmlEscape(name)}"><lang xml:lang="${locale}">${xmlEscape(nfc(de))}</lang></voice></speak>`
  );
}

async function synthesize(de, voice, L) {
  const region = String(process.env.AZURE_SPEECH_REGION || "").trim();
  const key = process.env.AZURE_SPEECH_KEY;
  if (!key || !REGION_OK.test(region)) {
    L.log("error", "pron.azure_misconfigured", {});
    return null;
  }

  const ssml = buildSsml(de, voice);

  const res = await fetchWithTimeout(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "Woerterkarten",
    },
    body: ssml,
  }, AZURE_TIMEOUT_MS);

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    L.log("error", "pron.azure_error", { status: res.status, body: detail.slice(0, 200) });
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_AUDIO_BYTES) {
    L.log("error", "pron.azure_bad_payload", { bytes: buf.length });
    return null;
  }
  return buf;
}

async function uploadAudio(buffer, audioKey, L) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const secret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !secret) {
    L.log("error", "pron.cloudinary_misconfigured", {});
    return null;
  }

  const params = {
    folder: "woerterkarten/pron",
    invalidate: "true",
    overwrite: "true",
    public_id: audioKey,
    timestamp: String(Math.round(Date.now() / 1000)),
  };
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  const signature = crypto.createHash("sha1").update(toSign + secret).digest("hex");

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "audio/mpeg" }), `${audioKey}.mp3`);
  for (const [k, v] of Object.entries(params)) form.append(k, v);
  form.append("api_key", apiKey);
  form.append("signature", signature);

  const res = await fetchWithTimeout(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/video/upload`,
    { method: "POST", body: form },
    CLOUDINARY_TIMEOUT_MS,
  );
  const data = await res.json().catch(() => ({}));
  const url = String(data.secure_url || "");
  const prefix = `https://res.cloudinary.com/${cloudName}/video/upload/`;
  if (!res.ok || !url.startsWith(prefix)) {
    L.log("error", "pron.cloudinary_error", { status: res.status, err: data?.error?.message?.slice(0, 200) });
    return null;
  }
  return url;
}

async function ensureAudio(cached, audioKey, de, voice, L) {
  if (cached && cached.audioKey === audioKey && cached.url) {
    L.log("info", "pron.audio_reused", { audioKey });
    return cached.url;
  }
  const buffer = await synthesize(de, voice, L);
  if (!buffer) return null;
  return uploadAudio(buffer, audioKey, L);
}

function toPronMap(entry) {
  return {
    st: entry.url ? "ready" : "error",
    de: entry.de,
    hyph: entry.hyph ?? null,
    ipa: entry.ipa ?? null,
    bet: entry.bet ?? null,
    genus: entry.genus ?? null,
    url: entry.url ?? null,
    src: entry.src ?? "none",
    v: PRON_V,
  };
}

export async function ensurePron(db, de, L) {
  const word = nfc(de);
  const ref = db.doc(`pron_lex/${pronKey(word)}`);
  const snap = await ref.get().catch(() => null);
  const cached = snap && snap.exists ? snap.data() : null;

  if (cached && cached.v === PRON_V && cached.url && cached.src && cached.gc) {
    L.log("info", "pron.cache_hit", {});
    return { pron: toPronMap({ ...cached, de: word }), external: false };
  }

  const voice = voiceName(L);
  const audioKey = audioKeyFor(word, voice);
  const skipWiki = !!(cached && cached.v === PRON_V && cached.src && cached.gc);
  const reusesAudio = !!(cached && cached.audioKey === audioKey && cached.url);

  const [wikiRes, audioRes] = await Promise.allSettled([
    skipWiki ? Promise.resolve(null) : lookupWiktionary(word, L),
    ensureAudio(cached, audioKey, word, voice, L),
  ]);

  if (wikiRes.status === "rejected") L.log("error", "pron.wiktionary_failed", { err: wikiRes.reason?.message });
  if (audioRes.status === "rejected") L.log("error", "pron.audio_failed", { err: audioRes.reason?.message });

  const wiki = wikiRes.status === "fulfilled" ? wikiRes.value : null;
  const url = (audioRes.status === "fulfilled" ? audioRes.value : null) || (reusesAudio ? cached.url : null);

  const entry = skipWiki
    ? { ...cached, de: word, url, audioKey, v: PRON_V, updatedAt: new Date() }
    : {
        de: word,
        hyph: wiki?.hyph ?? null,
        ipa: wiki?.ipa ?? null,
        bet: wiki?.bet ?? null,
        genus: wiki?.genus ?? null,
        gc: true,
        src: wiki?.hyph ? "wiktionary" : "none",
        wikiRev: wiki?.revid ?? null,
        url,
        audioKey,
        v: PRON_V,
        updatedAt: new Date(),
      };

  await ref.set(entry, { merge: true }).catch((e) => L.log("error", "pron.lex_write_failed", { err: e?.message }));

  return { pron: toPronMap(entry), external: !skipWiki || !reusesAudio };
}
