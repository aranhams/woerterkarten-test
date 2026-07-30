import { useState, useEffect } from "react";
import { LIMIT, CLASS_ICONS } from "../../lib/constants";
import { classSync } from "../../lib/api";
import { loadAllClasses, loadGlobalFolders, loadGlobalWords } from "../../data/loaders";
import { clearDataCache } from "../../data/cache";

export function KurseTab({ session }) {
  const [classes, setClasses] = useState([]);
  const [folders, setFolders] = useState([]);
  const [words, setWords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("👥");
  const [studentName, setStudentName] = useState("");
  const [renameVal, setRenameVal] = useState("");
  const [copyMsg, setCopyMsg] = useState("");
  const [roster, setRoster] = useState([]);
  const [studentSearch, setStudentSearch] = useState("");

  async function reload() {
    clearDataCache();
    const [cs, gf, gw] = await Promise.all([loadAllClasses(), loadGlobalFolders(), loadGlobalWords()]);
    setClasses(cs); setFolders(gf); setWords(gw);
  }
  useEffect(() => {
    (async () => {
      await reload();
      try { const r = await classSync("list-students"); setRoster(r.students || []); } catch {}
      setLoading(false);
    })();
  }, []);

  function flash(m) { setMsg(m); setTimeout(() => setMsg(""), 3000); }

  async function call(action, payload) {
    setBusy(true);
    try { const r = await classSync(action, payload); await reload(); return r; }
    catch (e) { flash("⚠ " + (e.message || "Fehler")); throw e; }
    finally { setBusy(false); }
  }

  const selected = classes.find((c) => c.id === selectedId) || null;
  const looseWords = words.filter((w) => !w.folderId);
  const members = selected ? (selected.memberUids || []) : [];
  const enrolledSet = new Set(members);
  const availableStudents = roster.filter((s) => !enrolledSet.has(s.uid) && (!studentSearch.trim() || s.username.toLowerCase().includes(studentSearch.trim().toLowerCase())));
  const rosterById = new Map(roster.map((s) => [s.uid, s.username]));
  const nameOf = (uid) => rosterById.get(uid) || uid.slice(0, 6);
  const folderState = (fid) => {
    const e = (selected?.folders || []).find((x) => x.folderId === fid);
    return e ? e.audience : "off";
  };

  async function createClass() {
    if (!name.trim()) return;
    try { const r = await call("create", { name: name.trim(), icon }); setSelectedId(r.classId); setRenameVal(name.trim()); setName(""); flash("✓ Kurs erstellt"); } catch {}
  }
  async function renameClass() {
    if (!selected || !renameVal.trim()) return;
    try { await call("rename", { classId: selected.id, name: renameVal.trim(), icon: selected.icon }); flash("✓ Umbenannt"); } catch {}
  }
  async function deleteClass() {
    if (!selected) return;
    if (!confirm(`Kurs „${selected.name}" wirklich löschen?`)) return;
    try { await call("delete", { classId: selected.id }); setSelectedId(null); flash("✓ Kurs gelöscht"); } catch {}
  }
  async function regenCode() {
    if (!selected) return;
    try { await call("regen-code", { classId: selected.id }); flash("✓ Neuer Code"); } catch {}
  }
  async function addStudent() {
    if (!selected || !studentName.trim()) return;
    try { await call("add-student", { classId: selected.id, username: studentName.trim() }); setStudentName(""); flash("✓ Schüler hinzugefügt"); } catch {}
  }
  async function addStudentByUid(uid) {
    if (!selected) return;
    try { await call("add-student", { classId: selected.id, uid }); } catch {}
  }
  async function removeStudent(uid) {
    if (!selected) return;
    try { await call("remove-student", { classId: selected.id, uid }); } catch {}
  }
  async function setFolderState(fid, state) {
    if (!selected) return;
    const entries = (selected.folders || []).filter((e) => e.folderId !== fid);
    if (state === "all") entries.push({ folderId: fid, audience: "all" });
    else if (state === "selected") {
      const prev = (selected.folders || []).find((e) => e.folderId === fid);
      entries.push({ folderId: fid, audience: "selected", uids: prev?.uids || [] });
    }
    try { await call("set-folders", { classId: selected.id, folders: entries }); } catch {}
  }
  async function toggleFolderStudent(fid, uid) {
    if (!selected) return;
    const entry = (selected.folders || []).find((e) => e.folderId === fid);
    const cur = new Set(entry?.uids || []);
    if (cur.has(uid)) cur.delete(uid); else cur.add(uid);
    try { await call("set-folder-audience", { classId: selected.id, folderId: fid, audience: "selected", uids: [...cur] }); } catch {}
  }
  async function toggleWord(wid) {
    if (!selected) return;
    const cur = new Set(selected.wordIds || []);
    if (cur.has(wid)) cur.delete(wid); else cur.add(wid);
    try { await call("set-words", { classId: selected.id, wordIds: [...cur] }); } catch {}
  }
  async function sync() {
    try { const r = await call("sync", {}); flash(`✓ Synchronisiert (${r.stamped} aktualisiert)`); } catch {}
  }
  async function copyCode(code) {
    try {
      await navigator.clipboard.writeText(code);
      setCopyMsg("✓ Code kopiert");
    } catch {
      setCopyMsg("⚠ Kopieren nicht möglich");
    }
    setTimeout(() => setCopyMsg(""), 2500);
  }

  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  return (<>
    <div className="add-form">
      <h3>👥 Neuen Kurs erstellen</h3>
      <div className="form-row">
        <select value={icon} onChange={(e) => setIcon(e.target.value)} style={{ flex: "none", width: 80 }}>
          {CLASS_ICONS.map((ic) => <option key={ic} value={ic}>{ic}</option>)}
        </select>
        <input placeholder="Kursname, z. B. Kurs 509" value={name} maxLength={LIMIT.folder} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createClass()} />
        <button className="btn-add" onClick={createClass} disabled={!name.trim() || busy}>Erstellen</button>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
        <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>Stellt Ordner &amp; Wörter für die Schüler des Kurses bereit.</span>
        <button className="btn-sm" onClick={sync} disabled={busy} title="Alle Inhalte mit den Kursen abgleichen">🔄 Synchronisieren</button>
      </div>
      {msg && <p className={msg[0] === "✓" ? "ok" : "err"} style={{ marginTop: 8 }}>{msg}</p>}
    </div>

    <div className="sec-label">Kurse ({classes.length})</div>
    <div className="folder-grid">
      {classes.length === 0 && <div className="empty" style={{ padding: 20, gridColumn: "1/-1" }}><p>Noch keine Kurse.</p></div>}
      {classes.map((c) => (
        <div key={c.id} className={`folder-card${selectedId === c.id ? " active" : ""}`} onClick={() => { setSelectedId((s) => (s === c.id ? null : c.id)); setRenameVal(c.name); }}>
          <div className="folder-icon">{c.icon}</div>
          <div className="folder-name">{c.name}</div>
          <div className="folder-count">{(c.memberUids || []).length} Schüler</div>
        </div>
      ))}
    </div>

    {selected && (<>
      <div className="add-form" style={{ marginTop: 4 }}>
        <div className="folder-actions" style={{ justifyContent: "space-between" }}>
          <span style={{ fontWeight: 600, fontSize: 16 }}>{selected.icon} {selected.name}</span>
          <button className="btn-sm danger" onClick={deleteClass} disabled={busy}>Kurs löschen</button>
        </div>
        <div className="form-row" style={{ marginTop: 10 }}>
          <input value={renameVal} maxLength={LIMIT.folder} onChange={(e) => setRenameVal(e.target.value)} placeholder="Kursname" />
          <button className="btn-sm" onClick={renameClass} disabled={busy || !renameVal.trim()}>Umbenennen</button>
        </div>
        <div className="sec-label" style={{ marginTop: 12 }}>Kurs-Code</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <code style={{ fontSize: 18, fontWeight: 700, letterSpacing: 2, background: "var(--sage-pale)", color: "var(--sage)", padding: "6px 14px", borderRadius: 8 }}>{selected.joinCode}</code>
          <button className="btn-sm" onClick={() => copyCode(selected.joinCode)}>📋 Kopieren</button>
          <button className="btn-sm" onClick={regenCode} disabled={busy}>♻ Neu</button>
        </div>
        {copyMsg && <div style={{ fontSize: 12, marginTop: 6, color: copyMsg[0] === "✓" ? "var(--sage)" : "var(--red-soft)" }}>{copyMsg}</div>}
        <p style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 6 }}>Schüler treten über „Menü → Kurs beitreten" mit diesem Code bei.</p>
      </div>

      <div className="add-form">
        <div className="sec-label" style={{ marginTop: 0 }}>Schüler ({members.length})</div>
        <input placeholder="🔍 Schüler suchen…" value={studentSearch} onChange={(e) => setStudentSearch(e.target.value)}
          style={{ width: "100%", padding: "9px 12px", border: "1.5px solid var(--ivory-dark)", borderRadius: 8, fontSize: 13, background: "var(--ivory)", outline: "none", fontFamily: "inherit" }} />
        <div className="transfer">
          <div className="transfer-col">
            <div className="sec-label">Verfügbar ({availableStudents.length})</div>
            <div className="transfer-list">
              {availableStudents.length === 0 && <div className="transfer-empty">{roster.length === 0 ? "Keine registrierten Schüler." : "Keine Treffer."}</div>}
              {availableStudents.map((s) => (
                <button key={s.uid} className="transfer-item" onClick={() => addStudentByUid(s.uid)} disabled={busy} title="Zum Kurs hinzufügen">
                  <span className="ti-name">{s.username}</span>
                  <span className="ti-act" style={{ color: "var(--sage)" }}>＋</span>
                </button>
              ))}
            </div>
          </div>
          <div className="transfer-col">
            <div className="sec-label">Im Kurs ({members.length})</div>
            <div className="transfer-list">
              {members.length === 0 && <div className="transfer-empty">Noch keine Schüler.</div>}
              {members.map((uid) => (
                <button key={uid} className="transfer-item rm" onClick={() => removeStudent(uid)} disabled={busy} title="Aus dem Kurs entfernen">
                  <span className="ti-name">{nameOf(uid)}</span>
                  <span className="ti-act" style={{ color: "var(--red-soft)" }}>✕</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <details style={{ marginTop: 10 }}>
          <summary style={{ fontSize: 12, color: "var(--ink-soft)", cursor: "pointer" }}>Manuell per Benutzername hinzufügen</summary>
          <div className="form-row" style={{ marginTop: 8 }}>
            <input placeholder="Benutzername" value={studentName} onChange={(e) => setStudentName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addStudent()} />
            <button className="btn-add" onClick={addStudent} disabled={!studentName.trim() || busy}>Hinzufügen</button>
          </div>
        </details>
      </div>

      <div className="add-form">
        <div className="sec-label" style={{ marginTop: 0 }}>Ordner im Kurs</div>
        {folders.length === 0 && <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>Keine Kurs-Ordner. Erstelle welche im Tab „Verwalten".</p>}
        {folders.map((f) => {
          const state = folderState(f.id);
          const entry = (selected.folders || []).find((x) => x.folderId === f.id);
          return (
            <div key={f.id} style={{ borderTop: "1px solid var(--ivory-dark)", padding: "10px 0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{f.icon} {f.name}</span>
                <div className="dir-toggle" style={{ margin: 0 }}>
                  <button className={`dir-btn${state === "off" ? " active" : ""}`} onClick={() => setFolderState(f.id, "off")}>Aus</button>
                  <button className={`dir-btn${state === "all" ? " active" : ""}`} onClick={() => setFolderState(f.id, "all")}>Alle</button>
                  <button className={`dir-btn${state === "selected" ? " active" : ""}`} onClick={() => setFolderState(f.id, "selected")}>Ausgewählte</button>
                </div>
              </div>
              {state === "selected" && (
                <div style={{ marginTop: 8, paddingLeft: 4 }}>
                  {members.length === 0 && <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>Erst Schüler hinzufügen.</span>}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {members.map((uid) => {
                      const on = (entry?.uids || []).includes(uid);
                      return (
                        <button key={uid} className="btn-sm" onClick={() => toggleFolderStudent(f.id, uid)}
                          style={on ? { borderColor: "var(--sage)", color: "var(--sage)", background: "var(--sage-pale)" } : {}}>
                          {on ? "✓ " : ""}{nameOf(uid)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="add-form">
        <div className="sec-label" style={{ marginTop: 0 }}>Einzelne Wörter (ohne Ordner) im Kurs</div>
        {looseWords.length === 0 && <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>Keine ordnerlosen Kurswörter.</p>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {looseWords.map((w) => {
            const on = (selected.wordIds || []).includes(w.id);
            return (
              <button key={w.id} className="btn-sm" onClick={() => toggleWord(w.id)}
                style={on ? { borderColor: "var(--sage)", color: "var(--sage)", background: "var(--sage-pale)" } : {}}>
                {on ? "✓ " : ""}{w.article ? w.article + " " : ""}{w.de}
              </button>
            );
          })}
        </div>
      </div>
    </>)}
  </>);
}
