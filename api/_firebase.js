// Shared helper for the Vercel serverless functions (not a route — `_` prefix).
// Verifies the caller's Firebase ID token and applies a tight CORS policy.
// Requires: firebase-admin  (see package.json)
//
// Env:
//   FIREBASE_SERVICE_ACCOUNT  JSON of a service-account key (or use ADC)
//   APP_ORIGIN                comma-separated allowed origins for CORS
//                             (optional — same-origin needs nothing here)
import { getApps, initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

function ensureApp() {
  if (!getApps().length) {
    const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
    initializeApp(svc ? { credential: cert(JSON.parse(svc)) } : { credential: applicationDefault() });
  }
}

// Returns the decoded token (with .uid) or null.
export async function verifyBearer(req) {
  ensureApp();
  const authz = req.headers.authorization || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : null;
  if (!token) return null;
  try { return await getAuth().verifyIdToken(token); } catch { return null; }
}

// Only echo an allow-origin for explicitly allow-listed origins (fixes the old
// `Access-Control-Allow-Origin: *`). Same-origin calls need no header at all.
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

export { getAuth };
