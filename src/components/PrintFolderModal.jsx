import { useState, useEffect, useMemo } from "react";
import { LANGS } from "../../shared/languages.js";
import { isParentFolder, childFolderIds } from "../lib/folders";
import { loadFolderWords } from "../data/loaders";
import { openFolderPrint } from "../lib/printFolder";

export function PrintFolderModal({ folder, folders, onClose }) {
  const [words, setWords] = useState(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [withImage, setWithImage] = useState(true);
  const [withExample, setWithExample] = useState(true);
  const [blocked, setBlocked] = useState(false);

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

  const langCounts = useMemo(() => {
    const counts = {};
    for (const w of words || []) {
      const t = w.t || {};
      for (const l of LANGS) if (t[l.code] && t[l.code].ru) counts[l.code] = (counts[l.code] || 0) + 1;
    }
    return counts;
  }, [words]);

  const availableLangs = LANGS.filter((l) => langCounts[l.code] > 0);

  function toggleLang(code) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  }

  function doPrint() {
    const ok = openFolderPrint({
      title: `${folder.icon || "📁"} ${folder.name}`,
      langs: [...selected],
      words: words || [],
      fields: { image: withImage, example: withExample, translation: selected.size > 0 },
    });
    if (!ok) { setBlocked(true); return; }
    onClose();
  }

  const count = words ? words.length : null;
  const loading = words === null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: "white", borderRadius: 14, boxShadow: "var(--shadow)",
        width: "min(460px, 100%)", maxHeight: "85vh", overflow: "auto", padding: 22,
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
          <div>
            <h3 style={{ fontSize: 17, marginBottom: 2 }}>🖨️ Als PDF drucken</h3>
            <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
              {folder.icon} {folder.name}{isParentFolder(folder) ? " · Überordner" : ""}
            </div>
          </div>
          <button className="btn-del" onClick={onClose} aria-label="Schließen">✕</button>
        </div>

        {loading ? (
          <div className="loading" style={{ padding: 30 }}><div className="spinner" /></div>
        ) : error ? (
          <p className="err" style={{ marginTop: 14 }}>⚠ {error}</p>
        ) : count === 0 ? (
          <p style={{ fontSize: 14, color: "var(--ink-soft)", marginTop: 16 }}>
            In diesem {isParentFolder(folder) ? "Überordner" : "Ordner"} sind noch keine Wörter.
          </p>
        ) : (<>
          <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: "12px 0 14px" }}>
            {count} {count === 1 ? "Wort" : "Wörter"}. Wähle die Sprachen — pro Sprache entsteht ein eigener Abschnitt mit Deutsch und der Übersetzung.
          </p>

          <div className="sec-label">Sprachen</div>
          {availableLangs.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 10 }}>
              Noch keine Übersetzungen vorhanden — es wird ein Arbeitsblatt nur mit den deutschen Wörtern erstellt.
            </p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 14 }}>
              {availableLangs.map((l) => {
                const on = selected.has(l.code);
                return (
                  <button key={l.code} type="button" onClick={() => toggleLang(l.code)}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px",
                      borderRadius: 99, fontSize: 13, fontFamily: "inherit", cursor: "pointer",
                      border: `1.5px solid ${on ? "var(--sage)" : "var(--ivory-dark)"}`,
                      background: on ? "var(--sage-pale)" : "var(--ivory)",
                      color: on ? "var(--sage)" : "var(--ink-soft)", fontWeight: on ? 600 : 400,
                    }}>
                    {on ? "✓ " : ""}{l.label}
                    <span style={{ opacity: 0.6, fontSize: 11 }}>{langCounts[l.code]}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="sec-label">Inhalt</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 18, fontSize: 13, color: "var(--ink-soft)" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={withImage} onChange={(e) => setWithImage(e.target.checked)} /> Bilder
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={withExample} onChange={(e) => setWithExample(e.target.checked)} /> Beispielsätze
            </label>
          </div>

          {blocked && (
            <p className="err" style={{ marginBottom: 12 }}>
              ⚠ Das Druckfenster wurde blockiert. Erlaube Pop-ups für diese Seite und versuche es erneut.
            </p>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn-sm" onClick={onClose}>Abbrechen</button>
            <button className="btn-add" onClick={doPrint}>
              {selected.size > 0 ? `Drucken (${selected.size} ${selected.size === 1 ? "Sprache" : "Sprachen"})` : "Nur Deutsch drucken"}
            </button>
          </div>
        </>)}
      </div>
    </div>
  );
}
