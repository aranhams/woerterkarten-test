import { collection, query, where, increment } from "firebase/firestore";
import { db } from "../lib/firebase";
import { dbGet, dbSet } from "./db";
import { cachedGetAll, cachedQuery, cacheHas, cacheGet, cacheSet, cacheUpdate } from "./cache";

export const loadGlobalWords = () => cachedGetAll("global_words");
export const loadGlobalFolders = () => cachedGetAll("global_folders");
export const loadUserWords = (uid) => cachedGetAll(`users/${uid}/words`);
export const loadUserFolders = (uid) => cachedGetAll(`users/${uid}/folders`);
export const loadLangTranslations = (lang) => cachedGetAll(`global_translations/${lang}/words`);
const classCreatedMs = (c) => {
  const v = c.createdAt;
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.seconds === "number") return v.seconds * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
};
export const loadAllClasses = async () =>
  [...(await cachedGetAll("classes"))].sort((a, b) => classCreatedMs(b) - classCreatedMs(a));

export async function loadProgress(uid) {
  const key = `progress:${uid}`;
  if (cacheHas(key)) return cacheGet(key);
  const d = await dbGet(`users/${uid}/meta/progress`);
  const p = d?.data || {};
  cacheSet(key, p);
  return p;
}

export async function saveOneProgress(uid, wordId, val) {
  const key = `progress:${uid}`;
  if (cacheHas(key)) cacheSet(key, { ...cacheGet(key), [wordId]: val });
  await dbSet(`users/${uid}/meta/progress`, { data: { [wordId]: val } });
}

function weekKey(ms) {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10);
}

export function recordActivity(uid, knew, masteryPct) {
  const now = Date.now();
  const payload = { days: { [new Date(now).toISOString().slice(0, 10)]: { r: increment(1), c: increment(knew ? 1 : 0) } } };
  if (Number.isFinite(masteryPct)) payload.weeks = { [weekKey(now)]: masteryPct };
  return dbSet(`users/${uid}/meta/activity`, payload);
}

export const loadMyClasses = (uid) =>
  cachedQuery(`my_classes:${uid}`, () => query(collection(db, "classes"), where("memberUids", "array-contains", uid)));
export const loadClassFolders = (uid) =>
  cachedQuery(`class_folders:${uid}`, () => query(collection(db, "global_folders"), where("memberUids", "array-contains", uid)));
export const loadClassWords = (uid) =>
  cachedQuery(`class_words:${uid}`, () => query(collection(db, "global_words"), where("memberUids", "array-contains", uid)));

export async function loadVisibleWords(session) {
  return session.isTeacher ? await loadGlobalWords() : await loadClassWords(session.uid);
}
export async function loadVisibleFolders(session) {
  return session.isTeacher ? await loadGlobalFolders() : await loadClassFolders(session.uid);
}

// A class word sits under a different cache key for teachers than for students,
// because they load it through different queries.
export function wordCacheKey(session, word) {
  if (word.source !== "global") return `users/${session.uid}/words`;
  return session.isTeacher ? "global_words" : `class_words:${session.uid}`;
}

export function cachePron(session, word, pron) {
  cacheUpdate(wordCacheKey(session, word), word.id, { pron });
}
