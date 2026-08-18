import { dbGet, dbSet } from "./db";
import { cacheHas, cacheGet, cacheSet } from "./cache";

export async function loadArticleProgress(uid) {
  const key = `articleProgress:${uid}`;
  if (cacheHas(key)) return cacheGet(key);
  const d = await dbGet(`users/${uid}/meta/articleProgress`);
  const p = d?.data || {};
  cacheSet(key, p);
  return p;
}

export async function saveOneArticleProgress(uid, wordId, val) {
  const key = `articleProgress:${uid}`;
  if (cacheHas(key)) cacheSet(key, { ...cacheGet(key), [wordId]: val });
  await dbSet(`users/${uid}/meta/articleProgress`, { data: { [wordId]: val } });
}
