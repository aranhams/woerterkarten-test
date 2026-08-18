import { collection, query, where, increment, serverTimestamp } from "firebase/firestore";
import { db } from "../lib/firebase";
import { lowerKey } from "../lib/word";
import { dbGet, dbSet } from "./db";
import { cachedGetAll, cachedQuery, cacheHas, cacheGet, cacheSet, cacheUpdate } from "./cache";

export const loadGlobalFolders = () => cachedGetAll("global_folders");
export const loadUserWords = (uid) => cachedGetAll(`users/${uid}/words`);
export const loadUserFolders = (uid) => cachedGetAll(`users/${uid}/folders`);
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

const ACTIVITY_FLUSH_EVERY = 10;
let pendingActivity = null;
let activityHooked = false;

function flushActivityNow() {
  const p = pendingActivity;
  pendingActivity = null;
  if (!p || p.r <= 0) return Promise.resolve();
  const payload = { days: { [p.dayKey]: { r: increment(p.r), c: increment(p.c) } } };
  if (Number.isFinite(p.masteryPct)) payload.weeks = { [p.weekKey]: p.masteryPct };
  return dbSet(`users/${p.uid}/meta/activity`, payload).catch(() => {});
}

function ensureActivityHook() {
  if (activityHooked || typeof document === "undefined") return;
  activityHooked = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushActivityNow();
  });
}

export function queueActivity(uid, knew, masteryPct) {
  ensureActivityHook();
  const now = Date.now();
  const dk = new Date(now).toISOString().slice(0, 10);
  if (pendingActivity && (pendingActivity.uid !== uid || pendingActivity.dayKey !== dk)) flushActivityNow();
  if (!pendingActivity) pendingActivity = { uid, dayKey: dk, weekKey: weekKey(now), r: 0, c: 0, masteryPct: undefined };
  pendingActivity.r += 1;
  pendingActivity.c += knew ? 1 : 0;
  if (Number.isFinite(masteryPct)) pendingActivity.masteryPct = masteryPct;
  if (pendingActivity.r >= ACTIVITY_FLUSH_EVERY) return flushActivityNow();
  return Promise.resolve();
}

export const flushActivity = () => flushActivityNow();

export async function healPersonalSearchFields(uid, words) {
  const todo = words.filter((w) => w.deL == null || w.deL !== lowerKey(w.de));
  for (const w of todo) {
    const patch = {
      deL: lowerKey(w.de), ruL: lowerKey(w.ru),
      updatedAt: serverTimestamp(), updatedBy: uid,
    };
    try {
      await dbSet(`users/${uid}/words/${w.id}`, patch);
      Object.assign(w, { ...patch, updatedAt: Date.now() });
      cacheUpdate(`users/${uid}/words`, w.id, { ...patch, updatedAt: Date.now() });
    } catch (err) { console.warn("[db] healPersonal", w.id, err); return false; }
  }
  return true;
}

export async function personalSearchFieldsReady(uid) {
  const key = `deLflag:${uid}`;
  if (cacheHas(key)) return cacheGet(key);
  const d = await dbGet(`users/${uid}/meta/deL`);
  const done = d?.done === true;
  cacheSet(key, done);
  return done;
}

export async function markPersonalSearchFieldsReady(uid) {
  cacheSet(`deLflag:${uid}`, true);
  try { await dbSet(`users/${uid}/meta/deL`, { done: true, at: Date.now() }); } catch (err) { console.warn("[db] markDeL", err); }
}

export const loadMyClasses = (uid) =>
  cachedQuery(`my_classes:${uid}`, () => query(collection(db, "classes"), where("memberUids", "array-contains", uid)));
export const loadClassFolders = (uid) =>
  cachedQuery(`class_folders:${uid}`, () => query(collection(db, "global_folders"), where("memberUids", "array-contains", uid)));

export async function loadVisibleFolders(session) {
  return session.isTeacher ? await loadGlobalFolders() : await loadClassFolders(session.uid);
}

export function cachePron(session, word, pron) {
  if (word.source !== "global") cacheUpdate(`users/${session.uid}/words`, word.id, { pron });
}
