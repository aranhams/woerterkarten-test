// Vercel serverless — grant the teacher role after verifying the enrollment
// code server-side (fixes F5 + F3). The code lives in an env var, never in the
// client bundle; success sets a custom claim { teacher: true } on the user.
//
// Env: TEACHER_CODE  (set to a fresh secret; the old "lehrer2024" is burned)
import crypto from "crypto";
import { verifyBearer, applyCors, getAuth } from "./_firebase.js";

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await verifyBearer(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const expected = process.env.TEACHER_CODE || "";
  if (!expected) return res.status(500).json({ error: "Server misconfigured" });

  const code = String((req.body && req.body.code) || "");
  // Constant-time compare (avoids a trivial timing oracle).
  const a = Buffer.from(code);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(403).json({ error: "Invalid code" });

  await getAuth().setCustomUserClaims(user.uid, { teacher: true });
  // Client must call getIdToken(true) to refresh the claim.
  return res.status(200).json({ ok: true });
}
