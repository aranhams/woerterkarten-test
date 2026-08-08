import { useState, useEffect } from "react";
import { LIMIT, FOLDER_ICONS, WORD_PAGE_SERVER } from "../../lib/constants";
import { clip, validImageUrl, cldImg } from "../../lib/format";
import { withTrans } from "../../lib/word";
import { loadVisibleFolders, loadUserFolders } from "../../data/loaders";
import { newPageState, loadNextPage, countWords, ensureWindow, windowRows, canGoNext, pageCount } from "../../data/pagination";
import { dbSet, dbDelete } from "../../data/db";
import { cachePush, cacheRemove } from "../../data/cache";
import { WordCardModal } from "../WordCardModal";

const FOLDERS_PER_PAGE = 7;

export function FoldersTab({ session }) {
  const [name, setName] = useState(""); const [icon, setIcon] = useState("📁");
  const [selected, setSelected] = useState(null);
  const [folderSearch, setFolderSearch] = useState(""); const [folderPage, setFolderPage] = useState(0);
  const [folders, setFolders] = useState([]);
  const [page, setPage] = useState(null);
  const [counts, setCounts] = useState({});
  const [busy, setBusy] = useState(false);
  const [wordPageIdx, setWordPageIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(null);
  const [trans, setTrans] = useState({});

  useEffect(() => {
    (async () => {
      const [gf, uf] = await Promise.all([loadVisibleFolders(session), loadUserFolders(session.uid)]);
      setFolders([...gf.map((f) => ({ ...f, source: "global" })), ...uf.map((f) => ({ ...f, source: "personal" }))]);
      setLoading(false);
    })();
  }, []);

  async function openFolder(fid) {
    setSelected(fid);
    setPage(null); setWordPageIdx(0);
    if (!fid) return;
    setBusy(true);
    const folder = folders.find((f) => f.id === fid);
    const sources = folder?.source === "personal" ? ["personal"] : ["global"];
    const next = await loadNextPage(newPageState({
      uid: session.uid, teacher: !!session.isTeacher, folderId: fid, sources,
    }));
    setPage(next);
    setBusy(false);
    if (counts[fid] === undefined) {
      const n = await countWords({
        source: sources[0], uid: session.uid, teacher: !!session.isTeacher, folderId: fid,
      });
      setCounts((prev) => ({ ...prev, [fid]: n }));
    }
  }

  async function goto(i) {
    if (!page || busy || i < 0) return;
    setBusy(true);
    const next = await ensureWindow(page, i, WORD_PAGE_SERVER);
    setPage(next);
    if (i === 0 || next.rows.length > i * WORD_PAGE_SERVER) setWordPageIdx(i);
    setBusy(false);
  }

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
      if (selected === fid) { setSelected(null); setPage(null); }
    } catch { alert("Löschen fehlgeschlagen."); }
  }
  const fq = folderSearch.trim().toLowerCase();
  const filteredFolders = fq ? folders.filter((f) => (f.name || "").toLowerCase().includes(fq)) : folders;
  const folderPages = Math.max(1, Math.ceil(filteredFolders.length / FOLDERS_PER_PAGE));
  const fPage = Math.min(folderPage, folderPages - 1);
  const pagedFolders = filteredFolders.slice(fPage * FOLDERS_PER_PAGE, fPage * FOLDERS_PER_PAGE + FOLDERS_PER_PAGE);
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
    {folders.length > FOLDERS_PER_PAGE && (
      <input placeholder="🔍 Ordner suchen…" value={folderSearch} onChange={(e) => { setFolderSearch(e.target.value); setFolderPage(0); }}
        style={{ width: "100%", padding: "9px 12px", border: "1.5px solid var(--ivory-dark)", borderRadius: 8, fontSize: 13, background: "white", outline: "none", fontFamily: "inherit", marginBottom: 10 }} />
    )}
    <div className="folder-grid">
      {pagedFolders.map((f) => (
        <div key={f.id} className={`folder-card${selected === f.id ? " active" : ""}`} onClick={() => openFolder(selected === f.id ? null : f.id)}>
          <div className="folder-icon">{f.icon}</div>
          <div className="folder-name">{f.name}</div>
          <div className="folder-count">{counts[f.id] != null ? `${counts[f.id]} Wörter · ` : ""}{f.source === "global" ? "Kurs" : "Mein"}</div>
        </div>
      ))}
    </div>
    {fq && filteredFolders.length === 0 && <div className="transfer-empty">Keine Treffer.</div>}
    {filteredFolders.length > FOLDERS_PER_PAGE && (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 12 }}>
        <button className="btn-sm" onClick={() => setFolderPage((p) => Math.max(0, p - 1))} disabled={fPage <= 0} aria-label="Vorherige Ordner">‹</button>
        <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>Seite {fPage + 1} / {folderPages}</span>
        <button className="btn-sm" onClick={() => setFolderPage((p) => Math.min(folderPages - 1, p + 1))} disabled={fPage >= folderPages - 1} aria-label="Weitere Ordner">›</button>
      </div>
    )}
    {selected && (() => {
      const folder = folders.find((f) => f.id === selected);
      const words = windowRows(page, wordPageIdx, WORD_PAGE_SERVER).map((w) => (w.source === "global" ? withTrans(w, session.lang) : w));
      const nWords = counts[selected];
      const wordPages = nWords != null ? pageCount(nWords, WORD_PAGE_SERVER) : null;
      const atLast = wordPages != null ? wordPageIdx >= wordPages - 1 : !canGoNext(page, wordPageIdx, WORD_PAGE_SERVER);
      const isOwn = folder?.source === "personal";
      return (<>
        <div className="folder-actions">
          <span style={{ fontWeight: 600, fontSize: 15 }}>{folder?.icon} {folder?.name}</span>
          {isOwn && <button className="btn-sm danger" onClick={() => deleteFolder(selected)}>Löschen</button>}
        </div>
        <div className="word-list" style={{ marginTop: 10 }}>
          {!page && <div className="loading" style={{ padding: 20 }}><div className="spinner" /></div>}
          {page && words.length === 0 && <div className="empty" style={{ padding: 20 }}><p>Noch keine Wörter in diesem Ordner.</p></div>}
          {words.map((w) => (
            <div className="word-item" key={w.id} style={{ cursor: "pointer" }} onClick={() => setPreview(w.id)}>
              {w.imageUrl && validImageUrl(w.imageUrl) ? <img src={cldImg(w.imageUrl, 200)} className="wi-img" alt="" loading="lazy" decoding="async" /> : <div className="wi-img-placeholder">🔤</div>}
              <div className="wi-text">
                <div className="wi-de">{w.article && <span className="wi-article">{w.article}</span>}{w.de}</div>
                <div className="wi-ru">{w.ru}</div>
              </div>
              <span className={`wi-badge ${w.source === "global" ? "badge-g" : "badge-p"}`}>{w.source === "global" ? "Kurs" : "Ich"}</span>
            </div>
          ))}
        </div>
        {page && (wordPageIdx > 0 || !atLast) && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 12 }}>
            <button className="btn-sm" onClick={() => goto(wordPageIdx - 1)} disabled={busy || wordPageIdx <= 0}>‹ Zurück</button>
            <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>
              {busy ? "⏳ Lädt…" : `Seite ${wordPageIdx + 1}${wordPages != null ? ` / ${wordPages}` : ""}`}
            </span>
            <button className="btn-sm" onClick={() => goto(wordPageIdx + 1)} disabled={busy || atLast}>Weiter ›</button>
          </div>
        )}
      </>);
    })()}
    {preview && (() => {
      const pw = (page ? page.rows : []).find((w) => w.id === preview);
      if (!pw) return null;
      return (
        <WordCardModal word={pw} folders={folders} session={session} trans={trans}
          onTranslated={(id, t) => setTrans((prev) => ({ ...prev, [id]: t }))}
          onClose={() => setPreview(null)} />
      );
    })()}
  </>);
}
