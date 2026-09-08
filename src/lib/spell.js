export function shuffle(arr, rng = Math.random) {
  const a = (arr || []).slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function buildSpellCards(cards) {
  const out = [];
  for (const w of cards || []) {
    if (!w || !w.id) continue;
    const de = String(w.de || "").trim();
    if (!de) continue;
    out.push({
      id: w.id,
      de,
      folderId: w.folderId ?? null,
      deRev: w.deRev || 0,
      t: w.t || null,
      ru: String(w.ru || ""),
      imageUrl: w.imageUrl || null,
      desc: w.desc && w.desc.text ? { text: String(w.desc.text) } : null,
    });
  }
  return out;
}

export function buildSpellDeck(cards, rng = Math.random) {
  return shuffle(cards, rng);
}

export const hasDescription = (card) => !!(card && card.desc && card.desc.text);

const norm = (s) => String(s ?? "").trim();

export function isSpellCorrect(guess, target) {
  const t = norm(target);
  return t.length > 0 && norm(guess) === t;
}

function coalesce(ops) {
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    const cur = ops[k];
    const nxt = ops[k + 1];
    if (cur && nxt && cur.status === "extra" && nxt.status === "missing") {
      out.push({ ch: cur.ch, status: "wrong", expected: nxt.ch });
      k++;
    } else if (cur && nxt && cur.status === "missing" && nxt.status === "extra") {
      out.push({ ch: nxt.ch, status: "wrong", expected: cur.ch });
      k++;
    } else {
      out.push(cur);
    }
  }
  return out;
}

export function spellDiff(guess, target) {
  const g = [...norm(guess)];
  const t = [...norm(target)];
  const n = g.length;
  const m = t.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = g[i] === t[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (g[i] === t[j]) { ops.push({ ch: g[i], status: "match" }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ ch: g[i], status: "extra" }); i++; }
    else { ops.push({ ch: t[j], status: "missing" }); j++; }
  }
  while (i < n) { ops.push({ ch: g[i], status: "extra" }); i++; }
  while (j < m) { ops.push({ ch: t[j], status: "missing" }); j++; }
  return coalesce(ops);
}

export function recordSpell(prev, correct, guess, now) {
  const p = prev || {};
  const rec = {
    a: (p.a || 0) + 1,
    m: (p.m || 0) + (correct ? 0 : 1),
    nm: correct ? Math.max(0, (p.nm || 0) - 1) : (p.nm || 0) + 1,
    lastWrong: correct ? (p.lastWrong ?? null) : String(guess ?? ""),
  };
  if (Number.isFinite(now)) rec.last = now;
  else if (p.last != null) rec.last = p.last;
  return rec;
}
