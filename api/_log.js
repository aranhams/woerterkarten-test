import crypto from "crypto";

export function rawIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.socket?.remoteAddress || "unknown";
}

const SINK = { debug: console.log, info: console.log, warn: console.warn, error: console.error, alert: console.error };

export function logEvent(level, event, fields = {}) {
  const line = { ts: new Date().toISOString(), level, event, ...clean(fields) };
  (SINK[level] || console.log)(JSON.stringify(line));
}

function clean(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

export function requestLogger(endpoint, req) {
  const reqId = crypto.randomUUID().slice(0, 8);
  const base = {
    endpoint,
    reqId,
    ip: rawIp(req),
    ua: (req.headers["user-agent"] || "").slice(0, 160) || undefined,
  };
  const t0 = Date.now();
  return {
    reqId,
    log: (level, event, extra = {}) => logEvent(level, event, { ...base, ...extra }),
    done: (level, event, status, extra = {}) =>
      logEvent(level, event, { ...base, status, latencyMs: Date.now() - t0, ...extra }),
  };
}
