// Vercel serverless — signed Cloudinary uploads (fixes F7).
// Replaces the UNSIGNED preset. The Cloudinary API secret stays server-side and
// a valid Firebase ID token is required, so anonymous internet users can no
// longer push assets into the account.
//
// Env: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
import crypto from "crypto";
import { verifyBearer, applyCors } from "./_firebase.js";

const hits = new Map();
function rateLimited(uid, max = 20, windowMs = 60000) {
  const now = Date.now();
  const r = hits.get(uid) || { n: 0, t: now };
  if (now - r.t > windowMs) { r.n = 0; r.t = now; }
  r.n += 1; hits.set(uid, r);
  return r.n > max;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await verifyBearer(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  if (rateLimited(user.uid)) return res.status(429).json({ error: "Too many uploads" });

  if (!process.env.CLOUDINARY_API_SECRET || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_CLOUD_NAME) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  // Pin upload parameters (folder) into the signature.
  const timestamp = Math.round(Date.now() / 1000);
  const folder = "woerterkarten";
  const toSign = `folder=${folder}&timestamp=${timestamp}`;
  const signature = crypto.createHash("sha1").update(toSign + process.env.CLOUDINARY_API_SECRET).digest("hex");

  return res.status(200).json({
    signature,
    timestamp,
    folder,
    apiKey: process.env.CLOUDINARY_API_KEY,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
  });
}
