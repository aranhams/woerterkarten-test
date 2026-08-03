import { useState, useEffect } from "react";
import { serverTimestamp } from "firebase/firestore";
import { LIMIT } from "../lib/constants";
import { clip, validImageUrl, cldImg } from "../lib/format";
import { validateWordInput, nextDeRev } from "../lib/word";
import { translateWord } from "../lib/api";
import { dbSet } from "../data/db";
import { cacheUpdate } from "../data/cache";
import { ImageUpload } from "./ImageUpload";

export function WordCardModal({ word, folders, session, trans, onTranslated, onSaved, onClose }) {
  const [edit, setEdit] = useState(null);
  const [editTranslating, setEditTranslating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (word.source !== "global" || trans[word.id]) return;
      try {
        const parsed = await translateWord({ wordId: word.id, word: word.de, article: word.article, lang: session.lang });
        if (!cancelled && parsed.translation) {
          onTranslated(word.id, { ru: clip(parsed.translation, LIMIT.ru), example: clip(parsed.example || word.example || "", LIMIT.example) });
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [word.id]);

  const t = word.source === "global" ? trans[word.id] : null;
  const w = t ? { ...word, ru: t.ru, example: t.example || word.example } : word;
  const folder = folders.find((f) => f.id === w.folderId);
  const myFolders = folders.filter((f) => f.source === "personal");
  const isOwn = word.source === "personal";

  function startEdit() {
    setEdit({ id: word.id, de: word.de || "", article: word.article || "", ru: word.ru || "", example: word.example || "", folderId: word.folderId || "", imageUrl: word.imageUrl || "" });
  }

  async function autoTranslateEdit() {
    if (!edit?.de.trim()) return;
    setEditTranslating(true);
    try {
      const parsed = await translateWord({ word: edit.de.trim(), article: edit.article.trim(), lang: session.lang });
      setEdit((e) => ({ ...e, ru: parsed.translation ? clip(parsed.translation, LIMIT.ru) : e.ru, example: parsed.example ? clip(parsed.example, LIMIT.example) : e.example }));
    } catch { alert("Fehler beim Übersetzen. Bitte manuell eingeben."); }
    setEditTranslating(false);
  }

  async function saveEdit() {
    const res = validateWordInput(edit, { requireRu: true });
    if (!res.ok) { alert(res.error); return; }
    const patch = { ...res.clean, folderId: edit.folderId || null, deRev: nextDeRev(word, res.clean), updatedAt: serverTimestamp(), updatedBy: session.uid };
    try {
      await dbSet(`users/${session.uid}/words/${edit.id}`, patch);
      const localPatch = { ...patch, updatedAt: Date.now() };
      cacheUpdate(`users/${session.uid}/words`, edit.id, localPatch);
      onSaved(edit.id, localPatch);
      setEdit(null);
    } catch { alert("Speichern fehlgeschlagen."); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="fc" translate="no" style={{ cursor: "default", width: edit ? "min(420px, 100%)" : "fit-content", minWidth: "min(340px, 100%)", maxWidth: "100%" }} onClick={(e) => e.stopPropagation()}>
        {edit ? (
          <div className="add-form" style={{ width: "100%", margin: 0, textAlign: "left" }}>
            <div className="form-row">
              <input className="in-sm" placeholder="der/die/das" value={edit.article} onChange={(e) => setEdit({ ...edit, article: e.target.value })} />
              <input placeholder="Deutsches Wort" value={edit.de} maxLength={LIMIT.de} onChange={(e) => setEdit({ ...edit, de: e.target.value })} />
              <button className="btn-add" onClick={autoTranslateEdit} disabled={!edit.de.trim() || editTranslating} style={{ background: "var(--accent)", flexShrink: 0 }}>{editTranslating ? "⏳" : "🤖"}</button>
            </div>
            <div className="form-row">
              <input placeholder="Übersetzung (Muttersprache)" value={edit.ru} maxLength={LIMIT.ru} onChange={(e) => setEdit({ ...edit, ru: e.target.value })} />
            </div>
            <div className="form-row">
              <input placeholder="Beispielsatz (optional)" value={edit.example} maxLength={LIMIT.example} onChange={(e) => setEdit({ ...edit, example: e.target.value })} />
              <select value={edit.folderId} onChange={(e) => setEdit({ ...edit, folderId: e.target.value })} style={{ flex: "none", width: 160 }}>
                <option value="">📂 Kein Ordner</option>
                {myFolders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
              </select>
            </div>
            <div className="form-row" style={{ alignItems: "flex-end" }}>
              <ImageUpload value={edit.imageUrl} onChange={(url) => setEdit({ ...edit, imageUrl: url })} small />
              <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
                <button className="btn-sm" onClick={saveEdit} disabled={!edit.de.trim() || !edit.ru.trim()}>Speichern</button>
                <button className="btn-sm" onClick={() => setEdit(null)}>Abbrechen</button>
              </div>
            </div>
          </div>
        ) : (<>
          {folder && <div className="fc-folder">{folder.icon} {folder.name}</div>}
          <div style={{ position: "absolute", top: 10, right: 10, display: "flex", gap: 6 }}>
            {isOwn && <button className="btn-sm" onClick={startEdit} title="Bearbeiten">✏️</button>}
            <button className="btn-del" onClick={onClose}>✕</button>
          </div>
          {w.imageUrl && validImageUrl(w.imageUrl) && <img src={cldImg(w.imageUrl, 600)} className="fc-img" alt="" decoding="async" />}
          {w.article && <div className="fc-article">{w.article}</div>}
          <div className="fc-word">{w.de}</div>
          <div className="fc-ru">{w.ru || <span style={{ color: "#ccc", fontSize: 14 }}>⏳ Wird übersetzt…</span>}</div>
          {w.example && <div className="fc-example">„{w.example}"</div>}
        </>)}
      </div>
    </div>
  );
}
