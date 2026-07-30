import { useState } from "react";
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from "firebase/auth";
import { auth } from "../lib/firebase";
import { LIMIT } from "../lib/constants";
import { emailForUsername } from "../lib/format";

export function ChangePassword({ session }) {
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState("");
  const [nw, setNw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const pwInput = { width: "100%", padding: "7px 9px", border: "1.5px solid var(--ivory-dark)", borderRadius: 7, fontSize: 13, background: "var(--ivory)", outline: "none", fontFamily: "inherit" };

  function reset() { setOpen(false); setCur(""); setNw(""); setMsg(""); setBusy(false); }

  async function submit() {
    if (busy) return;
    if (nw.length < LIMIT.password) { setMsg(`⚠ Neues Passwort mind. ${LIMIT.password} Zeichen.`); return; }
    setBusy(true); setMsg("");
    try {
      const cred = EmailAuthProvider.credential(emailForUsername(session.username), cur);
      await reauthenticateWithCredential(auth.currentUser, cred);
      await updatePassword(auth.currentUser, nw);
      setMsg("✓ Passwort geändert");
      setCur(""); setNw("");
      setTimeout(reset, 1200);
    } catch (e) {
      const bad = e?.code === "auth/wrong-password" || e?.code === "auth/invalid-credential";
      setMsg("⚠ " + (bad ? "Aktuelles Passwort falsch." : "Fehler. Bitte erneut versuchen."));
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="user-menu-item neutral" role="menuitem" onClick={() => setOpen(true)}>
        Passwort ändern
      </button>
    );
  }
  return (
    <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--ivory-dark)", marginBottom: 6 }}>
      <div className="user-menu-sub" style={{ marginBottom: 6 }}>Passwort ändern</div>
      <input type="password" placeholder="Aktuelles Passwort" value={cur} onChange={(e) => setCur(e.target.value)} style={pwInput} />
      <input type="password" placeholder={`Neues Passwort (min. ${LIMIT.password})`} value={nw} onChange={(e) => setNw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} style={{ ...pwInput, marginTop: 6 }} />
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button className="btn-add" onClick={submit} disabled={!cur || !nw || busy} style={{ padding: "7px 12px" }}>{busy ? "…" : "Speichern"}</button>
        <button className="btn-sm" onClick={reset}>Abbrechen</button>
      </div>
      {msg && <div style={{ fontSize: 12, marginTop: 6, color: msg[0] === "✓" ? "var(--sage)" : "var(--red-soft)" }}>{msg}</div>}
    </div>
  );
}
