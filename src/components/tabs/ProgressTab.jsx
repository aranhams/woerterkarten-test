import { useState, useEffect } from "react";
import { FOLDER_PAGE } from "../../lib/constants";
import { getProgressReport, getStudentProgressDetail, getWeakCollocations } from "../../lib/api";
import { loadAllClasses } from "../../data/loaders";
import { clearDataCache } from "../../data/cache";

const C = { sicher: "#3f8a5c", fastSicher: "#59b98c", learning: "#c8773a", neu: "#cbc8be", struggle: "#c0392b" };

const MIN_STARTED = 3, LOW_SECURE_PCT = 25, HARD_FLAG = 3;
const REGRESS_WORDS = 3;
const READY_PCT = 70;
const CLASS_PAGE = 4;

const RISK_MIN = 25;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

const heatGreen = (t) => `rgba(63,138,92,${(0.14 + 0.86 * Math.max(0, Math.min(1, t))).toFixed(3)})`;
const pctStatus = (p) => (p < 40 ? C.struggle : p < 70 ? C.learning : C.sicher);
const fmtDay = (key) => { const [, m, d] = key.split("-"); return `${d}.${m}.`; };

const cardBox = { background: "white", borderRadius: 10, padding: "14px 15px", boxShadow: "0 1px 4px rgba(0,0,0,.06)", marginBottom: 20 };
const mutedP = { fontSize: 13, color: "var(--ink-soft)", marginBottom: 16 };

function flagsFor(r) {
  const flags = [];
  const hard = r.hardCount || 0;
  if (hard >= HARD_FLAG) flags.push("ins Stocken geraten");
  if ((r.regressRepeat || 0) >= 1 || (r.regressWords || 0) >= REGRESS_WORDS) flags.push("Gelerntes rutscht ab");
  if (r.started >= MIN_STARTED && r.pct < LOW_SECURE_PCT && hard > 0) flags.push("wenig gefestigt");
  if ((r.collocHard || 0) >= 2) flags.push("Wortverbindungen schwierig");
  return flags;
}

function riskFor(r, now) {
  const DAY = 86400000;
  const started = r.started || 0;
  const conf = clamp01(started / 5);
  const ageDays = r.lastActiveAt == null ? Infinity : (now - r.lastActiveAt) / DAY;
  const backlog = Math.max(0, (r.due || 0) - (r.neu || 0));
  const acc = (r.reviews30 || 0) >= 5 ? (r.correct30 || 0) / r.reviews30 : null;
  const parts = [
    ["Wenig gefestigt", 0.20, conf * clamp01((60 - r.pct) / 60)],
    ["Niedrige Trefferquote", 0.15, acc == null ? 0 : conf * clamp01((0.7 - acc) / 0.7)],
    ["Verschlechtert sich", 0.20, (r.trendSamples || 0) >= 2 && r.trendDelta != null ? conf * clamp01(-r.trendDelta / 20) : 0],
    ["Gelerntes rutscht ab", 0.15, conf * clamp01((r.regressRepeat || 0) * 0.5 + (r.regressWords || 0) * 0.2)],
    ["Ins Stocken geraten", 0.10, conf * clamp01((r.hardCount || 0) / 6)],
    ["Aufgestaute Wiederh.", 0.05, conf * clamp01(backlog / Math.max(10, started))],
    ["Inaktiv", 0.15, started === 0 || ageDays === Infinity ? 0.85 : clamp01((ageDays - 7) / 23)],
  ];
  let score = 0, top = null;
  for (const [label, w, risk] of parts) {
    const contrib = w * risk;
    score += contrib;
    if (!top || contrib > top.contrib) top = { label, contrib };
  }
  return { score: Math.round(score * 100), reason: top && top.contrib > 0 ? top.label : null };
}

const riskColor = (s) => (s >= 60 ? C.struggle : s >= 40 ? C.learning : "var(--ink-soft)");

const REASON_HELP = {
  "wenig gefestigt": "Nur ein kleiner Teil der zugewiesenen Karten ist gefestigt (unter 60 %).",
  "niedrige trefferquote": "Beim Üben wird viel falsch beantwortet (unter 70 % richtig in den letzten 30 Tagen).",
  "verschlechtert sich": "Der Lernstand ist in den letzten Wochen gesunken statt gestiegen.",
  "gelerntes rutscht ab": "Schon gefestigte Wörter werden wieder vergessen — teils mehrfach dasselbe Wort.",
  "ins stocken geraten": "Mehrere Wörter werden wiederholt vergessen (≥ 3× Nochmal) und sind noch nicht gefestigt.",
  "aufgestaute wiederh.": "Viele bereits gelernte Karten sind zur Wiederholung überfällig.",
  "inaktiv": "Seit Längerem nicht mehr geübt — oder noch nie gestartet.",
  "wortverbindungen schwierig": "Mehrere Wortverbindungen werden wiederholt falsch beantwortet und sind noch nicht gefestigt.",
};
const reasonHelp = (label) => REASON_HELP[String(label || "").toLowerCase()] || undefined;

function StateBar({ sicher = 0, fastSicher = 0, learning = 0, neu = 0, assigned, height = 14 }) {
  if (!assigned) return <div style={{ height, borderRadius: 4, background: "var(--ivory-dark)" }} />;
  const seg = (n, color, label) => n > 0 && (
    <div style={{ flex: n, background: color, borderRadius: 4 }} title={`${label}: ${n}`} />
  );
  return <div style={{ display: "flex", gap: 2, height }}>
    {seg(sicher, C.sicher, "Sicher")}
    {seg(fastSicher, C.fastSicher, "Fast sicher")}
    {seg(learning, C.learning, "Am Lernen")}
    {seg(neu, C.neu, "Neu")}
  </div>;
}

function Legend({ dist }) {
  const total = dist.assigned || 1;
  const items = [["Sicher", dist.sicher, C.sicher], ["Fast sicher", dist.fastSicher, C.fastSicher], ["Am Lernen", dist.learning, C.learning], ["Neu", dist.neu, C.neu]];
  return <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10 }}>
    {items.map(([label, n, color]) => (
      <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-soft)" }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: color, flexShrink: 0 }} />
        {label} <b style={{ color: "var(--ink)" }}>{Math.round(n / total * 100)}%</b>
      </span>
    ))}
  </div>;
}

function StruggleChart({ hardWords }) {
  const top = hardWords.slice(0, 5);
  const max = Math.max(...top.map((h) => h.stuck), 1);
  return <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
    {top.map((h) => (
      <div key={h.wordId} style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 116, flexShrink: 0, fontSize: 13, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          title={`${h.article ? h.article + " " : ""}${h.de}`}>
          {h.article && <span style={{ color: "var(--accent)", fontStyle: "italic" }}>{h.article} </span>}{h.de}
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 7 }}>
          <div style={{ height: 15, width: `${(h.stuck / max) * 100}%`, minWidth: 4, background: C.struggle, borderRadius: 4 }}
            title={`${h.stuck} von ${h.started} Schülern haben dieses Wort oft vergessen (≥ 3× „Nochmal") und noch nicht gefestigt`} />
          <span style={{ fontSize: 12, color: "var(--ink-soft)", fontWeight: 700 }}>{h.stuck}</span>
        </div>
      </div>
    ))}
  </div>;
}

function WeakCollocations({ classId }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    (async () => {
      try {
        const r = await getWeakCollocations(classId);
        if (!cancelled) setState({ loading: false, weak: r.weak || [], readyCount: r.readyCount || 0 });
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: e.message || "Fehler" });
      }
    })();
    return () => { cancelled = true; };
  }, [classId]);

  if (state.loading) return <p style={mutedP}>Lädt…</p>;
  if (state.error) return <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>Wortverbindungen konnten nicht geladen werden.</p>;
  if (state.readyCount === 0) {
    return <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>Noch keine übungsbereiten Wortverbindungen. Gib welche im Verwalten-Bereich unter Wortverbindungen frei.</p>;
  }
  if (state.weak.length === 0) {
    return <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>👍 Keine schwierigen Wortverbindungen — {state.readyCount} übungsbereit.</p>;
  }
  const max = Math.max(...state.weak.map((h) => h.stuck), 1);
  return <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
    {state.weak.slice(0, 5).map((h) => (
      <div key={h.wordId} style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 116, flexShrink: 0, fontSize: 13, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          title={`${h.article ? h.article + " " : ""}${h.de}${h.answer ? ` → ${h.answer}` : ""}`}>
          {h.article && <span style={{ color: "var(--accent)", fontStyle: "italic" }}>{h.article} </span>}{h.de}
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 7 }}>
          <div style={{ height: 15, width: `${(h.stuck / max) * 100}%`, minWidth: 4, background: C.struggle, borderRadius: 4 }}
            title={`${h.stuck} von ${h.started} Schülern haben diese Verbindung oft verwechselt (≥ 3× falsch) und noch nicht gefestigt`} />
          <span style={{ fontSize: 12, color: "var(--ink-soft)", fontWeight: 700 }}>{h.stuck}</span>
        </div>
      </div>
    ))}
  </div>;
}

function PrivateStruggleList({ rows }) {
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-soft)", marginBottom: 3 }}>
        🔒 Private Wörter
      </div>
      <p style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 9 }}>
        Selbst angelegte Wörter der Schüler — zählen nicht zur Kursauswertung.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 5 }}>
        <span style={{ width: 140, flexShrink: 0, textAlign: "right" }}>Wort</span>
        <span style={{ flex: 1, minWidth: 0 }}>Schüler:in</span>
        <span style={{ whiteSpace: "nowrap" }}>Nochmal</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((h) => (
          <div key={`${h.uid}:${h.wordId}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 140, flexShrink: 0, fontSize: 13, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
              title={`${h.article ? h.article + " " : ""}${h.de}`}>
              <span title="privat angelegt">🔒 </span>
              {h.article && <span style={{ color: "var(--accent)", fontStyle: "italic" }}>{h.article} </span>}{h.de}
            </span>
            <span style={{ flex: 1, minWidth: 0, display: "flex" }}>
              <span title={`Schüler:in: ${h.username}`}
                style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99, background: "var(--sage-pale)", color: "var(--sage)", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                👤 {h.username}
              </span>
            </span>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.struggle, whiteSpace: "nowrap" }}
              title={`${h.nm}× „Nochmal" seit dem letzten Erfolg und noch nicht gefestigt${h.lapses ? ` · ${h.lapses}× wieder vergessen` : ""}`}>
              ↺{h.nm}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PrivateWordsSection({ words, folders }) {
  const [open, setOpen] = useState(false);
  let sicher = 0, fastSicher = 0, learning = 0, neu = 0;
  for (const w of words) {
    if (w.mastered) sicher++;
    else if (!w.started) neu++;
    else if (w.level === 2) fastSicher++;
    else learning++;
  }
  const byFolder = new Map();
  for (const w of words) {
    const fid = w.folderId || "__none";
    if (!byFolder.has(fid)) byFolder.set(fid, []);
    byFolder.get(fid).push(w);
  }
  const entries = [...byFolder.entries()].sort((a, b) => {
    if (a[0] === "__none") return 1;
    if (b[0] === "__none") return -1;
    return (folders[a[0]]?.name || "").localeCompare(folders[b[0]]?.name || "");
  });

  return (
    <div style={{ marginTop: 4, paddingTop: 12, borderTop: "1.5px solid var(--ivory-dark)" }}>
      <button onClick={() => setOpen((o) => !o)} aria-pressed={open}
        style={{ width: "100%", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left", padding: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            🔒 Eigene Wörter <span style={{ fontWeight: 400, color: "var(--ink-soft)" }}>· privat</span>
          </span>
          <span style={{ fontSize: 11, color: "var(--ink-soft)", whiteSpace: "nowrap" }}>{sicher}/{words.length} gefestigt</span>
          <span style={{ fontSize: 11, color: "var(--ink-soft)", width: 12, textAlign: "center" }}>{open ? "▲" : "▼"}</span>
        </div>
        <StateBar sicher={sicher} fastSicher={fastSicher} learning={learning} neu={neu} assigned={words.length} height={8} />
      </button>
      {open && (
        <div style={{ marginTop: 9 }}>
          <p style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 9 }}>
            Vom Schüler selbst angelegt — zählen nicht zur Kursauswertung.
          </p>
          {entries.map(([fid, list]) => {
            const meta = fid === "__none" ? { name: "Ohne Ordner", icon: "📄" } : (folders[fid] || { name: "Ordner", icon: "📁" });
            return (
              <div key={fid} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-soft)", marginBottom: 4 }}>{meta.icon} {meta.name}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {list.map((w) => <WordChip key={w.wordId} w={w} hard={w.hard} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const flagChip = {
  fontSize: 11, padding: "2px 8px", borderRadius: 99, fontWeight: 600,
  background: "var(--red-pale)", color: "var(--red-soft)", whiteSpace: "nowrap",
};

function FolderStudentRow({ s }) {
  const ready = s.pct >= READY_PCT;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 96, flexShrink: 0, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: ready ? "var(--ink)" : "var(--ink-soft)", fontWeight: ready ? 600 : 400 }}>{s.username}</span>
      <div style={{ flex: 1, height: 8, background: "var(--ivory-dark)", borderRadius: 99, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${s.pct}%`, background: ready ? C.sicher : C.learning, borderRadius: 99 }} />
      </div>
      <span style={{ width: 34, textAlign: "right", fontSize: 12, fontWeight: 700, color: ready ? C.sicher : "var(--ink-soft)" }}>{s.pct}%</span>
      {ready ? <span style={{ fontSize: 11, fontWeight: 600, color: C.sicher, width: 58 }}>✓ bereit</span> : <span style={{ width: 58 }} />}
    </div>
  );
}

function FolderReadiness({ readiness }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(() => new Set());

  const q = search.trim().toLowerCase();
  const filtered = q ? readiness.filter((f) => (f.name || "").toLowerCase().includes(q)) : readiness;
  const pages = Math.max(1, Math.ceil(filtered.length / FOLDER_PAGE));
  const pg = Math.min(page, pages - 1);
  const paged = filtered.slice(pg * FOLDER_PAGE, pg * FOLDER_PAGE + FOLDER_PAGE);
  const toggle = (fid) => setExpanded((prev) => { const n = new Set(prev); n.has(fid) ? n.delete(fid) : n.add(fid); return n; });

  return <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
    {readiness.length > FOLDER_PAGE && (
      <input placeholder="🔍 Ordner suchen…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }}
        style={{ width: "100%", padding: "9px 12px", border: "1.5px solid var(--ivory-dark)", borderRadius: 8, fontSize: 13, background: "var(--ivory)", outline: "none", fontFamily: "inherit" }} />
    )}
    {filtered.length === 0 && <div className="transfer-empty">Keine Treffer.</div>}
    {paged.map((f) => {
      const readyCount = f.students.filter((s) => s.pct >= READY_PCT).length;
      const open = expanded.has(f.folderId);
      return (
        <div key={f.folderId} style={{ background: "white", borderRadius: 10, boxShadow: "0 1px 4px rgba(0,0,0,.06)", overflow: "hidden" }}>
          <button onClick={() => toggle(f.folderId)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
            <span style={{ fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.icon} {f.name}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: readyCount > 0 ? C.sicher : "var(--ink-soft)", whiteSpace: "nowrap" }}>{readyCount}/{f.students.length} bereit</span>
            <span style={{ fontSize: 11, color: "var(--ink-soft)", width: 12, textAlign: "center" }}>{open ? "▲" : "▼"}</span>
          </button>
          {open && (
            <div style={{ padding: "0 14px 12px", display: "flex", flexDirection: "column", gap: 7 }}>
              {f.students.map((s) => <FolderStudentRow key={s.uid} s={s} />)}
            </div>
          )}
        </div>
      );
    })}
    {filtered.length > FOLDER_PAGE && (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 4 }}>
        <button className="btn-sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={pg <= 0}>‹ Zurück</button>
        <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>Seite {pg + 1} / {pages}</span>
        <button className="btn-sm" onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={pg >= pages - 1}>Weiter ›</button>
      </div>
    )}
  </div>;
}

export function ProgressTab({ session }) {
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [classId, setClassId] = useState(null);
  const [report, setReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [expandedUid, setExpandedUid] = useState(null);
  const [details, setDetails] = useState({});
  const [detailLoading, setDetailLoading] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [classPage, setClassPage] = useState(0);
  const [classSearch, setClassSearch] = useState("");

  useEffect(() => {
    (async () => {
      const cs = await loadAllClasses();
      setClasses(cs);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!classId) {
      setReport(null); setError(""); setExpandedUid(null); setDetails({}); setShowAll(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setReportLoading(true); setError(""); setReport(null);
      setExpandedUid(null); setDetails({}); setShowAll(false);
      try {
        const r = await getProgressReport(classId, { fresh: refreshKey > 0 });
        if (!cancelled) setReport(r);
      } catch (e) {
        if (!cancelled) setError(e.message || "Bericht konnte nicht geladen werden.");
      } finally {
        if (!cancelled) setReportLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [classId, refreshKey]);

  async function refresh() {
    clearDataCache();
    try {
      const cs = await loadAllClasses();
      setClasses(cs);
      if (classId && !cs.some((c) => c.id === classId)) setClassId(null);
    } catch {}
    setRefreshKey((k) => k + 1);
  }

  async function toggleDetail(uid) {
    if (expandedUid === uid) { setExpandedUid(null); return; }
    setExpandedUid(uid);
    if (details[uid]) return;
    setDetailLoading(uid);
    try {
      const r = await getStudentProgressDetail(classId, uid);
      setDetails((d) => ({ ...d, [uid]: {
        words: r.words || [], folders: r.folders || {}, activity: r.activity || {},
        privateWords: r.privateWords || [], privateFolders: r.privateFolders || {},
      } }));
    } catch (e) {
      setDetails((d) => ({ ...d, [uid]: { error: e.message || "Fehler" } }));
    } finally {
      setDetailLoading(null);
    }
  }

  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  if (classes.length === 0) {
    return <div className="empty" style={{ padding: 28 }}>
      <div className="emoji">📊</div>
      <h3>Noch keine Kurse</h3>
      <p style={{ fontSize: 14 }}>Erstelle zuerst einen Kurs im Tab „Kurse", um den Lernfortschritt zu sehen.</p>
    </div>;
  }

  const agg = report?.aggregate;
  const dist = agg?.distribution;
  const rows = report?.students || [];
  const withFlags = rows.map((r) => ({ r, flags: flagsFor(r) }));

  const now = report?.generatedAt || Date.now();
  const assignedRows = rows.filter((r) => r.assigned > 0);

  const backlogOf = (r) => Math.max(0, r.due - r.neu);
  const classBacklog = assignedRows.reduce((s, r) => s + backlogOf(r), 0);
  const attention = assignedRows
    .map((r) => ({ r, risk: riskFor(r, now) }))
    .filter((x) => x.risk.score >= RISK_MIN)
    .sort((a, b) => b.risk.score - a.risk.score);
  const attentionUids = new Set(attention.map((x) => x.r.uid));

  const studentsWithHardColloc = assignedRows
    .filter((r) => (r.collocHard || 0) > 0)
    .sort((a, b) => (b.collocHard || 0) - (a.collocHard || 0) || a.username.localeCompare(b.username));
  const others = withFlags
    .filter((x) => !attentionUids.has(x.r.uid))
    .map((x) => ({ ...x, risk: x.r.assigned > 0 ? riskFor(x.r, now).score : null }))
    .sort((a, b) => (b.risk ?? -1) - (a.risk ?? -1) || a.r.username.localeCompare(b.r.username));
  const otherLabel = attention.length === 0 ? "Alle Schüler" : "Übrige Schüler";

  // Trefferquote and Übungskonstanz come from meta/activity, which is never
  // folder-scoped. They are aggregated over the whole roster on purpose: a student
  // whose folders were unassigned must not take their practice history with them.
  const totReviews = rows.reduce((s, r) => s + (r.reviews30 || 0), 0);
  const totCorrect = rows.reduce((s, r) => s + (r.correct30 || 0), 0);
  const classAcc = totReviews >= 10 ? Math.round((totCorrect / totReviews) * 100) : null;
  const trendRows = assignedRows.filter((r) => (r.trendSamples || 0) >= 2 && r.trendDelta != null);
  const classTrend = trendRows.length ? Math.round(trendRows.reduce((s, r) => s + r.trendDelta, 0) / trendRows.length) : null;

  const coverage = (report?.readiness || []).map((f) => {
    const assignedSum = f.students.reduce((s, x) => s + x.assigned, 0);
    const sicherSum = f.students.reduce((s, x) => s + x.mastered, 0);
    return { folderId: f.folderId, name: f.name, icon: f.icon, students: f.students.length, pct: assignedSum ? Math.round((sicherSum / assignedSum) * 100) : 0 };
  }).sort((a, b) => a.pct - b.pct);

  const streakLeaders = rows.filter((r) => (r.streak || 0) > 0).sort((a, b) => b.streak - a.streak);
  const practice = agg?.practice;
  const hasActivity = rows.some((r) => (r.reviews30 || 0) > 0) || streakLeaders.length > 0 || (practice?.days || []).some((d) => d.active > 0);

  function StudentRow({ r, flags, badge, risk }) {
    const expanded = expandedUid === r.uid;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="word-item" style={{ cursor: "pointer", flexWrap: "wrap", rowGap: 8 }} onClick={() => toggleDetail(r.uid)}>
          {risk != null && (
            <span title={`Aufmerksamkeits-Score ${risk} von 100 — je höher, desto dringender.\nKombiniert Lernstand, Trefferquote, Trend, Rückfälle, schwierige Wörter, Rückstände und Inaktivität.\nAb 60 rot, ab 40 gelb.`}
              style={{ fontSize: 12, fontWeight: 800, color: "white", background: riskColor(risk), borderRadius: 8, padding: "2px 7px", minWidth: 26, textAlign: "center", flexShrink: 0, alignSelf: "flex-start", cursor: "help" }}>{risk}</span>
          )}
          <div style={{ flex: "1 1 140px", minWidth: 120 }}>
            <div className="wi-de">{r.username}</div>
            <div style={{ marginTop: 6 }}><StateBar {...r} height={8} /></div>
          </div>
          {flags.length > 0 && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{flags.map((f) => <span key={f} style={{ ...flagChip, cursor: "help" }} title={reasonHelp(f)}>{f}</span>)}</div>
          )}
          {badge && <span title={reasonHelp(badge)} style={{ ...flagChip, cursor: reasonHelp(badge) ? "help" : "default" }}>{badge}</span>}
          <TrendArrow delta={r.trendDelta} samples={r.trendSamples} />
          <span style={{ fontSize: 13, fontWeight: 700, color: C.sicher, width: 40, textAlign: "right" }}>{r.pct}%</span>
          <span style={{ fontSize: 11, color: "var(--ink-soft)", width: 12, textAlign: "center" }}>{expanded ? "▲" : "▼"}</span>
        </div>
        {expanded && <DetailPanel r={r} data={details[r.uid]} loading={detailLoading === r.uid} />}
      </div>
    );
  }

  const classQuery = classSearch.trim().toLowerCase();
  const filteredClasses = classQuery ? classes.filter((c) => (c.name || "").toLowerCase().includes(classQuery)) : classes;
  const classPages = Math.max(1, Math.ceil(filteredClasses.length / CLASS_PAGE));
  const clPg = Math.min(classPage, classPages - 1);
  const pagedClasses = filteredClasses.slice(clPg * CLASS_PAGE, clPg * CLASS_PAGE + CLASS_PAGE);
  const showClassPager = filteredClasses.length > CLASS_PAGE;
  const showClassSearch = classes.length > CLASS_PAGE;

  return (<>
    <div className="sec-label">Kurs auswählen</div>
    {showClassSearch && (
      <input placeholder="🔍 Kurs suchen…" value={classSearch}
        onChange={(e) => { setClassSearch(e.target.value); setClassPage(0); }}
        style={{ width: "100%", padding: "9px 12px", border: "1.5px solid var(--ivory-dark)", borderRadius: 8, fontSize: 13, background: "white", outline: "none", fontFamily: "inherit", marginBottom: 10 }} />
    )}
    {filteredClasses.length === 0 ? (
      <div className="transfer-empty" style={{ marginBottom: 20 }}>Keine Treffer.</div>
    ) : (<>
      <div className="folder-grid" style={{ marginBottom: showClassPager ? 8 : 20 }}>
        {pagedClasses.map((c) => (
          <div key={c.id} className={`folder-card${classId === c.id ? " active" : ""}`}
            onClick={() => setClassId((s) => (s === c.id ? null : c.id))}>
            <div className="folder-icon">{c.icon}</div>
            <div className="folder-name">{c.name}</div>
            <div className="folder-count">{(c.memberUids || []).length} Schüler</div>
          </div>
        ))}
      </div>
      {showClassPager && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginBottom: 20 }}>
          <button className="btn-sm" onClick={() => setClassPage((p) => Math.max(0, p - 1))} disabled={clPg <= 0}>‹ Zurück</button>
          <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>Seite {clPg + 1} / {classPages}</span>
          <button className="btn-sm" onClick={() => setClassPage((p) => Math.min(classPages - 1, p + 1))} disabled={clPg >= classPages - 1}>Weiter ›</button>
        </div>
      )}
    </>)}

    {!classId && (
      <div className="empty" style={{ padding: 20 }}>
        <p>Wähle oben einen Kurs, um den Lernfortschritt zu sehen.</p>
      </div>
    )}

    {classId && (
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <button className="btn-sm" onClick={refresh} disabled={reportLoading} title="Daten neu laden">
          {reportLoading ? "⏳ Lädt…" : "🔄 Aktualisieren"}
        </button>
      </div>
    )}

    {reportLoading && <div className="loading"><div className="spinner" /><br />Bericht wird erstellt…</div>}
    {error && <p className="err">⚠ {error}</p>}

    {report && !reportLoading && (<>
      {}
      <div className="sec-label">Klassenübersicht</div>
      {rows.length === 0 ? (
        <div className="empty" style={{ padding: 20, marginBottom: 20 }}>
          <p>Noch keine Schüler in diesem Kurs.</p>
        </div>
      ) : (
        <div style={{ background: "white", borderRadius: 10, padding: "14px 15px", boxShadow: "0 1px 4px rgba(0,0,0,.06)", marginBottom: 20 }}>
          {!dist || dist.assigned === 0 ? (
            <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>
              Diesem Kurs sind aktuell keine Wörter zugewiesen — weise im Tab Kurse Ordner oder Wörter zu.
              Trefferquote, Übungskonstanz und schwierige Wörter bleiben erhalten.
            </p>
          ) : (<>
            <StateBar {...dist} height={16} />
            <Legend dist={dist} />
            {classTrend != null && (
              <div style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 12 }}>
                Klassentrend <TrendArrow delta={classTrend} samples={2} /> {classTrend > 0 ? `+${classTrend}` : classTrend} Pp
              </div>
            )}
          </>)}
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <Kpi label="Aktiv · 7 Tage" value={`${agg.activeStudents}/${rows.length}`} />
            <Kpi label="Trefferquote 30 T." value={classAcc == null ? "–" : `${classAcc}%`}
              tone={classAcc == null ? undefined : classAcc >= 70 ? C.sicher : classAcc >= 50 ? C.learning : C.struggle} />
            <Kpi label="Fällige Wiederh." value={classBacklog} tone={classBacklog > 0 ? C.learning : C.sicher} />
            <Kpi label="Übt heute" value={practice ? practice.days[practice.days.length - 1].active : "–"} />
          </div>
        </div>
      )}

      {rows.length > 0 && (<>
        {}
        <div className="sec-label" style={{ fontSize: 10, letterSpacing: ".4px" }}>Übungskonstanz</div>
        {!hasActivity ? (
          <p style={mutedP}>Übungsdaten werden ab jetzt erfasst — Serien erscheinen, sobald Schüler üben.</p>
        ) : (
          <div style={cardBox}>
            <PracticeStrip practice={practice} totalStudents={assignedRows.length} />
            {streakLeaders.length > 0 && <StreakLeaders rows={streakLeaders} />}
          </div>
        )}

        <div style={{ borderTop: "1.5px solid var(--ivory-dark)", margin: "22px 0" }} />

        {}
        <div className="sec-label">Braucht Aufmerksamkeit ({attention.length})</div>
        {attention.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 16 }}>👍 Aktuell braucht niemand besondere Aufmerksamkeit.</p>
        ) : (<>
          <p style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 10 }}>
            Nach Dringlichkeit (0–100): Lernstand, Trefferquote, Trend, Rückfälle, Rückstände und Inaktivität kombiniert. Der Text nennt den Hauptgrund.
          </p>
          <div className="word-list" style={{ marginBottom: 12 }}>
            {attention.map(({ r, risk }) => <StudentRow key={r.uid} r={r} risk={risk.score} flags={[]} badge={risk.reason} />)}
          </div>
        </>)}

        <div className="sec-label" style={{ marginTop: 18 }}>🔗 Schwierige Wortverbindungen — Schüler ({studentsWithHardColloc.length})</div>
        {studentsWithHardColloc.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 16 }}>👍 Keine Schüler mit schwierigen Wortverbindungen.</p>
        ) : (
          <div className="word-list" style={{ marginBottom: 12 }}>
            {studentsWithHardColloc.map((r) => (
              <div key={r.uid} className="word-item" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
                  <div className="wi-text">
                    <div className="wi-de">{r.username}</div>
                    <div className="wi-ru">{r.collocHard} schwierige Verbindung{r.collocHard !== 1 ? "en" : ""} · {r.collocMastered || 0}/{r.collocTotal || 0} gefestigt</div>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.struggle, whiteSpace: "nowrap" }}>{r.collocHard}</span>
                </div>
                {r.collocHardWords && r.collocHardWords.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 10px", fontSize: 12 }}>
                    {r.collocHardWords.map((w) => (
                      <span key={w.wordId} style={{ color: "var(--ink-soft)", background: "var(--ivory-dark)", padding: "2px 8px", borderRadius: 12 }}>
                        {w.article && <span style={{ color: "var(--accent)", fontStyle: "italic" }}>{w.article} </span>}
                        {w.de || w.wordId}
                        <span style={{ color: C.struggle, marginLeft: 5, fontWeight: 700 }}>×{w.nm}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <button className="btn-sm" style={{ marginBottom: 22 }} onClick={() => setShowAll((s) => !s)}>
          {showAll ? `▲ ${otherLabel} ausblenden` : `▾ ${otherLabel} (${others.length})`}
        </button>
        {showAll && (
          <div className="word-list" style={{ marginBottom: 22 }}>
            {others.length === 0
              ? <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>Keine weiteren Schüler.</p>
              : others.map(({ r, flags, risk }) => <StudentRow key={r.uid} r={r} flags={flags} risk={risk} />)}
          </div>
        )}

        <div style={{ borderTop: "1.5px solid var(--ivory-dark)", margin: "22px 0" }} />

        {}
        <div className="sec-label">Ordner-Abdeckung</div>
        {coverage.length === 0 ? (
          <p style={mutedP}>Keine Kurs-Ordner mit zugewiesenen Wörtern.</p>
        ) : (
          <div style={{ marginBottom: 22 }}>
            <p style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 10 }}>Klassenweit gefestigte Karten je Ordner — schwächste zuerst.</p>
            <CoverageHeatmap coverage={coverage} />
          </div>
        )}

        {}
        <div className="sec-label">Bereit für den nächsten Ordner</div>
        {(report.readiness || []).length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 22 }}>Keine Kurs-Ordner mit zugewiesenen Wörtern.</p>
        ) : (
          <div style={{ marginBottom: 22 }}>
            <FolderReadiness key={classId} readiness={report.readiness} />
          </div>
        )}

        <div style={{ borderTop: "1.5px solid var(--ivory-dark)", margin: "22px 0" }} />

        {}
        <div className="sec-label">Schwierige Wörter</div>
        {report.hardWords.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>Noch keine schwierigen Wörter — sie erscheinen, sobald Schüler ein Wort mehrmals falsch beantworten (≥ 3× „Nochmal").</p>
        ) : (
          <StruggleChart hardWords={report.hardWords} />
        )}
        {(report.hardPrivateWords || []).length > 0 && <PrivateStruggleList rows={report.hardPrivateWords} />}

        {}
        <div className="sec-label" style={{ marginTop: 22 }}>🔗 Schwierige Wortverbindungen</div>
        <WeakCollocations key={`${classId}:${refreshKey}`} classId={classId} />
      </>)}

      <p style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 22, textAlign: "right" }}>
        Stand: {new Date(report.generatedAt).toLocaleString("de-DE")}
      </p>
    </>)}
  </>);
}

function WordChip({ w, hard }) {
  return (
    <span style={{ fontSize: 12, padding: "3px 9px", borderRadius: 99, background: "white", border: `1px solid ${hard ? "var(--red-soft)" : "var(--ivory-dark)"}`, color: "var(--ink)" }}>
      {w.hard && <span title={"oft vergessen (≥ 3× Nochmal)"}>⚠ </span>}
      {w.article && <span style={{ color: "var(--accent)", fontStyle: "italic" }}>{w.article} </span>}{w.de}
    </span>
  );
}

function LapseChip({ w }) {
  return (
    <span style={{ fontSize: 12, padding: "3px 9px", borderRadius: 99, background: "white", border: "1px solid var(--ivory-dark)", color: "var(--ink)" }}
      title={`${w.lapses}× seit dem letzten Festigen vergessen${(w.lapsesTotal || 0) > w.lapses ? ` · insgesamt ${w.lapsesTotal}×` : ""}`}>
      {w.article && <span style={{ color: "var(--accent)", fontStyle: "italic" }}>{w.article} </span>}{w.de}
      <span style={{ color: C.learning, fontWeight: 700 }}> ↓{w.lapses}</span>
      {(w.lapsesTotal || 0) > w.lapses && <span style={{ color: "var(--ink-soft)", fontWeight: 600 }}> · insg. {w.lapsesTotal}×</span>}
    </span>
  );
}

function DetailPanel({ data, loading }) {
  const [openFolders, setOpenFolders] = useState(() => new Set());
  const toggleFolder = (fid) => setOpenFolders((prev) => { const n = new Set(prev); n.has(fid) ? n.delete(fid) : n.add(fid); return n; });
  if (loading) return <div style={panelBox}><span style={{ fontSize: 13, color: "var(--ink-soft)" }}>Lädt…</span></div>;
  if (data?.error) return <div style={panelBox}><span className="err">⚠ {data.error}</span></div>;
  if (!data || !Array.isArray(data.words)) return null;
  const { words, folders = {}, privateWords = [], privateFolders = {} } = data;
  if (words.length === 0 && privateWords.length === 0) {
    return <div style={panelBox}><span style={{ fontSize: 13, color: "var(--ink-soft)" }}>Keine zugewiesenen Wörter.</span></div>;
  }

  const byFolder = new Map();
  for (const w of words) {
    const fid = w.folderId || "__none";
    let grp = byFolder.get(fid);
    if (!grp) { grp = { schwierig: [], amLernen: [], fastSicher: [], neu: [], sicher: [] }; byFolder.set(fid, grp); }
    if (w.mastered) grp.sicher.push(w);
    else if (!w.started) grp.neu.push(w);
    else if (w.hard) grp.schwierig.push(w);
    else if (w.level === 2) grp.fastSicher.push(w);
    else grp.amLernen.push(w);
  }
  const entries = [...byFolder.entries()].sort((a, b) => {
    if (a[0] === "__none") return 1;
    if (b[0] === "__none") return -1;
    return (folders[a[0]]?.name || "").localeCompare(folders[b[0]]?.name || "");
  });

  const isStruggling = (w) => w.started && !w.mastered && w.level <= 1 && w.hard;
  const struggling = words.filter(isStruggling);
  const strugglingPrivate = privateWords.filter(isStruggling);
  const strugByFolder = new Map();
  for (const w of struggling) {
    const fid = w.folderId || "__none";
    if (!strugByFolder.has(fid)) strugByFolder.set(fid, []);
    strugByFolder.get(fid).push(w);
  }
  const strugEntries = [...strugByFolder.entries()].sort((a, b) => {
    if (a[0] === "__none") return 1;
    if (b[0] === "__none") return -1;
    return (folders[a[0]]?.name || "").localeCompare(folders[b[0]]?.name || "");
  });
  const folderMetaOf = (fid) => fid === "__none" ? { name: "Ohne Ordner", icon: "📄" } : (folders[fid] || { name: "Ordner", icon: "📁" });

  const byLapses = (a, b) => b.lapses - a.lapses;
  const regressed = words.filter((w) => (w.lapses || 0) >= 1).sort(byLapses);
  const regressedPrivate = privateWords.filter((w) => (w.lapses || 0) >= 1).sort(byLapses);
  const privateNote = { fontSize: 11, fontWeight: 600, color: "var(--ink-soft)", marginTop: 8, marginBottom: 4 };

  return (
    <div style={panelBox}>
      {data.activity && Object.keys(data.activity).length > 0 && <StudentCalendar days={data.activity} />}
      {data.activity && <AccuracySpark days={data.activity} />}
      {regressed.length + regressedPrivate.length > 0 && (
        <div style={{ marginBottom: 14, padding: "11px 13px", background: "var(--ivory)", borderRadius: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 9 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: C.learning, flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>
              Gelerntes rutscht ab — {regressed.length + regressedPrivate.length} {regressed.length + regressedPrivate.length === 1 ? "Wort" : "Wörter"}
            </span>
          </div>
          {regressed.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {regressed.map((w) => <LapseChip key={w.wordId} w={w} />)}
            </div>
          )}
          {regressedPrivate.length > 0 && (<>
            <div style={privateNote}>🔒 privat</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {regressedPrivate.map((w) => <LapseChip key={w.wordId} w={w} />)}
            </div>
          </>)}
        </div>
      )}
      {struggling.length + strugglingPrivate.length > 0 && (
        <div style={{ marginBottom: 14, padding: "11px 13px", background: "var(--red-pale)", borderRadius: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 9 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: C.struggle, flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--red-soft)" }}>
              Wo es hakt — {struggling.length + strugglingPrivate.length} {struggling.length + strugglingPrivate.length === 1 ? "Wort" : "Wörter"}
            </span>
          </div>
          {strugEntries.map(([fid, list]) => {
            const meta = folderMetaOf(fid);
            return (
              <div key={fid} style={{ marginBottom: 7 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-soft)", marginBottom: 4 }}>{meta.icon} {meta.name}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {list.map((w) => <WordChip key={w.wordId} w={w} hard />)}
                </div>
              </div>
            );
          })}
          {strugglingPrivate.length > 0 && (
            <div style={{ marginBottom: 7 }}>
              <div style={privateNote}>🔒 Eigene Wörter · privat</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {strugglingPrivate.map((w) => <WordChip key={w.wordId} w={w} hard />)}
              </div>
            </div>
          )}
        </div>
      )}
      {words.length === 0 && (
        <div style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 4 }}>Keine zugewiesenen Kurswörter.</div>
      )}
      {entries.map(([fid, grp]) => {
        const meta = fid === "__none" ? { name: "Ohne Ordner", icon: "📄" } : (folders[fid] || { name: "Ordner", icon: "📁" });
        let barS = 0, barF = 0, barL = 0, barN = 0;
        for (const w of [...grp.sicher, ...grp.fastSicher, ...grp.amLernen, ...grp.schwierig, ...grp.neu]) {
          if (w.mastered) barS++;
          else if (!w.started) barN++;
          else if (w.level === 2) barF++;
          else barL++;
        }
        const total = barS + barF + barL + barN;
        const groups = [
          ["Schwierig", grp.schwierig, C.struggle],
          ["Am Lernen", grp.amLernen, C.learning],
          ["Neu", grp.neu, C.neu],
          ["Fast sicher", grp.fastSicher, C.fastSicher],
          ["Sicher", grp.sicher, C.sicher],
        ];
        const open = openFolders.has(fid);
        return (
          <div key={fid} style={{ marginBottom: 12 }}>
            {}
            <button onClick={() => toggleFolder(fid)} aria-pressed={open}
              style={{ width: "100%", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left", padding: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{meta.icon} {meta.name}</span>
                <span style={{ fontSize: 11, color: "var(--ink-soft)", whiteSpace: "nowrap" }}>{barS}/{total} gefestigt</span>
                <span style={{ fontSize: 11, color: "var(--ink-soft)", width: 12, textAlign: "center" }}>{open ? "▲" : "▼"}</span>
              </div>
              <StateBar sicher={barS} fastSicher={barF} learning={barL} neu={barN} assigned={total} height={8} />
            </button>
            {open && (
              <div style={{ marginTop: 8 }}>
                {groups.filter(([, list]) => list.length).map(([label, list, color]) => (
                  <div key={label} style={{ marginBottom: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 3, background: color, flexShrink: 0 }} />
                      <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-soft)" }}>{label} ({list.length})</span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                      {list.map((w) => <WordChip key={w.wordId} w={w} hard={label === "Schwierig"} />)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {privateWords.length > 0 && <PrivateWordsSection words={privateWords} folders={privateFolders} />}
    </div>
  );
}

const panelBox = { background: "var(--ivory)", borderRadius: 10, padding: "12px 13px" };

function Kpi({ label, value, tone }) {
  return (
    <div style={{ flex: 1, background: "var(--ivory)", borderRadius: 8, padding: "8px 10px", textAlign: "center", minWidth: 0 }}>
      <div style={{ fontSize: 18, fontWeight: 800, color: tone || "var(--ink)" }}>{value}</div>
      <div style={{ fontSize: 10.5, color: "var(--ink-soft)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
    </div>
  );
}

function CoverageHeatmap({ coverage }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {coverage.map((f) => (
        <div key={f.folderId} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 130, flexShrink: 0, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={`${f.name} · ${f.students} Schüler`}>{f.icon} {f.name}</span>
          <div style={{ flex: 1, height: 15, background: "var(--ivory-dark)", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${f.pct}%`, minWidth: f.pct > 0 ? 4 : 0, background: heatGreen(f.pct / 100), borderRadius: 4 }}
              title={`${f.pct}% der Karten klassenweit gefestigt · ${f.students} Schüler`} />
          </div>
          <span style={{ width: 40, textAlign: "right", fontSize: 12, fontWeight: 700, color: pctStatus(f.pct) }}>{f.pct}%</span>
        </div>
      ))}
    </div>
  );
}

function PracticeStrip({ practice, totalStudents }) {
  if (!practice || !practice.days.length) return null;
  const max = Math.max(1, ...practice.days.map((d) => d.active));
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 6 }}>Übende Schüler pro Tag · letzte {practice.windowDays} Tage</div>
      <div style={{ display: "flex", gap: 2 }}>
        {practice.days.map((d) => (
          <div key={d.key} title={`${fmtDay(d.key)}: ${d.active} von ${totalStudents} aktiv`}
            style={{ flex: 1, height: 26, borderRadius: 3, background: d.active ? heatGreen(d.active / max) : "var(--ivory-dark)" }} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--ink-soft)", marginTop: 4 }}>
        <span>{fmtDay(practice.days[0].key)}</span><span>heute</span>
      </div>
    </div>
  );
}

function StreakLeaders({ rows }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-soft)", marginBottom: 7 }}>🔥 Aktuelle Serien</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {rows.slice(0, 12).map((r) => (
          <span key={r.uid} style={{ fontSize: 12, padding: "3px 9px", borderRadius: 99, background: "var(--sage-pale)", color: "var(--sage)", fontWeight: 600 }}>
            {r.username} · {r.streak} {r.streak === 1 ? "Tag" : "Tage"}
          </span>
        ))}
      </div>
    </div>
  );
}

function TrendArrow({ delta, samples }) {
  const base = { width: 14, textAlign: "center", flexShrink: 0, fontSize: 12 };
  if (!(samples >= 2) || delta == null) return <span style={{ ...base, color: "var(--ink-soft)" }} title="Noch kein Trend">·</span>;
  if (delta >= 5) return <span style={{ ...base, color: C.sicher, fontWeight: 700 }} title={`+${delta} Pp vs. vor ~3 Wochen — steigend`}>↑</span>;
  if (delta <= -5) return <span style={{ ...base, color: C.struggle, fontWeight: 700 }} title={`${delta} Pp vs. vor ~3 Wochen — fallend`}>↓</span>;
  return <span style={{ ...base, color: "var(--ink-soft)" }} title={`${delta >= 0 ? "+" : ""}${delta} Pp — stabil`}>→</span>;
}

function AccuracySpark({ days }) {
  const N = 30;
  const todayMs = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const cells = [];
  let totR = 0, totC = 0;
  for (let i = N - 1; i >= 0; i--) {
    const key = new Date(todayMs - i * 86400000).toISOString().slice(0, 10);
    const d = days[key] || {};
    const r = d.r || 0, c = d.c || 0;
    totR += r; totC += c;
    cells.push({ key, r, acc: r ? c / r : null });
  }
  if (totR === 0) return null;
  const accPct = Math.round((totC / totR) * 100);
  const col = (a) => (a >= 0.7 ? C.sicher : a >= 0.5 ? C.learning : C.struggle);
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-soft)", marginBottom: 6 }}>
        Trefferquote · 30 Tage <b style={{ color: col(accPct / 100) }}>{accPct}%</b> <span style={{ fontWeight: 400 }}>({totC}/{totR})</span>
      </div>
      <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 30 }}>
        {cells.map((c) => (
          <div key={c.key} title={c.r ? `${fmtDay(c.key)}: ${Math.round(c.acc * 100)}% (${c.r} Übungen)` : `${fmtDay(c.key)}: keine Übung`}
            style={{ flex: 1, height: c.acc == null ? 3 : `${Math.max(10, c.acc * 100)}%`, minHeight: 3, borderRadius: 2,
              background: c.acc == null ? "var(--ivory-dark)" : col(c.acc), opacity: c.acc == null ? 1 : 0.45 + 0.55 * Math.min(1, c.r / 5) }} />
        ))}
      </div>
    </div>
  );
}

function StudentCalendar({ days }) {
  const WEEKS = 8, N = WEEKS * 7;
  const todayMs = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const cells = [];
  let max = 1;
  for (let i = N - 1; i >= 0; i--) {
    const key = new Date(todayMs - i * 86400000).toISOString().slice(0, 10);
    const r = (days[key] && days[key].r) || 0;
    if (r > max) max = r;
    cells.push({ key, r });
  }
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-soft)", marginBottom: 6 }}>Übungskalender · 8 Wochen</div>
      <div style={{ display: "flex", gap: 3 }}>
        {Array.from({ length: WEEKS }, (_, w) => (
          <div key={w} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {cells.slice(w * 7, w * 7 + 7).map((c) => (
              <div key={c.key} title={`${fmtDay(c.key)}: ${c.r} ${c.r === 1 ? "Wiederholung" : "Wiederholungen"}`}
                style={{ width: 12, height: 12, borderRadius: 3, background: c.r ? heatGreen(c.r / max) : "var(--ivory-dark)" }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
