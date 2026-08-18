import crypto from "crypto";
import { FieldValue } from "firebase-admin/firestore";

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CHUNK = 30;
const BATCH = 450;

export function makeCode(len = 10) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] & 31];
  return out;
}

export async function genUniqueJoinCode(db, len = 10) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = makeCode(len);
    const snap = await db.collection("classes").where("joinCode", "==", code).limit(1).get();
    if (snap.empty) return code;
  }
  throw new Error("could not generate a unique join code");
}

function unionInto(set, arr) { for (const x of (arr || [])) set.add(x); }

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  for (const x of b) if (!s.has(x)) return false;
  return true;
}

const lowerKey = (s) => String(s ?? "").trim().toLowerCase();

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function commitAll(db, pending) {
  for (const slice of chunks(pending, BATCH)) {
    const batch = db.batch();
    for (const p of slice) batch.set(p.ref, p.patch, { merge: true });
    await batch.commit();
  }
}

function membershipMaps(classes) {
  const folderMembers = new Map();
  const looseWordMembers = new Map();
  for (const c of classes) {
    const roster = Array.isArray(c.memberUids) ? c.memberUids : [];
    const rosterSet = new Set(roster);
    for (const e of (c.folders || [])) {
      if (!e || !e.folderId) continue;
      let set = folderMembers.get(e.folderId);
      if (!set) { set = new Set(); folderMembers.set(e.folderId, set); }
      if (e.audience === "selected") {
        for (const u of (e.uids || [])) if (rosterSet.has(u)) set.add(u);
      } else {
        unionInto(set, roster);
      }
    }
    for (const wid of (c.wordIds || [])) {
      let set = looseWordMembers.get(wid);
      if (!set) { set = new Set(); looseWordMembers.set(wid, set); }
      unionInto(set, roster);
    }
  }
  return { folderMembers, looseWordMembers };
}

async function readScopedWords(db, scope) {
  const seen = new Map();
  const folderIds = [...new Set(scope.folderIds || [])].filter(Boolean);
  for (const slice of chunks(folderIds, CHUNK)) {
    const snap = await db.collection("global_words").where("folderId", "in", slice).get();
    for (const d of snap.docs) seen.set(d.id, d);
  }
  const looseIds = [...new Set(scope.wordIds || [])].filter((id) => id && !seen.has(id));
  for (const slice of chunks(looseIds, CHUNK)) {
    const snaps = await db.getAll(...slice.map((id) => db.doc(`global_words/${id}`)));
    for (const s of snaps) if (s.exists) seen.set(s.id, s);
  }
  return [...seen.values()];
}

async function readScopedFolders(db, folderIds) {
  const ids = [...new Set(folderIds || [])].filter(Boolean);
  const out = [];
  for (const slice of chunks(ids, CHUNK)) {
    const snaps = await db.getAll(...slice.map((id) => db.doc(`global_folders/${id}`)));
    for (const s of snaps) if (s.exists) out.push(s);
  }
  return out;
}

async function editManifests(db, uids, mutate) {
  const list = [...new Set(uids || [])].filter(Boolean);
  let written = 0;
  for (const slice of chunks(list, CHUNK)) {
    const snaps = await db.getAll(...slice.map((u) => db.doc(`users/${u}/meta/assigned`)));
    const pending = [];
    for (const snap of snaps) {
      if (!snap.exists || !Array.isArray(snap.data().words)) continue;
      const uid = snap.ref.parent.parent.id;
      const next = mutate(snap.data().words, uid);
      if (!next) continue;
      pending.push({
        ref: snap.ref,
        patch: { v: 1, gen: (snap.data().gen || 0) + 1, updatedAt: FieldValue.serverTimestamp(), words: next },
      });
    }
    await commitAll(db, pending);
    written += pending.length;
  }
  return written;
}

function noteDiff(diffs, uid, kind, wordId, entry) {
  let d = diffs.get(uid);
  if (!d) { d = { added: new Map(), removed: new Set() }; diffs.set(uid, d); }
  if (kind === "add") { d.removed.delete(wordId); d.added.set(wordId, entry); }
  else { d.added.delete(wordId); d.removed.add(wordId); }
}

function applyDiffs(db, diffs) {
  return editManifests(db, [...diffs.keys()], (words, uid) => {
    const diff = diffs.get(uid);
    const byId = new Map(words.map((e) => [e.i, e]));
    let changed = false;
    for (const id of diff.removed) if (byId.delete(id)) changed = true;
    for (const [id, entry] of diff.added) {
      const prev = byId.get(id);
      if (!prev || prev.f !== entry.f || prev.r !== entry.r) { byId.set(id, entry); changed = true; }
    }
    return changed ? [...byId.values()] : null;
  });
}

const entryFor = (id, w) => ({ i: id, f: w.folderId ?? null, r: w.deRev || 0 });

export async function syncWordManifests(db, wordIds, prevMemberUids = []) {
  const ids = [...new Set(wordIds || [])].filter(Boolean);
  if (!ids.length) return 0;

  const diffs = new Map();
  for (const slice of chunks(ids, CHUNK)) {
    const snaps = await db.getAll(...slice.map((id) => db.doc(`global_words/${id}`)));
    for (const s of snaps) {
      const now = s.exists ? (Array.isArray(s.data().memberUids) ? s.data().memberUids : []) : [];
      const nowSet = new Set(now);
      if (s.exists) {
        const entry = entryFor(s.id, s.data());
        for (const u of now) noteDiff(diffs, u, "add", s.id, entry);
      }
      for (const u of prevMemberUids) if (!nowSet.has(u)) noteDiff(diffs, u, "remove", s.id);
    }
  }
  return applyDiffs(db, diffs);
}

export async function recomputeDenorm(db, scope = null) {
  const full = !scope;

  const classesSnap = await db.collection("classes").get();
  const { folderMembers, looseWordMembers } = membershipMaps(classesSnap.docs.map((d) => d.data()));

  const folderDocs = full
    ? (await db.collection("global_folders").get()).docs
    : await readScopedFolders(db, scope.folderIds);
  const wordDocs = full
    ? (await db.collection("global_words").get()).docs
    : await readScopedWords(db, scope);

  const pending = [];
  const diffs = new Map();

  for (const d of folderDocs) {
    const desired = folderMembers.has(d.id) ? [...folderMembers.get(d.id)] : [];
    if (!sameSet(d.data().memberUids || [], desired)) pending.push({ ref: d.ref, patch: { memberUids: desired } });
  }

  for (const d of wordDocs) {
    const w = d.data();
    const desired = w.folderId != null
      ? (folderMembers.has(w.folderId) ? [...folderMembers.get(w.folderId)] : [])
      : (looseWordMembers.has(d.id) ? [...looseWordMembers.get(d.id)] : []);
    const before = Array.isArray(w.memberUids) ? w.memberUids : [];
    const patch = {};

    if (!sameSet(before, desired)) {
      patch.memberUids = desired;
      const beforeSet = new Set(before);
      const afterSet = new Set(desired);
      const entry = entryFor(d.id, w);
      for (const u of desired) if (!beforeSet.has(u)) noteDiff(diffs, u, "add", d.id, entry);
      for (const u of before) if (!afterSet.has(u)) noteDiff(diffs, u, "remove", d.id);
    }

    if (full) {
      const deL = lowerKey(w.de);
      const ruL = lowerKey(w.ru);
      if (w.deL !== deL) patch.deL = deL;
      if (w.ruL !== ruL) patch.ruL = ruL;
    }

    if (Object.keys(patch).length) pending.push({ ref: d.ref, patch });
  }

  await commitAll(db, pending);
  const manifests = await applyDiffs(db, diffs);

  return { updated: pending.length, manifests };
}

export function dropFromManifests(db, wordId, uids) {
  return editManifests(db, uids, (words) => {
    const next = words.filter((e) => !e || e.i !== wordId);
    return next.length === words.length ? null : next;
  });
}
