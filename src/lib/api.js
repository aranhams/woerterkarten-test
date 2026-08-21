import { idToken } from "./firebase";

export async function uploadImage(file) {
  if (!file.type.startsWith("image/")) throw new Error("Nur Bilder erlaubt.");
  if (file.size > 5 * 1024 * 1024) throw new Error("Bild zu groß (max 5 MB).");
  const token = await idToken();
  const sigRes = await fetch("/api/sign-cloudinary", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (!sigRes.ok) throw new Error("Signatur fehlgeschlagen.");
  const { signature, timestamp, apiKey, cloudName, folder } = await sigRes.json();
  const fd = new FormData();
  fd.append("file", file);
  fd.append("api_key", apiKey);
  fd.append("timestamp", timestamp);
  fd.append("signature", signature);
  if (folder) fd.append("folder", folder);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { method: "POST", body: fd });
  const data = await res.json();
  if (!data.secure_url) throw new Error("Upload fehlgeschlagen");
  return data.secure_url;
}

export async function classSync(action, payload = {}) {
  const token = await idToken();
  const res = await fetch("/api/class-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Fehler");
  return data;
}

export const getProgressReport = (classId, { fresh = false } = {}) => classSync("progress-report", { classId, fresh });
export const getStudentProgressDetail = (classId, uid) => classSync("student-progress-detail", { classId, uid });

export async function getLearnQueue({ folderId = null } = {}) {
  const token = await idToken();
  const res = await fetch("/api/learn-queue", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ folderId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Fehler");
  return data;
}

export async function adminSync(action, payload = {}) {
  const token = await idToken();
  const res = await fetch("/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Fehler");
  return data;
}

export async function translateWord(payload) {
  const token = await idToken();
  const res = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("translate failed");
  return res.json();
}

async function pronounce(payload) {
  const token = await idToken();
  const res = await fetch("/api/pronounce", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Aussprache fehlgeschlagen");
  return data;
}

export const requestPronunciation = (wordId, scope) => pronounce({ action: "word", wordId, scope });
export const resyncPronunciation = (wordIds) => pronounce({ action: "resync", wordIds });
export const lookupGenus = (de) => pronounce({ action: "genus", de });

export async function collocationSync(action, payload = {}) {
  const token = await idToken();
  const res = await fetch("/api/collocations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Fehler");
  return data;
}

export const getWeakCollocations = (classId) => collocationSync("weak-collocations", { classId });
export const bulkActivateCollocations = (wordIds) => collocationSync("bulk-opt-in-ids", { wordIds });
export const bulkDeactivateCollocations = (wordIds) => collocationSync("bulk-opt-out-ids", { wordIds });
export const addCollocationVariant = (baseWordId, partnerLabel, autofill = false) => collocationSync("add-variant", { baseWordId, partnerLabel, autofill });
export const removeCollocationVariant = (variantId) => collocationSync("remove-variant", { variantId });
export const purgeCollocationSets = (wordId) => collocationSync("purge-sets", { wordId });

export async function getCollocationPractice({ folderId = null, classId = null } = {}) {
  const token = await idToken();
  const res = await fetch("/api/collocations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: "practice-set", folderId, classId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Fehler");
  return data;
}

export async function getArticleQuiz({ folderId = null, classId = null } = {}) {
  const token = await idToken();
  const res = await fetch("/api/article", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ folderId, classId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Fehler");
  return data;
}

export const startRepeat = (classId, folderIds, duration) => classSync("start-repeat", { classId, folderIds, duration });
export const stopRepeat = (classId) => classSync("stop-repeat", { classId });
export const removeRepeat = (classId, repeatId) => classSync("remove-repeat", { classId, repeatId });

export async function getRepeatQueue({ classId, repeatId = null }) {
  const token = await idToken();
  const res = await fetch("/api/repeat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ classId, repeatId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Fehler");
  return data;
}

export async function claimTeacher(token, code) {
  const res = await fetch("/api/claim-teacher", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ code }),
  });
  return res.status;
}
