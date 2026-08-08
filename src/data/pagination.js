import {
  collection, query, where, orderBy, limit, startAfter, startAt, endAt, getDocs, getCountFromServer,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { WORD_PAGE_SERVER } from "../lib/constants";
import { lowerKey } from "../lib/word";

const HIGH = "";

const baseRef = (source, uid) =>
  (source === "personal" ? collection(db, `users/${uid}/words`) : collection(db, "global_words"));

function scopeClauses(source, { uid, teacher, folderId, looseOnly }) {
  const cl = [];
  if (source === "global" && !teacher) cl.push(where("memberUids", "array-contains", uid));
  if (looseOnly) cl.push(where("folderId", "==", null));
  else if (folderId) cl.push(where("folderId", "==", folderId));
  return cl;
}

async function runPage(source, opts, cursor, pageSize, q) {
  const clauses = [...scopeClauses(source, opts), orderBy("deL")];
  if (cursor) clauses.push(startAfter(cursor));
  else if (q) clauses.push(startAt(q));
  if (q) clauses.push(endAt(q + HIGH));
  clauses.push(limit(pageSize));
  const snap = await getDocs(query(baseRef(source, opts.uid), ...clauses));
  const rows = snap.docs.map((d) => ({ id: d.id, source, ...d.data() }));
  return {
    rows,
    cursor: snap.docs.length ? snap.docs[snap.docs.length - 1] : null,
    done: snap.docs.length < pageSize,
  };
}

export function newPageState({
  uid, teacher = false, folderId = null, looseOnly = false,
  sources = ["global"], pageSize = WORD_PAGE_SERVER, q = "",
}) {
  return {
    uid, teacher, folderId, looseOnly, sources, pageSize, q: lowerKey(q),
    rows: [], buffers: {}, cursors: {}, done: {}, loaded: false, exhausted: false, error: null,
  };
}

function takeLowest(state) {
  let best = null;
  for (const s of state.sources) {
    const head = (state.buffers[s] || [])[0];
    if (!head) continue;
    if (!best || String(head.deL || "") < String((state.buffers[best] || [])[0].deL || "")) best = s;
  }
  return best ? state.buffers[best].shift() : null;
}

async function fill(state, source) {
  if (state.done[source] || (state.buffers[source] || []).length) return;
  const { rows, cursor, done } = await runPage(source, state, state.cursors[source], state.pageSize, state.q);
  state.buffers[source] = rows;
  state.cursors[source] = cursor;
  state.done[source] = done;
}

export async function loadNextPage(state) {
  const next = {
    ...state,
    buffers: { ...state.buffers }, cursors: { ...state.cursors }, done: { ...state.done },
    rows: [...state.rows], error: null,
  };
  const out = [];
  try {
    while (out.length < next.pageSize) {
      await Promise.all(next.sources.map((s) => fill(next, s)));
      const row = takeLowest(next);
      if (!row) { next.exhausted = true; break; }
      out.push(row);
    }
  } catch (err) {
    console.warn("[db] loadNextPage", err);
    return { ...next, loaded: true, exhausted: true, error: err };
  }
  next.rows = [...next.rows, ...out];
  next.loaded = true;
  if (!out.length) next.exhausted = true;
  return next;
}

export const searchState = (state, q) => newPageState({
  uid: state.uid, teacher: state.teacher, folderId: state.folderId,
  looseOnly: state.looseOnly, sources: state.sources, pageSize: state.pageSize, q,
});

export async function countWords({ source = "global", ...opts }) {
  try {
    const snap = await getCountFromServer(query(baseRef(source, opts.uid), ...scopeClauses(source, opts)));
    return snap.data().count;
  } catch (err) { console.warn("[db] countWords", err); return null; }
}
