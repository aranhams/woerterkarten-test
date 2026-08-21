export const DAY_MS = 86_400_000;
export const MIN_MS = 60_000;

// Durations are expressed in minutes: 15 min, 30 min, 1 hour, 1 day (+ unlimited).
export const REPEAT_DURATIONS = [15, 30, 60, 1440, null];

export function isValidDuration(v) {
  return v === null || (Number.isInteger(v) && REPEAT_DURATIONS.includes(v));
}

export function computeExpiresAt(duration, startMs = Date.now()) {
  return duration == null ? null : startMs + duration * MIN_MS;
}

export function repeatIsLive(r, now = Date.now()) {
  if (!r || r.active !== true) return false;
  if (r.expiresAt == null) return true;
  return now < r.expiresAt;
}

export function repeatRemainingMs(r, now = Date.now()) {
  if (!repeatIsLive(r, now)) return 0;
  if (r.expiresAt == null) return Infinity;
  return r.expiresAt - now;
}

// One class may carry several concurrent repeats, each with its own folders and
// expiry, stored in `class.repeats`. Older classes may still hold a single
// `class.repeat` directive; treat it as a one-item list when no array exists.
export function normalizeRepeatEntry(e) {
  const folderIds = Array.isArray(e.folderIds) ? e.folderIds : (e.folderId ? [e.folderId] : []);
  const startedAt = e.startedAt && typeof e.startedAt.toMillis === "function"
    ? e.startedAt.toMillis()
    : (e.startedAt || 0);
  return { id: e.id || "legacy", folderIds, label: e.label || "", startedAt, expiresAt: e.expiresAt ?? null };
}

function entryIsLive(e, now) {
  return !!e && (e.expiresAt == null || now < e.expiresAt);
}

export function listLiveRepeats(cls, now = Date.now()) {
  // An explicit `repeats` array (even empty) is authoritative; only fall back to
  // a legacy singular `repeat` when the array field is entirely absent.
  if (Array.isArray(cls?.repeats)) {
    const out = [];
    for (const e of cls.repeats) if (entryIsLive(e, now)) out.push(normalizeRepeatEntry(e));
    return out;
  }
  return repeatIsLive(cls?.repeat, now) ? [normalizeRepeatEntry(cls.repeat)] : [];
}
