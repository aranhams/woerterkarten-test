import { useState, useEffect } from "react";
import { classSync } from "../lib/api";
import { loadMyClasses } from "../data/loaders";
import { clearDataCache } from "../data/cache";

export function JoinClass({ session }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [myClasses, setMyClasses] = useState(null);

  useEffect(() => {
    (async () => {
      try { setMyClasses(await loadMyClasses(session.uid)); }
      catch { setMyClasses([]); }
    })();
  }, []);

  async function join() {
    const c = code.trim();
    if (!c || busy) return;
    setBusy(true); setMsg("");
    try {
      const r = await classSync("join", { code: c });
      clearDataCache();
      setMsg(`✓ „${r.name || "Kurs"}" beigetreten`);
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      setMsg("⚠ " + (e.message || "Fehler"));
      setBusy(false);
    }
  }

  const wrapStyle = { padding: "8px 10px", borderBottom: "1px solid var(--ivory-dark)", marginBottom: 6 };

  if (myClasses === null) return null;

  if (myClasses.length > 0) {
    return (
      <div style={wrapStyle}>
        <div className="user-menu-sub" style={{ marginBottom: 6 }}>{myClasses.length > 1 ? "Deine Kurse" : "Dein Kurs"}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {myClasses.map((c) => (
            <span key={c.id} style={{ background: "var(--sage-pale)", color: "var(--sage)", padding: "4px 10px", borderRadius: 99, fontSize: 13, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
              {c.icon} {c.name}
            </span>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={wrapStyle}>
      <div className="user-menu-sub" style={{ marginBottom: 6 }}>Kurs beitreten</div>
      <div style={{ display: "flex", gap: 6 }}>
        <input value={code} maxLength={32} placeholder="Kurs-Code"
          onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && join()}
          style={{ flex: 1, minWidth: 0, padding: "7px 9px", border: "1.5px solid var(--ivory-dark)", borderRadius: 7, fontSize: 13, background: "var(--ivory)", outline: "none", fontFamily: "inherit", textTransform: "uppercase" }} />
        <button className="btn-add" onClick={join} disabled={!code.trim() || busy} style={{ padding: "7px 12px" }}>
          {busy ? "…" : "→"}
        </button>
      </div>
      {msg && <div style={{ fontSize: 12, marginTop: 6, color: msg[0] === "✓" ? "var(--sage)" : "var(--red-soft)" }}>{msg}</div>}
    </div>
  );
}
