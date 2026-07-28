import { getApps, getApp, initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, initializeFirestore } from "firebase-admin/firestore";

function ensureApp() {
  if (!getApps().length) {
    const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
    initializeApp(svc ? { credential: cert(JSON.parse(svc)) } : { credential: applicationDefault() });
  }
}

export async function verifyBearer(req) {
  ensureApp();
  const authz = req.headers.authorization || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : null;
  if (!token) return null;
  try { return await getAuth().verifyIdToken(token); } catch { return null; }
}

export function applyCors(req, res) {
  const allowed = (process.env.APP_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

let _db = null;
export function getDb() {
  ensureApp();
  if (!_db) {
    try { _db = initializeFirestore(getApp(), { preferRest: true }); }
    catch { _db = getFirestore(); }
  }
  return _db;
}

export { getAuth };
