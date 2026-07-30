import { useState } from "react";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from "firebase/auth";
import { serverTimestamp } from "firebase/firestore";
import { auth } from "../lib/firebase";
import { LIMIT, LANGUAGES } from "../lib/constants";
import { emailForUsername } from "../lib/format";
import { claimTeacher } from "../lib/api";
import { dbSet } from "../data/db";

export function AuthScreen({ setRegistering }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [lang, setLang] = useState("RU");
  const [teacherCode, setTeacherCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    setErr(""); setBusy(true);
    const u = username.trim();
    if (!u || !password) { setErr("Fehlende Angaben."); setBusy(false); return; }
    if (u.length > LIMIT.username) { setErr("Benutzername zu lang."); setBusy(false); return; }
    const email = emailForUsername(u);
    try {
      if (mode === "login") {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        if (password.length < LIMIT.password) { setErr(`Passwort mindestens ${LIMIT.password} Zeichen.`); setBusy(false); return; }
        setRegistering(true);
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        if (teacherCode) {
          let claimStatus = 0;
          try { claimStatus = await claimTeacher(await cred.user.getIdToken(), teacherCode); } catch {}
          if (claimStatus !== 200) {
            await cred.user.delete().catch(() => {});
            setRegistering(false);
            setErr(claimStatus === 429 ? "Zu viele Versuche. Bitte später erneut versuchen." : "Lehrerinnen-Code ungültig.");
            setBusy(false);
            return;
          }
          await cred.user.getIdToken(true);
        }
        await dbSet(`users/${cred.user.uid}`, { username: u, lang, createdAt: serverTimestamp() });
        window.location.reload();
        return;
      }
    } catch {
      setErr(mode === "login" ? "Login fehlgeschlagen." : "Registrierung fehlgeschlagen (Name evtl. vergeben).");
    }
    setRegistering(false);
    setBusy(false);
  }

  return (
    <div className="auth-wrap">
      <h2>{mode === "login" ? "Willkommen zurück 👋" : "Konto erstellen 🌱"}</h2>
      <p>{mode === "login" ? "Melde dich mit deinem Konto an." : "Wähle einen Namen und ein Passwort."}</p>
      <div className="auth-box">
        <label>Benutzername</label>
        <input placeholder="z. B. Maria" value={username} maxLength={LIMIT.username} onChange={(e) => setUsername(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && handleSubmit()} />
        <label>Passwort</label>
        <input type="password" placeholder="••••••" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSubmit()} />
        {mode === "register" && <>
          <label>Deine Muttersprache</label>
          <select value={lang} onChange={(e) => setLang(e.target.value)}>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
          <label>Lehrerinnen-Code (optional)</label>
          <input placeholder="Nur für die Lehrerin" value={teacherCode} onChange={(e) => setTeacherCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSubmit()} />
        </>}
        {err && <p className="err">{err}</p>}
        <button className="btn-main" style={{ marginTop: 6 }} onClick={handleSubmit} disabled={!username.trim() || !password || busy}>
          {busy ? "Lädt…" : mode === "login" ? "Einloggen" : "Registrieren"}
        </button>
        <button className="auth-switch" onClick={() => { setMode((m) => (m === "login" ? "register" : "login")); setErr(""); }}>
          {mode === "login" ? "Noch kein Konto? Registrieren →" : "← Zurück zum Login"}
        </button>
      </div>
    </div>
  );
}
