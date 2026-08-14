import { dbGet, dbSet } from "./db";
import { cacheHas, cacheGet, cacheSet } from "./cache";

export async function loadCollocationSet(wordId) {
  const d = await dbGet(`collocation_sets/${wordId}`);
  if (!d) return null;
  return {
    wordId,
    optedIn: d.optedIn === true,
    de: d.de || "",
    article: d.article || "",
    deRev: d.deRev || 0,
    gen: d.gen || 0,
    rev: d.rev || 0,
    cat: d.cat || null,
    partnerLabel: d.partnerLabel || null,
    options: (Array.isArray(d.options) ? d.options : []).map((o) => ({
      id: o.id, text: o.text, correct: o.correct === true, source: o.source || "manual",
    })),
  };
}

export async function loadCollocationProgress(uid) {
  const key = `collocProgress:${uid}`;
  if (cacheHas(key)) return cacheGet(key);
  const d = await dbGet(`users/${uid}/meta/collocationProgress`);
  const p = d?.data || {};
  cacheSet(key, p);
  return p;
}

export async function saveOneCollocationProgress(uid, wordId, val) {
  const key = `collocProgress:${uid}`;
  if (cacheHas(key)) cacheSet(key, { ...cacheGet(key), [wordId]: val });
  await dbSet(`users/${uid}/meta/collocationProgress`, { data: { [wordId]: val } });
}
