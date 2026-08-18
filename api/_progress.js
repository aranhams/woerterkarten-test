
export const INTERVALS = [0, 1, 3, 7, 14, 30];
export const MASTERY_LEVEL = 3;
export const HARD_NOCHMAL = 3;
export const REGRESS_REPEAT = 2;

const DAY_MS = 86400000;

export function effLevel(word, p) {
  if ((word?.deRev || 0) !== (p?.rev || 0)) return 0;
  return p?.level || 0;
}

export function isDueEff(word, p, now = Date.now()) {
  if ((word?.deRev || 0) !== (p?.rev || 0)) return true;
  return !p?.due || now >= p.due;
}

export function isHardFor(word, p) {
  return !!p && (p.nm || 0) >= HARD_NOCHMAL && effLevel(word, p) < MASTERY_LEVEL;
}

export function lastAnsweredAt(p) {
  if (!p || !Number.isFinite(p.due) || !Number.isFinite(p.level)) return null;
  const iv = INTERVALS[p.level];
  if (!Number.isFinite(iv)) return null;
  return p.due - iv * DAY_MS;
}

export function summarizeStudent(assignedWords, progressData, now = Date.now()) {
  const data = progressData || {};
  let sicher = 0, fastSicher = 0, learning = 0, neu = 0, stuckLow = 0, hardCount = 0, due = 0, started = 0, lastActiveAt = null;
  let regressWords = 0, regressRepeat = 0;
  for (const w of assignedWords) {
    const p = data[w.id];
    const lvl = effLevel(w, p);
    if (isDueEff(w, p, now)) due++;
    if (p) {
      started++;
      if (lvl >= MASTERY_LEVEL) sicher++;
      else if (lvl === 2) fastSicher++;
      else { learning++; stuckLow++; }
      if (isHardFor(w, p)) hardCount++;
      if ((p.lp || 0) >= 1) regressWords++;
      if ((p.lt || 0) >= REGRESS_REPEAT) regressRepeat++;
      const t = lastAnsweredAt(p);
      if (t != null && (lastActiveAt == null || t > lastActiveAt)) lastActiveAt = t;
    } else {
      neu++;
    }
  }
  const assigned = assignedWords.length;
  const pct = assigned ? Math.round((sicher / assigned) * 100) : 0;
  return { assigned, sicher, fastSicher, learning, neu, stuckLow, hardCount, regressWords, regressRepeat, mastered: sicher, due, started, pct, lastActiveAt };
}


export const NEW_PER_SESSION = 30;
export const CARDS_CAP = 200;

export function selectDueQueue(manifest, progressData, {
  folderId = null, now = Date.now(),
  newPerSession = NEW_PER_SESSION, cardsCap = CARDS_CAP,
} = {}) {
  const progress = progressData || {};
  let total = 0, due = 0, learned = 0;
  const perFolder = {};
  const candidates = [];

  for (const e of (manifest || [])) {
    if (!e || !e.i) continue;
    total++;
    const key = e.f == null ? "_none" : e.f;
    const bucket = perFolder[key] || (perFolder[key] = { total: 0, due: 0, learned: 0 });
    bucket.total++;
    const p = progress[e.i];
    const word = { deRev: e.r || 0 };
    if (effLevel(word, p) >= MASTERY_LEVEL) { learned++; bucket.learned++; }
    if (!isDueEff(word, p, now)) continue;
    due++;
    bucket.due++;
    if (folderId && e.f !== folderId) continue;
    candidates.push({ id: e.i, isNew: !p });
  }

  const picked = [];
  let newTaken = 0;
  for (const c of candidates) {
    if (picked.length >= cardsCap) break;
    if (c.isNew) {
      if (newTaken >= newPerSession) continue;
      newTaken++;
    }
    picked.push(c.id);
  }

  return { picked, capped: picked.length < candidates.length, stats: { total, due, learned, perFolder } };
}

export const REVIEW_WINDOW_DAYS = 30;
export const TREND_LOOKBACK_WEEKS = 3;

export function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function shiftKey(key, deltaDays) {
  const t = Date.parse(key + "T00:00:00Z");
  return Number.isFinite(t) ? new Date(t + deltaDays * DAY_MS).toISOString().slice(0, 10) : null;
}

export function summarizeActivity(daysMap, now = Date.now(), windowDays = REVIEW_WINDOW_DAYS) {
  const active = new Set();
  let reviews = 0, correct = 0, activeDays = 0;
  const cutoff = now - windowDays * DAY_MS;
  for (const [k, v] of Object.entries(daysMap || {})) {
    const r = (v && v.r) || 0;
    if (r > 0) active.add(k);
    const t = Date.parse(k + "T00:00:00Z");
    if (Number.isFinite(t) && t >= cutoff) {
      reviews += r;
      correct += (v && v.c) || 0;
      if (r > 0) activeDays++;
    }
  }
  const todayK = dayKey(now), yestK = dayKey(now - DAY_MS);
  const anchor = active.has(todayK) ? todayK : active.has(yestK) ? yestK : null;
  let current = 0;
  for (let k = anchor; k && active.has(k); k = shiftKey(k, -1)) current++;
  let longest = 0;
  for (const k of active) {
    const nk = shiftKey(k, 1);
    if (nk && active.has(nk)) continue;
    let run = 0;
    for (let c = k; c && active.has(c); c = shiftKey(c, -1)) run++;
    if (run > longest) longest = run;
  }
  const lastKey = active.size ? [...active].sort().pop() : null;
  return { current, longest, reviews, correct, activeDays, lastKey };
}

export function weekKey(ms) {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10);
}

export function summarizeTrend(weeksMap, lookbackWeeks = TREND_LOOKBACK_WEEKS) {
  const entries = Object.entries(weeksMap || {}).filter(([, v]) => typeof v === "number");
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (entries.length < 2) return { current: entries.length ? entries[0][1] : null, previous: null, delta: null, samples: entries.length };
  const [curKey, curVal] = entries[entries.length - 1];
  const cutoff = Date.parse(curKey + "T00:00:00Z") - lookbackWeeks * 7 * DAY_MS;
  let prevVal = entries[0][1];
  for (const [k, v] of entries) {
    if (Date.parse(k + "T00:00:00Z") <= cutoff) prevVal = v; else break;
  }
  return { current: curVal, previous: prevVal, delta: curVal - prevVal, samples: entries.length };
}
