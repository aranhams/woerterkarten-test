import { useState, useEffect } from "react";
import { adminSync } from "../../lib/api";

export function AdminTab() {
  const [code, setCode] = useState("");
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const r = await adminSync("get-teacher-code");
        setCode(r.code || ""); setSource(r.source || "");
      } catch (e) { setMsg("⚠ " + (e.message || "Fehler")); }
      setLoading(false);
    })();
  }, []);

  function flash(m) { setMsg(m); setTimeout(() => setMsg(""), 3000); }

  async function regen() {
    if (!confirm("Neuen Lehrerinnen-Code generieren? Der bisherige Code wird sofort ungültig.")) return;
    setBusy(true);
    try {
      const r = await adminSync("regen-teacher-code");
      setCode(r.code || ""); setSource("stored"); setReveal(true);
      flash("✓ Neuer Code generiert");
    } catch (e) { flash("⚠ " + (e.message || "Fehler")); }
    finally { setBusy(false); }
  }

  function copyCode() {
    navigator.clipboard?.writeText(code).then(() => flash("✓ Code kopiert")).catch(() => {});
  }

  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  const masked = code ? code.replace(/./g, "•") : "";

  return (
    <div className="add-form">
      <h3>🔐 Lehrerinnen-Code</h3>
      <p style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 14 }}>
        Mit diesem Code registrieren sich neue Lehrerinnen. Gib ihn nur an vertrauenswürdige
        Personen weiter. Bei Verdacht auf Missbrauch: neuen Code generieren – der alte wird
        sofort ungültig.
      </p>

      {!code && <p className="err" style={{ marginBottom: 12 }}>Noch kein Code gesetzt. Generiere einen neuen Code.</p>}

      {code && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <code style={{ fontSize: 18, fontWeight: 700, letterSpacing: 2, background: "var(--sage-pale)", color: "var(--sage)", padding: "8px 14px", borderRadius: 8, wordBreak: "break-all" }}>
            {reveal ? code : masked}
          </code>
          <button className="btn-sm" onClick={() => setReveal((v) => !v)}>{reveal ? "Verbergen" : "Anzeigen"}</button>
          <button className="btn-sm" onClick={copyCode}>📋 Kopieren</button>
        </div>
      )}

      {source === "env" && (
        <p style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 8 }}>
          Aktueller Code stammt aus der Server-Konfiguration (Standard). Generiere einen neuen,
          um ihn hier dauerhaft zu verwalten.
        </p>
      )}

      <div style={{ marginTop: 16 }}>
        <button className="btn-add" onClick={regen} disabled={busy} style={{ background: "var(--accent)" }}>
          {busy ? "⏳ Generiere…" : "♻ Neuen Code generieren"}
        </button>
      </div>

      {msg && <p className={msg[0] === "✓" ? "ok" : "err"} style={{ marginTop: 10 }}>{msg}</p>}
    </div>
  );
}
