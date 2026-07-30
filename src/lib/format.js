import { ARTICLES } from "./constants";

export const clip = (s, n) => String(s ?? "").slice(0, n);

export function cleanArticle(a) {
  a = String(a || "").trim().toLowerCase();
  return ARTICLES.includes(a) ? a : "";
}

export function validImageUrl(u) {
  return u == null || /^https:\/\/res\.cloudinary\.com\/[^\s]+$/.test(u);
}

export function cldImg(u, w = 400) {
  if (!u || !u.includes("/image/upload/") || /\/image\/upload\/[^/]*(?:f_auto|q_auto|w_\d)/.test(u)) return u;
  return u.replace("/image/upload/", `/image/upload/f_auto,q_auto,c_limit,w_${w}/`);
}

function b32(str) {
  const bytes = new TextEncoder().encode(str);
  const A = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, val = 0, out = "";
  for (const byte of bytes) { val = (val << 8) | byte; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}

export const emailForUsername = (u) => `u-${b32(u.trim().toLowerCase())}@users.woerterkarten.app`;
