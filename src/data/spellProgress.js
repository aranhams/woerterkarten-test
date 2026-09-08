import { dbGet, dbSet } from "./db";
import { cacheHas, cacheGet, cacheSet } from "./cache";

export async function loadSpellProgress(uid) {
  const key = `spellProgress:${uid}`;
  if (cacheHas(key)) return cacheGet(key);
  const d = await dbGet(`users/${uid}/meta/spellProgress`);
  const p = d?.data || {};
  cacheSet(key, p);
  return p;
}

export async function saveOneSpellProgress(uid, wordId, val) {
  const key = `spellProgress:${uid}`;
  if (cacheHas(key)) cacheSet(key, { ...cacheGet(key), [wordId]: val });
  await dbSet(`users/${uid}/meta/spellProgress`, { data: { [wordId]: val } });
}
