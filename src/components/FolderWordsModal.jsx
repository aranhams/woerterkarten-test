import { useState, useEffect, useMemo } from "react";
import { validImageUrl, cldImg } from "../lib/format";
import { isParentFolder, childFolderIds } from "../lib/folders";
import { loadFolderWords } from "../data/loaders";

export function FolderWordsModal({ folder, folders, onClose }) {
  const [words, setWords] = useState(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");

  const folderIds = useMemo(
    () => (isParentFolder(folder) ? childFolderIds(folders, folder.id) : [folder.id]),
    [folder, folders],
  );

  useEffect(() => {
    let cancelled = false;
    setWords(null); setError("");
    (async () => {
      try {
        const w = await loadFolderWords(folderIds);
        if (!cancelled) setWords(w);
      } catch (e) {
        if (!cancelled) { setError(e.message || "Konnte Wörter nicht laden."); setWords([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [folderIds]);

  const query = q.trim().toLowerCase();
  const visible = (words || []).filter((w) =>
    !query || (w.de || "").toLowerCase().includes(query) || (w.ru || "").toLowerCase().includes(query));

  const loading = words === null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: "white", borderRadius: 14, boxShadow: "var(--shadow)",
        width: "min(480px, 100%)", maxHeight: "85vh", display: "flex", flexDirection: "column", padding: 22,
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
          <div>
            <h3 style={{ fontSize: 17, marginBottom: 2 }}>{folder.icon} {folder.name}</h3>
            <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
              {isParentFolder(folder) ? "Überordner · " : ""}
              {loading ? "Lädt…" : `${words.length} ${words.length === 1 ? "Wort" : "Wörter"}`}
            </div>
          </div>
          <button className="btn-del" onClick={onClose} aria-label="Schließen">✕</button>
        </div>

        {!loading && words.length > 8 && (
          <input placeholder="🔍 Wort suchen…" value={q} onChange={(e) => setQ(e.target.value)}
            style={{ width: "100%", padding: "8px 11px", border: "1.5px solid var(--ivory-dark)", borderRadius: 8, fontSize: 13, background: "var(--ivory)", outline: "none", fontFamily: "inherit", margin: "14px 0 4px" }} />
        )}

        <div style={{ overflow: "auto", marginTop: 12, flex: 1 }}>
          {loading ? (
            <div className="loading" style={{ padding: 30 }}><div className="spinner" /></div>
          ) : error ? (
            <p className="err">⚠ {error}</p>
          ) : words.length === 0 ? (
            <div className="empty" style={{ padding: 30 }}>
              <div className="emoji">🔤</div>
              <p style={{ fontSize: 14 }}>In diesem {isParentFolder(folder) ? "Überordner" : "Ordner"} sind noch keine Wörter.</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="transfer-empty">Keine Treffer.</div>
          ) : (
            <div className="word-list">
              {visible.map((w) => (
                <div className="word-item" key={w.id}>
                  {w.imageUrl && validImageUrl(w.imageUrl)
                    ? <img src={cldImg(w.imageUrl, 120)} className="wi-img" alt="" loading="lazy" decoding="async" />
                    : <div className="wi-img-placeholder">🔤</div>}
                  <div className="wi-text">
                    <div className="wi-de">{w.article && <span className="wi-article">{w.article}</span>}{w.de}</div>
                    {w.ru && <div className="wi-ru">{w.ru}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
