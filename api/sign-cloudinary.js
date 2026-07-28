import crypto from "crypto";
import { verifyBearer, applyCors } from "./_firebase.js";
import { rateLimit } from "./_ratelimit.js";
import { requestLogger } from "./_log.js";

export default async function handler(req, res) {
  const L = requestLogger("sign-cloudinary", req);
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await verifyBearer(req);
  if (!user) {
    L.done("warn", "cloudinary.sign.unauthorized", 401);
    return res.status(401).json({ error: "Unauthorized" });
  }

  const rl = await rateLimit(`cloud:${user.uid}`, { max: 20, windowMs: 60_000 });
  if (rl.limited) {
    L.done("warn", "cloudinary.sign.ratelimited", 429, { uid: user.uid, degraded: rl.degraded });
    res.setHeader("Retry-After", String(rl.retryAfterSec));
    return res.status(429).json({ error: "Too many uploads" });
  }

  if (!process.env.CLOUDINARY_API_SECRET || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_CLOUD_NAME) {
    L.done("error", "cloudinary.sign.misconfigured", 500, { uid: user.uid });
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const timestamp = Math.round(Date.now() / 1000);
  const folder = "woerterkarten";
  const toSign = `folder=${folder}&timestamp=${timestamp}`;
  const signature = crypto.createHash("sha1").update(toSign + process.env.CLOUDINARY_API_SECRET).digest("hex");

  L.done("info", "cloudinary.sign.issued", 200, { uid: user.uid, remaining: rl.remaining });

  return res.status(200).json({
    signature,
    timestamp,
    folder,
    apiKey: process.env.CLOUDINARY_API_KEY,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
  });
}
