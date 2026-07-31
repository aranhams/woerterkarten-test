import { verifyBearer, applyCors, getAuth, getDb } from "./_firebase.js";
import { checkLock, registerFailure, clientIp } from "./_ratelimit.js";
import { requestLogger } from "./_log.js";
import { FieldValue } from "firebase-admin/firestore";
import { recomputeDenorm, genUniqueJoinCode, makeCode } from "./_classes.js";
import { resolveUid } from "./_users.js";
import { LANG_CODES } from "./_langs.js";

const MAX_FAILS = 40;
const WINDOW_MS = 15 * 60_000;

const TEACHER_ACTIONS = new Set([
  "create", "rename", "delete", "regen-code",
  "list-students", "add-student", "remove-student", "reset-student-password",
  "set-folders", "set-folder-audience", "release-folder", "set-words",
  "sync", "cleanup", "word-updated",
]);
const ADMIN_ACTIONS = new Set(["reset-student-password"]);
const ALL_ACTIONS = new Set([...TEACHER_ACTIONS, "join"]);

const clip = (s, n) => String(s ?? "").trim().slice(0, n);

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

export default async function handler(req, res) {
  const L = requestLogger("class-sync", req);
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await verifyBearer(req);
  if (!user) {
    L.done("warn", "class.unauthorized", 401);
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body || {};
  const action = String(body.action || "");
  if (!ALL_ACTIONS.has(action)) {
    L.done("warn", "class.bad_action", 400, { uid: user.uid, action });
    return res.status(400).json({ error: "Unknown action" });
  }
  const isTeacher = user.teacher === true || user.admin === true;
  if (ADMIN_ACTIONS.has(action) && user.admin !== true) {
    L.done("warn", "class.forbidden_admin", 403, { uid: user.uid, action });
    return res.status(403).json({ error: "Forbidden" });
  }
  if (TEACHER_ACTIONS.has(action) && !isTeacher) {
    L.done("warn", "class.forbidden", 403, { uid: user.uid, action });
    return res.status(403).json({ error: "Forbidden" });
  }

  const keys = [`class-sync:ip:${clientIp(req)}`, `class-sync:uid:${user.uid}`];
  const lock = await checkLock(keys, { max: MAX_FAILS, windowMs: WINDOW_MS });
  if (lock.blocked) {
    L.done("alert", "class.lockout", 429, { uid: user.uid, action, retryAfterSec: lock.retryAfterSec });
    res.setHeader("Retry-After", String(lock.retryAfterSec));
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }

  const db = getDb();
  const auth = getAuth();
  try {
    const result = await dispatch({ db, auth, user, action, body });
    L.done("info", `class.${action}`, 200, { uid: user.uid });
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 403 || (status === 404 && action === "join")) {
      await registerFailure(keys, { windowMs: WINDOW_MS });
    }
    L.done(status >= 500 ? "error" : "warn", `class.${action}.fail`, status, { uid: user.uid, err: e.message });
    return res.status(status).json({ error: status >= 500 ? "Server error" : e.message });
  }
}

async function dispatch({ db, auth, user, action, body }) {
  const classes = db.collection("classes");
  const stamp = () => FieldValue.serverTimestamp();

  async function loadClass(classId) {
    const id = String(classId || "");
    if (!id) throw new HttpError(400, "classId fehlt");
    const snap = await classes.doc(id).get();
    if (!snap.exists) throw new HttpError(404, "Kurs nicht gefunden");
    return { ref: snap.ref, id, data: snap.data() };
  }

  async function readUsername(uid) {
    try {
      const s = await db.collection("users").doc(uid).get();
      return s.exists ? (s.data().username || null) : null;
    } catch { return null; }
  }

  switch (action) {
    case "create": {
      const name = clip(body.name, 60);
      if (!name) throw new HttpError(400, "Name fehlt");
      const ref = classes.doc();
      const joinCode = await genUniqueJoinCode(db);
      await ref.set({
        name, icon: clip(body.icon, 8) || "📚", createdBy: user.uid, joinCode,
        memberUids: [], folders: [], wordIds: [],
        createdAt: stamp(), updatedAt: stamp(),
      });
      return { classId: ref.id, joinCode };
    }

    case "rename": {
      const { ref } = await loadClass(body.classId);
      const name = clip(body.name, 60);
      if (!name) throw new HttpError(400, "Name fehlt");
      await ref.set({ name, icon: clip(body.icon, 8) || "📚", updatedAt: stamp() }, { merge: true });
      return {};
    }

    case "delete": {
      const { ref } = await loadClass(body.classId);
      await ref.delete();
      const { updated } = await recomputeDenorm(db);
      return { stamped: updated };
    }

    case "regen-code": {
      const { ref } = await loadClass(body.classId);
      const joinCode = await genUniqueJoinCode(db);
      await ref.set({ joinCode, updatedAt: stamp() }, { merge: true });
      return { joinCode };
    }

    case "list-students": {
      const students = await listAllStudents(db, auth);
      return { students };
    }

    case "add-student": {
      const { ref, data } = await loadClass(body.classId);
      const uid = body.uid ? String(body.uid) : await resolveUid(auth, body.username);
      if (!uid) throw new HttpError(404, "Schüler nicht gefunden");
      const members = new Set(data.memberUids || []);
      members.add(uid);
      const name = (await readUsername(uid)) || clip(body.username, 32) || uid;
      await ref.set({
        memberUids: [...members],
        memberNames: FieldValue.delete(),
        updatedAt: stamp(),
      }, { merge: true });
      await recomputeDenorm(db);
      return { uid, name };
    }

    case "remove-student": {
      const { ref, data } = await loadClass(body.classId);
      const uid = String(body.uid || "");
      if (!uid) throw new HttpError(400, "uid fehlt");
      const members = (data.memberUids || []).filter((u) => u !== uid);
      const folders = (data.folders || []).map((e) =>
        e && e.audience === "selected"
          ? { ...e, uids: (e.uids || []).filter((u) => u !== uid) }
          : e
      );
      await ref.set({
        memberUids: members,
        memberNames: FieldValue.delete(),
        folders,
        updatedAt: stamp(),
      }, { merge: true });
      await recomputeDenorm(db);
      return {};
    }

    case "reset-student-password": {
      const uid = String(body.uid || "");
      if (!uid) throw new HttpError(400, "uid fehlt");
      const target = await auth.getUser(uid).catch(() => null);
      if (!target) throw new HttpError(404, "Schüler nicht gefunden");
      const targetClaims = target.customClaims || {};
      if (targetClaims.teacher === true || targetClaims.admin === true) throw new HttpError(403, "Nicht erlaubt");
      const password = makeCode(10);
      await auth.updateUser(uid, { password });
      return { password };
    }

    case "set-folders": {
      const { ref, data } = await loadClass(body.classId);
      const folders = normalizeFolders(body.folders, new Set(data.memberUids || []));
      await ref.set({ folders, updatedAt: stamp() }, { merge: true });
      await recomputeDenorm(db);
      return {};
    }

    case "set-folder-audience": {
      const { ref, data } = await loadClass(body.classId);
      const folderId = String(body.folderId || "");
      if (!folderId) throw new HttpError(400, "folderId fehlt");
      const roster = new Set(data.memberUids || []);
      const audience = body.audience === "selected" ? "selected" : "all";
      const entry = audience === "selected"
        ? { folderId, audience, uids: (Array.isArray(body.uids) ? body.uids : []).map(String).filter((u) => roster.has(u)) }
        : { folderId, audience: "all" };
      const folders = [...(data.folders || [])];
      const i = folders.findIndex((e) => e && e.folderId === folderId);
      if (i >= 0) folders[i] = entry; else folders.push(entry);
      await ref.set({ folders, updatedAt: stamp() }, { merge: true });
      await recomputeDenorm(db);
      return {};
    }

    case "release-folder": {
      const { ref, data } = await loadClass(body.classId);
      const folderId = String(body.folderId || "");
      if (!folderId) throw new HttpError(400, "folderId fehlt");
      const folders = (data.folders || []).map((e) =>
        e && e.folderId === folderId ? { folderId, audience: "all" } : e
      );
      await ref.set({ folders, updatedAt: stamp() }, { merge: true });
      await recomputeDenorm(db);
      return {};
    }

    case "set-words": {
      const { ref } = await loadClass(body.classId);
      const wordIds = Array.isArray(body.wordIds)
        ? [...new Set(body.wordIds.map(String))].slice(0, 5000)
        : [];
      await ref.set({ wordIds, updatedAt: stamp() }, { merge: true });
      await recomputeDenorm(db);
      return {};
    }

    case "cleanup": {
      const folderId = body.folderId ? String(body.folderId) : null;
      const wordId = body.wordId ? String(body.wordId) : null;
      if (!folderId && !wordId) throw new HttpError(400, "folderId oder wordId nötig");
      const snap = await classes.get();
      const batch = db.batch();
      let touched = 0;
      for (const d of snap.docs) {
        const data = d.data();
        const upd = {};
        let changed = false;
        if (folderId) {
          const nf = (data.folders || []).filter((e) => e && e.folderId !== folderId);
          if (nf.length !== (data.folders || []).length) { upd.folders = nf; changed = true; }
        }
        if (wordId) {
          const nw = (data.wordIds || []).filter((w) => w !== wordId);
          if (nw.length !== (data.wordIds || []).length) { upd.wordIds = nw; changed = true; }
        }
        if (changed) { upd.updatedAt = stamp(); batch.set(d.ref, upd, { merge: true }); touched++; }
      }
      if (touched) await batch.commit();
      const { updated } = await recomputeDenorm(db);
      return { touched, stamped: updated };
    }

    case "word-updated": {
      const wordId = String(body.wordId || "");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(wordId)) throw new HttpError(400, "wordId ungültig");
      const batch = db.batch();
      for (const lang of LANG_CODES) batch.delete(db.doc(`global_translations/${lang}/words/${wordId}`));
      await batch.commit();
      return { invalidated: LANG_CODES.length };
    }

    case "sync": {
      const purged = await purgeMemberNames(db);
      const { updated } = await recomputeDenorm(db);
      return { stamped: updated, purged };
    }

    case "join": {
      const code = clip(body.code, 32).toUpperCase();
      if (!code) throw new HttpError(400, "Code fehlt");
      const snap = await classes.where("joinCode", "==", code).limit(1).get();
      if (snap.empty) throw new HttpError(404, "Ungültiger Code");
      const ref = snap.docs[0].ref;
      const data = snap.docs[0].data();
      const members = new Set(data.memberUids || []);
      members.add(user.uid);
      await ref.set({
        memberUids: [...members],
        memberNames: FieldValue.delete(),
        updatedAt: stamp(),
      }, { merge: true });
      await recomputeDenorm(db);
      return { classId: snap.docs[0].id, name: data.name };
    }

    default:
      throw new HttpError(400, "Unknown action");
  }
}

async function listAllStudents(db, auth) {
  const teacherUids = new Set();
  let pageToken;
  do {
    const res = await auth.listUsers(1000, pageToken);
    for (const u of res.users) {
      if (u.customClaims && u.customClaims.teacher === true) teacherUids.add(u.uid);
    }
    pageToken = res.pageToken;
  } while (pageToken);

  const snap = await db.collection("users").get();
  const students = [];
  for (const d of snap.docs) {
    if (teacherUids.has(d.id)) continue;
    students.push({ uid: d.id, username: d.data().username || d.id.slice(0, 6) });
  }
  students.sort((a, b) => a.username.localeCompare(b.username));
  return students;
}

async function purgeMemberNames(db) {
  const snap = await db.collection("classes").get();
  const batch = db.batch();
  let n = 0;
  for (const d of snap.docs) {
    if (d.data().memberNames !== undefined) {
      batch.update(d.ref, { memberNames: FieldValue.delete() });
      n++;
    }
  }
  if (n) await batch.commit();
  return n;
}

function normalizeFolders(input, rosterSet) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const e of input) {
    if (!e || !e.folderId) continue;
    const folderId = String(e.folderId);
    if (seen.has(folderId)) continue;
    seen.add(folderId);
    if (e.audience === "selected") {
      const uids = (Array.isArray(e.uids) ? e.uids : []).map(String).filter((u) => rosterSet.has(u));
      out.push({ folderId, audience: "selected", uids });
    } else {
      out.push({ folderId, audience: "all" });
    }
  }
  return out;
}
