import { FieldValue } from "firebase-admin/firestore";
import { makeCode } from "./_classes.js";

const COLLECTION = "admin_config";
const DOC_ID = "teacher_code";

export const TEACHER_CODE_LEN = 16;

export async function getTeacherCode(db) {
  try {
    const snap = await db.collection(COLLECTION).doc(DOC_ID).get();
    const stored = snap.exists ? snap.data()?.code : null;
    if (stored) return { code: String(stored), source: "stored" };
  } catch { /* fall through to env */ }
  const env = process.env.TEACHER_CODE || "";
  return { code: env, source: env ? "env" : "none" };
}

export async function regenTeacherCode(db, uid) {
  const code = makeCode(TEACHER_CODE_LEN);
  await db.collection(COLLECTION).doc(DOC_ID).set({
    code,
    updatedBy: uid || null,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return code;
}
