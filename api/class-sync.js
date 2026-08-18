import { verifyBearer, applyCors, getAuth, getDb } from "./_firebase.js";
import { checkLock, registerFailure, clientIp } from "./_ratelimit.js";
import { requestLogger } from "./_log.js";
import { FieldValue } from "firebase-admin/firestore";
import { recomputeDenorm, genUniqueJoinCode, makeCode, syncWordManifests, dropFromManifests } from "./_classes.js";
import { resolveUid } from "./_users.js";
import { summarizeStudent, summarizeActivity, summarizeTrend, dayKey, effLevel, isDueEff, isHardFor, resolveArticleAnswer, summarizeHardArticles, MASTERY_LEVEL } from "./_progress.js";
import { MASTERY_LEVEL as COLL_MASTERY_LEVEL } from "./_collocations.js";

const MAX_FAILS = 40;
const WINDOW_MS = 15 * 60_000;
const PRIVATE_CAP = 500;
const CHUNK = 30;
const REPORT_TTL_MS = 120_000;
const ROSTER_TTL_MS = 300_000;

const reportCache = new Map();
let rosterCache = null;

const parseUids = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 500) : []);

const chunks = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

async function loadClassCorpus(db, data) {
  const folderIds = [...new Set((data.folders || []).map((e) => e && e.folderId).filter(Boolean))];
  const looseIds = [...new Set((data.wordIds || []).map(String).filter(Boolean))];

  const folders = [];
  for (const slice of chunks(folderIds, CHUNK)) {
    const snaps = await db.getAll(...slice.map((id) => db.doc(`global_folders/${id}`)));
    for (const s of snaps) if (s.exists) folders.push(s);
  }

  const seen = new Map();
  for (const slice of chunks(folderIds, CHUNK)) {
    const snap = await db.collection("global_words").where("folderId", "in", slice).get();
    for (const d of snap.docs) seen.set(d.id, { id: d.id, ...d.data() });
  }
  for (const slice of chunks(looseIds.filter((id) => !seen.has(id)), CHUNK)) {
    const snaps = await db.getAll(...slice.map((id) => db.doc(`global_words/${id}`)));
    for (const s of snaps) if (s.exists) seen.set(s.id, { id: s.id, ...s.data() });
  }

  return {
    words: [...seen.values()],
    folderMeta: new Map(folders.map((d) => [d.id, d.data()])),
  };
}

const TEACHER_ACTIONS = new Set([
  "create", "rename", "delete", "regen-code",
  "list-students", "add-student", "remove-student", "reset-student-password",
  "set-folders", "set-folder-audience", "release-folder", "set-words",
  "sync", "cleanup", "word-updated", "word-assigned",
  "progress-report", "student-progress-detail",
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
    const result = await dispatch({ db, auth, user, action, body, L });
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

async function dispatch({ db, auth, user, action, body, L }) {
  const classes = db.collection("classes");
  const stamp = () => FieldValue.serverTimestamp();

  const scopeOf = (data, extraFolderIds = [], extraWordIds = []) => ({
    folderIds: [
      ...(data?.folders || []).map((e) => e && e.folderId).filter(Boolean),
      ...extraFolderIds,
    ],
    wordIds: [...(data?.wordIds || []).map(String), ...extraWordIds],
  });

  const invalidateReport = (classId) => { if (classId) reportCache.delete(String(classId)); };

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
      const { ref, id, data } = await loadClass(body.classId);
      const scope = scopeOf(data);
      await ref.delete();
      invalidateReport(id);
      const { updated } = await recomputeDenorm(db, scope);
      return { stamped: updated };
    }

    case "regen-code": {
      const { ref } = await loadClass(body.classId);
      const joinCode = await genUniqueJoinCode(db);
      await ref.set({ joinCode, updatedAt: stamp() }, { merge: true });
      return { joinCode };
    }

    case "list-students": {
      if (rosterCache && Date.now() - rosterCache.at < ROSTER_TTL_MS) {
        return { students: rosterCache.students, cached: true };
      }
      const students = await listAllStudents(db, auth);
      rosterCache = { at: Date.now(), students };
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
      invalidateReport(body.classId);
      await recomputeDenorm(db, scopeOf(data));
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
      invalidateReport(body.classId);
      await recomputeDenorm(db, scopeOf(data));
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
      invalidateReport(body.classId);
      await recomputeDenorm(db, scopeOf(data, folders.map((e) => e.folderId)));
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
      invalidateReport(body.classId);
      await recomputeDenorm(db, scopeOf(data, [folderId]));
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
      invalidateReport(body.classId);
      await recomputeDenorm(db, scopeOf(data, [folderId]));
      return {};
    }

    case "set-words": {
      const { ref, data } = await loadClass(body.classId);
      const wordIds = Array.isArray(body.wordIds)
        ? [...new Set(body.wordIds.map(String))].slice(0, 5000)
        : [];
      await ref.set({ wordIds, updatedAt: stamp() }, { merge: true });
      invalidateReport(body.classId);
      await recomputeDenorm(db, scopeOf(data, [], wordIds));
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
        if (changed) { upd.updatedAt = stamp(); batch.set(d.ref, upd, { merge: true }); touched++; invalidateReport(d.id); }
      }
      if (touched) await batch.commit();

      const scope = folderId ? { folderIds: [folderId], wordIds: [] } : { folderIds: [], wordIds: [wordId] };
      const { updated } = await recomputeDenorm(db, scope);
      if (wordId) {
        const uids = Array.isArray(body.memberUids) ? body.memberUids.map(String).slice(0, 500) : [];
        await dropFromManifests(db, wordId, uids).catch(() => {});
      }
      return { touched, stamped: updated };
    }

    case "word-updated": {
      const wordId = String(body.wordId || "");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(wordId)) throw new HttpError(400, "wordId ungültig");
      await db.doc(`global_words/${wordId}`).set({ t: FieldValue.delete() }, { merge: true });
      const manifests = await syncWordManifests(db, [wordId], parseUids(body.prevMemberUids)).catch(() => 0);
      return { invalidated: 1, manifests };
    }

    case "word-assigned": {
      const ids = (Array.isArray(body.wordIds) ? body.wordIds : [body.wordId])
        .filter(Boolean).map(String).filter((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id)).slice(0, 500);
      if (!ids.length) throw new HttpError(400, "wordIds fehlt");
      const manifests = await syncWordManifests(db, ids, parseUids(body.prevMemberUids));
      return { manifests };
    }

    case "sync": {
      const purged = await purgeMemberNames(db);
      const { updated } = await recomputeDenorm(db);
      reportCache.clear();
      rosterCache = null;
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
      invalidateReport(snap.docs[0].id);
      await recomputeDenorm(db, scopeOf(data));
      return { classId: snap.docs[0].id, name: data.name };
    }

    case "progress-report": {
      const { id, data } = await loadClass(body.classId);
      const cached = reportCache.get(id);
      if (body.fresh !== true && cached && Date.now() - cached.at < REPORT_TTL_MS) {
        return { ...cached.payload, cached: true };
      }
      const rosterAll = Array.isArray(data.memberUids) ? data.memberUids : [];
      const CAP = 500;
      const truncated = rosterAll.length > CAP;
      const roster = truncated ? rosterAll.slice(0, CAP) : rosterAll;

      const { words, folderMeta } = await loadClassCorpus(db, data);
      const wordById = new Map(words.map((w) => [w.id, w]));
      const rosterSet = new Set(roster);
      const assignedByUid = new Map(roster.map((u) => [u, []]));
      for (const w of words) {
        for (const u of (Array.isArray(w.memberUids) ? w.memberUids : [])) {
          if (rosterSet.has(u)) assignedByUid.get(u).push(w);
        }
      }

      const n = roster.length;
      const refs = [
        ...roster.map((u) => db.doc(`users/${u}/meta/progress`)),
        ...roster.map((u) => db.doc(`users/${u}`)),
        ...roster.map((u) => db.doc(`users/${u}/meta/activity`)),
        ...roster.map((u) => db.doc(`users/${u}/meta/collocationProgress`)),
        ...roster.map((u) => db.doc(`users/${u}/meta/articleProgress`)),
      ];
      const snaps = n ? await db.getAll(...refs) : [];
      const personalSnaps = n
        ? await Promise.all(roster.map((u) =>
            db.collection(`users/${u}/words`).limit(PRIVATE_CAP).get().catch(() => null)))
        : [];

      const now = Date.now();
      const WEEK_MS = 7 * 86400000;
      const STRIP_DAYS = 21;
      const stripKeys = Array.from({ length: STRIP_DAYS }, (_, i) => dayKey(now - (STRIP_DAYS - 1 - i) * 86400000));
      const stripIdx = new Map(stripKeys.map((key, i) => [key, i]));
      const stripActive = new Array(STRIP_DAYS).fill(0);
      const rows = [];
      const stuckByWord = new Map();
      const hardPrivate = [];
      const folderRows = new Map();
      const articleProgressByUid = new Map();
      for (let i = 0; i < n; i++) {
        const uid = roster[i];
        const progSnap = snaps[i];
        const userSnap = snaps[n + i];
        const actSnap = snaps[2 * n + i];
        const collocSnap = snaps[3 * n + i];
        const articleSnap = snaps[4 * n + i];
        const progressData = (progSnap && progSnap.exists ? progSnap.data()?.data : null) || {};
        const username = (userSnap && userSnap.exists ? userSnap.data()?.username : null) || uid.slice(0, 6);
        const actData = (actSnap && actSnap.exists) ? actSnap.data() : null;
        const activityDays = actData?.days || {};
        const assigned = assignedByUid.get(uid) || [];
        const act = summarizeActivity(activityDays, now);
        const trend = summarizeTrend(actData?.weeks || {});
        for (const [key, v] of Object.entries(activityDays)) {
          if (((v && v.r) || 0) > 0 && stripIdx.has(key)) stripActive[stripIdx.get(key)]++;
        }

        const collocData = (collocSnap && collocSnap.exists ? collocSnap.data()?.data : null) || {};
        let collocTotal = 0, collocHard = 0, collocMastered = 0;
        const collocHardWords = [];
        for (const [wordId, p] of Object.entries(collocData)) {
          if (!p) continue;
          collocTotal++;
          const lvl = p.level || 0;
          if (lvl >= COLL_MASTERY_LEVEL) collocMastered++;
          else if ((p.nm || 0) >= 3) {
            collocHard++;
            const w = wordById.get(wordId) || {};
            collocHardWords.push({ wordId, nm: p.nm || 0, de: w.de || "", article: w.article || "" });
          }
        }
        collocHardWords.sort((a, b) => b.nm - a.nm || (a.de || "").localeCompare(b.de || ""));

        const articleData = (articleSnap && articleSnap.exists ? articleSnap.data()?.data : null) || {};
        articleProgressByUid.set(uid, articleData);
        let articleTotal = 0, articleHard = 0, articleMastered = 0;
        for (const [wordId, p] of Object.entries(articleData)) {
          if (!p) continue;
          const w = wordById.get(wordId);
          if (!w || resolveArticleAnswer(w) == null) continue;
          articleTotal++;
          if (effLevel(w, p) >= MASTERY_LEVEL) articleMastered++;
          else if (isHardFor(w, p)) articleHard++;
        }

        rows.push({
          uid, username, ...summarizeStudent(assigned, progressData, now),
          streak: act.current, reviews30: act.reviews, correct30: act.correct,
          trendDelta: trend.delta, trendSamples: trend.samples,
          collocTotal, collocHard, collocMastered, collocHardWords,
          articleTotal, articleHard, articleMastered,
        });

        for (const [wordId, p] of Object.entries(progressData)) {
          const w = wordById.get(wordId);
          if (!w || !p) continue;
          const rec = stuckByWord.get(wordId) || { stuck: 0, started: 0 };
          rec.started++;
          if (isHardFor(w, p)) rec.stuck++;
          stuckByWord.set(wordId, rec);
        }

        const personalSnap = personalSnaps[i];
        for (const d of (personalSnap ? personalSnap.docs : [])) {
          const w = { id: d.id, ...d.data() };
          const p = progressData[w.id];
          if (!isHardFor(w, p)) continue;
          hardPrivate.push({
            wordId: w.id, uid, username,
            de: w.de || "", article: w.article || "",
            nm: (p && p.nm) || 0, lapses: (p && p.lp) || 0,
          });
        }

        const perFolder = new Map();
        for (const w of assigned) {
          const p = progressData[w.id];
          if (w.folderId != null) {
            const rec = perFolder.get(w.folderId) || { assigned: 0, sicher: 0 };
            rec.assigned++;
            if (effLevel(w, p) >= MASTERY_LEVEL) rec.sicher++;
            perFolder.set(w.folderId, rec);
          }
        }
        for (const [fid, rec] of perFolder) {
          const list = folderRows.get(fid) || [];
          list.push({ uid, username, pct: Math.round((rec.sicher / rec.assigned) * 100), mastered: rec.sicher, assigned: rec.assigned });
          folderRows.set(fid, list);
        }
      }
      rows.sort((a, b) => a.username.localeCompare(b.username));

      const readiness = [...folderRows.entries()]
        .map(([folderId, students]) => {
          const meta = folderMeta.get(folderId) || {};
          students.sort((a, b) => b.pct - a.pct || a.username.localeCompare(b.username));
          return { folderId, name: meta.name || "Ordner", icon: meta.icon || "📁", students };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      const withAssigned = rows.filter((r) => r.assigned > 0);
      const distribution = rows.reduce((a, r) => {
        a.neu += r.neu; a.learning += r.learning; a.fastSicher += r.fastSicher; a.sicher += r.sicher; a.assigned += r.assigned; return a;
      }, { neu: 0, learning: 0, fastSicher: 0, sicher: 0, assigned: 0 });
      const aggregate = {
        activeStudents: rows.filter((r) => r.lastActiveAt != null && now - r.lastActiveAt <= WEEK_MS).length,
        avgPct: withAssigned.length ? Math.round(withAssigned.reduce((s, r) => s + r.pct, 0) / withAssigned.length) : 0,
        totalDue: rows.reduce((s, r) => s + r.due, 0),
        assignedStudents: withAssigned.length,
        distribution,
        classSicherPct: distribution.assigned ? Math.round((distribution.sicher / distribution.assigned) * 100) : 0,
        practice: { windowDays: STRIP_DAYS, days: stripKeys.map((key, i) => ({ key, active: stripActive[i] })) },
      };

      const hardWords = [...stuckByWord.entries()]
        .map(([wordId, rec]) => {
          const w = wordById.get(wordId) || {};
          return { wordId, de: w.de || "", article: w.article || "", stuck: rec.stuck, started: rec.started };
        })
        .filter((h) => h.stuck > 0)
        .sort((a, b) => b.stuck - a.stuck || (b.stuck / b.started) - (a.stuck / a.started))
        .slice(0, 15);

      const hardPrivateWords = hardPrivate
        .sort((a, b) => b.nm - a.nm || a.username.localeCompare(b.username))
        .slice(0, 20);

      const hardArticles = summarizeHardArticles(wordById, articleProgressByUid);

      L.log("info", "class.progress-report", { uid: user.uid, classId: id, rosterSize: rosterAll.length, words: words.length });
      const payload = { generatedAt: now, class: { id, name: data.name || "", icon: data.icon || "" }, rosterSize: rosterAll.length, truncated, aggregate, students: rows, hardWords, hardPrivateWords, hardArticles, readiness };
      reportCache.set(id, { at: Date.now(), payload });
      return payload;
    }

    case "student-progress-detail": {
      const { data } = await loadClass(body.classId);
      const uid = String(body.uid || "");
      if (!uid) throw new HttpError(400, "uid fehlt");
      if (!(Array.isArray(data.memberUids) && data.memberUids.includes(uid))) throw new HttpError(403, "Nicht im Kurs");

      const corpus = await loadClassCorpus(db, data);
      const assigned = corpus.words.filter((w) => Array.isArray(w.memberUids) && w.memberUids.includes(uid));
      const folders = Object.fromEntries([...corpus.folderMeta].map(([fid, f]) => [fid, { name: f.name || "Ordner", icon: f.icon || "📁" }]));
      const [snap, actSnap, privWordsSnap, privFoldersSnap] = await Promise.all([
        db.doc(`users/${uid}/meta/progress`).get(),
        db.doc(`users/${uid}/meta/activity`).get(),
        db.collection(`users/${uid}/words`).limit(PRIVATE_CAP).get(),
        db.collection(`users/${uid}/folders`).limit(PRIVATE_CAP).get(),
      ]);
      const progressData = (snap.exists ? snap.data()?.data : null) || {};
      const activity = (actSnap.exists ? actSnap.data()?.days : null) || {};
      const now = Date.now();
      const rowFor = (w) => {
        const p = progressData[w.id];
        const level = effLevel(w, p);
        return { wordId: w.id, de: w.de || "", article: w.article || "", folderId: w.folderId || null, level, started: !!p, mastered: level >= MASTERY_LEVEL, dueNow: isDueEff(w, p, now), hard: isHardFor(w, p), lapses: (p && p.lp) || 0, lapsesTotal: (p && p.lt) || 0 };
      };
      const byLabel = (a, b) => (a.article + " " + a.de).localeCompare(b.article + " " + b.de);
      const wordRows = assigned.map(rowFor).sort(byLabel);
      const privateWords = privWordsSnap.docs.map((d) => rowFor({ id: d.id, ...d.data() })).sort(byLabel);
      const privateFolders = Object.fromEntries(privFoldersSnap.docs.map((d) => [d.id, { name: d.data().name || "Ordner", icon: d.data().icon || "📁" }]));
      return { words: wordRows, folders, activity, privateWords, privateFolders };
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
