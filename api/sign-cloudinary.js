import crypto from "crypto";
import { verifyBearer, applyCors } from "./_firebase.js";
import { rateLimit } from "./_ratelimit.js";

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await verifyBearer(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const rl = await rateLimit(`cloud:${user.uid}`, { max: 20, windowMs: 60_000 });
  if (rl.limited) {
    res.setHeader("Retry-After", String(rl.retryAfterSec));
    return res.status(429).json({ error: "Too many uploads" });
  }

  if (!process.env.CLOUDINARY_API_SECRET || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_CLOUD_NAME) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

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
