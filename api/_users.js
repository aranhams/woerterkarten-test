
export function b32(str) {
  const bytes = new TextEncoder().encode(str);
  const A = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, val = 0, out = "";
  for (const byte of bytes) {
    val = (val << 8) | byte; bits += 8;
    while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}

export const emailForUsername = (u) => `u-${b32(String(u).trim().toLowerCase())}@users.woerterkarten.app`;

export async function resolveUid(auth, username) {
  const name = String(username || "").trim();
  if (!name) return null;
  try {
    const rec = await auth.getUserByEmail(emailForUsername(name));
    return rec.uid;
  } catch {
    return null;
  }
}
