import crypto from "crypto";

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

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

export async function recomputeDenorm(db) {
  const [classesSnap, foldersSnap, wordsSnap] = await Promise.all([
    db.collection("classes").get(),
    db.collection("global_folders").get(),
    db.collection("global_words").get(),
  ]);

  const classes = classesSnap.docs.map((d) => d.data());

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

  const pending = [];

  for (const d of foldersSnap.docs) {
    const desired = folderMembers.has(d.id) ? [...folderMembers.get(d.id)] : [];
    if (!sameSet(d.data().memberUids || [], desired)) pending.push({ ref: d.ref, memberUids: desired });
  }

  for (const d of wordsSnap.docs) {
    const w = d.data();
    const desired = w.folderId != null
      ? (folderMembers.has(w.folderId) ? [...folderMembers.get(w.folderId)] : [])
      : (looseWordMembers.has(d.id) ? [...looseWordMembers.get(d.id)] : []);
    if (!sameSet(w.memberUids || [], desired)) pending.push({ ref: d.ref, memberUids: desired });
  }

  for (let i = 0; i < pending.length; i += 450) {
    const batch = db.batch();
    for (const p of pending.slice(i, i + 450)) {
      batch.set(p.ref, { memberUids: p.memberUids }, { merge: true });
    }
    await batch.commit();
  }

  return { updated: pending.length };
}
