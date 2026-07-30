export const INTERVALS = [0, 1, 3, 7, 14, 30];

export function nextReview(level, knew) {
  const l = knew ? Math.min(level + 1, INTERVALS.length - 1) : 0;
  return { level: l, due: Date.now() + INTERVALS[l] * 86400000 };
}

export function isDue(p) {
  return !p?.due || Date.now() >= p.due;
}

export const lvlEmoji = (l) => ["🌱", "🌿", "🌲", "⭐", "🏆", "💎"][l ?? 0] || "🌱";
