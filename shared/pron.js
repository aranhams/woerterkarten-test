export const PRON_V = 2;

const norm = (s) => String(s ?? "").normalize("NFC").trim();

export function pronState(word) {
  const p = word && word.pron;
  if (!p || p.v !== PRON_V || norm(p.de) !== norm(word && word.de)) return "pending";
  if (p.st === "ready" && p.url) return "ready";
  return "failed";
}
