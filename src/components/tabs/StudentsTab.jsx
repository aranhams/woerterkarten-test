import { useState, useEffect } from "react";
import { classSync } from "../../lib/api";
import { loadAllClasses } from "../../data/loaders";
import { clearDataCache } from "../../data/cache";

export function StudentsTab({ session }) {
  const [roster, setRoster] = useState([]);
  const [classes, setClasses] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [resetInfo, setResetInfo] = useState(null);

  useEffect(() => {
    (async () => {
      clearDataCache();
      try {
        const [r, cs] = await Promise.all([classSync("list-students"), loadAllClasses()]);
        setRoster(r.students || []); setClasses(cs);
      } catch {}
      setLoading(false);
    })();
  }, []);

  function flash(m) { setMsg(m); setTimeout(() => setMsg(""), 3000); }
  function copyText(text) { navigator.clipboard?.writeText(text).then(() => flash("✓ Kopiert")).catch(() => {}); }

  async function resetPassword(s) {
    if (!confirm(`Passwort für „${s.username}" zurücksetzen?`)) return;
    setBusy(true);
    try {
      const r = await classSync("reset-student-password", { uid: s.uid });
      setResetInfo({ uid: s.uid, password: r.password });
    } catch (e) { flash("⚠ " + (e.message || "Fehler")); }
    finally { setBusy(false); }
  }

  const classNamesOf = (uid) => classes.filter((c) => (c.memberUids || []).includes(uid)).map((c) => c.name);
  const q = search.trim().toLowerCase();
  const filtered = roster.filter((s) => !q || s.username.toLowerCase().includes(q));

  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  return (<>
    <div className="add-form">
      <h3>👤 Schüler</h3>
      <input placeholder="🔍 Schüler suchen…" value={search} onChange={(e) => setSearch(e.target.value)}
        style={{ width: "100%", padding: "9px 12px", border: "1.5px solid var(--ivory-dark)", borderRadius: 8, fontSize: 13, background: "var(--ivory)", outline: "none", fontFamily: "inherit" }} />
      {msg && <p className={msg[0] === "✓" ? "ok" : "err"} style={{ marginTop: 8 }}>{msg}</p>}
    </div>

    <div className="sec-label">Alle Schüler ({filtered.length})</div>
    <div className="word-list">
      {filtered.length === 0 && <div className="empty" style={{ padding: 24 }}><p>{roster.length === 0 ? "Keine registrierten Schüler." : "Keine Treffer."}</p></div>}
      {filtered.map((s) => {
        const cls = classNamesOf(s.uid);
        return (
          <div className="word-item" key={s.uid} style={{ flexDirection: "column", alignItems: "stretch", gap: 9 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="wi-text">
                <div className="wi-de">{s.username}</div>
                <div className="wi-ru">{cls.length ? cls.join(", ") : "Kein Kurs"}</div>
              </div>
              <button className="btn-sm" onClick={() => resetPassword(s)} disabled={busy}>🔑 Passwort</button>
            </div>
            {resetInfo?.uid === s.uid && (
              <div style={{ background: "var(--accent-pale)", border: "1.5px solid var(--accent)", borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--accent)" }}>Neues Passwort</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                  <code style={{ fontSize: 17, fontWeight: 700, letterSpacing: 1, background: "white", padding: "4px 10px", borderRadius: 6 }}>{resetInfo.password}</code>
                  <button className="btn-sm" onClick={() => copyText(resetInfo.password)}>📋 Kopieren</button>
                  <button className="btn-sm" onClick={() => setResetInfo(null)}>Schließen</button>
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 6 }}>Gib dieses Passwort dem Schüler. Er kann es später selbst im Menü ändern.</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  </>);
}
