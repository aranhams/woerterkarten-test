import { useState, useEffect } from "react";
import { LIMIT, FOLDER_ICONS } from "../../lib/constants";
import { clip, validImageUrl, cldImg } from "../../lib/format";
import { loadVisibleWords, loadVisibleFolders, loadUserWords, loadUserFolders } from "../../data/loaders";
import { dbSet, dbDelete } from "../../data/db";
import { cachePush, cacheRemove } from "../../data/cache";

export function FoldersTab({ session }) {
  const [name, setName] = useState(""); const [icon, setIcon] = useState("📁");
  const [selected, setSelected] = useState(null);
  const [allWords, setAllWords] = useState([]); const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [gw, uw, gf, uf] = await Promise.all([loadVisibleWords(session), loadUserWords(session.uid), loadVisibleFolders(session), loadUserFolders(session.uid)]);
      setAllWords([...gw, ...uw]);
      setFolders([...gf.map((f) => ({ ...f, source: "global" })), ...uf.map((f) => ({ ...f, source: "personal" }))]);
      setLoading(false);
    })();
  }, []);

  async function addFolder() {
    if (!name.trim()) return;
    const id = `pf_${Date.now()}`;
    const f = { name: clip(name.trim(), LIMIT.folder), icon, source: "personal" };
    try { await dbSet(`users/${session.uid}/folders/${id}`, f); cachePush(`users/${session.uid}/folders`, { ...f, id }); setFolders((prev) => [...prev, { ...f, id }]); setName(""); setIcon("📁"); }
    catch { alert("Speichern fehlgeschlagen."); }
  }
  async function deleteFolder(fid) {
    try {
      await dbDelete(`users/${session.uid}/folders/${fid}`);
      cacheRemove(`users/${session.uid}/folders`, fid);
      setFolders((prev) => prev.filter((f) => f.id !== fid));
      if (selected === fid) setSelected(null);
    } catch { alert("Löschen fehlgeschlagen."); }
  }
  const wordsInFolder = (fid) => allWords.filter((w) => w.folderId === fid);
  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  return (<>
    <div className="add-form">
      <h3>+ Eigenen Ordner erstellen</h3>
      <div className="form-row">
        <select value={icon} onChange={(e) => setIcon(e.target.value)} style={{ flex: "none", width: 80 }}>
          {FOLDER_ICONS.map((ic) => <option key={ic} value={ic}>{ic}</option>)}
        </select>
        <input placeholder="Ordnername, z. B. Lektion 3" value={name} maxLength={LIMIT.folder} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addFolder()} />
        <button className="btn-add" onClick={addFolder} disabled={!name.trim()}>Erstellen</button>
      </div>
    </div>
    <div className="sec-label">Ordner</div>
    <div className="folder-grid">
      <div className={`folder-card all${selected === null ? " active" : ""}`} onClick={() => setSelected(null)}>
        <div className="folder-icon">📂</div>
        <div className="folder-name">Alle Wörter</div>
        <div className="folder-count">{allWords.length} Wörter</div>
      </div>
      {folders.map((f) => (
        <div key={f.id} className={`folder-card${selected === f.id ? " active" : ""}`} onClick={() => setSelected((s) => (s === f.id ? null : f.id))}>
          <div className="folder-icon">{f.icon}</div>
          <div className="folder-name">{f.name}</div>
          <div className="folder-count">{wordsInFolder(f.id).length} Wörter · {f.source === "global" ? "Kurs" : "Mein"}</div>
        </div>
      ))}
    </div>
    {selected && (() => {
      const folder = folders.find((f) => f.id === selected);
      const words = wordsInFolder(selected);
      const isOwn = folder?.source === "personal";
      return (<>
        <div className="folder-actions">
          <span style={{ fontWeight: 600, fontSize: 15 }}>{folder?.icon} {folder?.name}</span>
          {isOwn && <button className="btn-sm danger" onClick={() => deleteFolder(selected)}>Löschen</button>}
        </div>
        <div className="word-list" style={{ marginTop: 10 }}>
          {words.length === 0 && <div className="empty" style={{ padding: 20 }}><p>Noch keine Wörter in diesem Ordner.</p></div>}
          {words.map((w) => (
            <div className="word-item" key={w.id}>
              {w.imageUrl && validImageUrl(w.imageUrl) ? <img src={cldImg(w.imageUrl, 200)} className="wi-img" alt="" loading="lazy" decoding="async" /> : <div className="wi-img-placeholder">🔤</div>}
              <div className="wi-text">
                <div className="wi-de">{w.article && <span className="wi-article">{w.article}</span>}{w.de}</div>
                <div className="wi-ru">{w.ru}</div>
              </div>
              <span className={`wi-badge ${w.source === "global" ? "badge-g" : "badge-p"}`}>{w.source === "global" ? "Kurs" : "Ich"}</span>
            </div>
          ))}
        </div>
      </>);
    })()}
  </>);
}
