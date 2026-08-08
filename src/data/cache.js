import { getDocs } from "firebase/firestore";
import { dbGetAll } from "./db";

const _cache = new Map();

export const cacheHas = (key) => _cache.has(key);
export const cacheGet = (key) => _cache.get(key);
export const cacheSet = (key, val) => _cache.set(key, val);

export async function cachedGetAll(col) {
  if (_cache.has(col)) return _cache.get(col);
  const rows = await dbGetAll(col);
  _cache.set(col, rows);
  return rows;
}

export function cachePush(col, row) { if (_cache.has(col)) _cache.set(col, [..._cache.get(col), row]); }
export function cacheRemove(col, id) { if (_cache.has(col)) _cache.set(col, _cache.get(col).filter((r) => r.id !== id)); }
export function cacheUpdate(col, id, patch) { if (_cache.has(col)) _cache.set(col, _cache.get(col).map((r) => (r.id === id ? { ...r, ...patch } : r))); }
export function clearDataCache() { _cache.clear(); }

export async function cachedQuery(key, buildRef) {
  if (_cache.has(key)) return _cache.get(key);
  try {
    const snap = await getDocs(buildRef());
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    _cache.set(key, rows);
    return rows;
  } catch (err) { console.warn("[db] cachedQuery", key, err); return []; }
}
