import { collection, query, where } from "firebase/firestore";
import { db } from "../lib/firebase";
import { dbGet, dbSet } from "./db";
import { cachedGetAll, cachedQuery, cacheHas, cacheGet, cacheSet } from "./cache";

export const loadGlobalWords = () => cachedGetAll("global_words");
export const loadGlobalFolders = () => cachedGetAll("global_folders");
export const loadUserWords = (uid) => cachedGetAll(`users/${uid}/words`);
export const loadUserFolders = (uid) => cachedGetAll(`users/${uid}/folders`);
export const loadLangTranslations = (lang) => cachedGetAll(`global_translations/${lang}/words`);
export const loadAllClasses = () => cachedGetAll("classes");

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
