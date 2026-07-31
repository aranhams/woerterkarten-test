import { useState, useEffect } from "react";
import { serverTimestamp } from "firebase/firestore";
import { LIMIT } from "../../lib/constants";
import { clip, cleanArticle, validImageUrl, cldImg } from "../../lib/format";
import { validateWordInput, nextDeRev } from "../../lib/word";
import { translateWord } from "../../lib/api";
import { loadVisibleWords, loadVisibleFolders, loadUserWords, loadUserFolders } from "../../data/loaders";
import { dbSet, dbDelete } from "../../data/db";
import { cachePush, cacheRemove, cacheUpdate } from "../../data/cache";
import { ImageUpload } from "../ImageUpload";

export function WordsTab({ session }) {
  const [de, setDe] = useState(""); const [article, setArticle] = useState("");
  const [ru, setRu] = useState(""); const [example, setExample] = useState("");
  const [folderId, setFolderId] = useState(""); const [imageUrl, setImageUrl] = useState("");
  const [search, setSearch] = useState(""); const [filterFolder, setFilterFolder] = useState("all");
  const [allWords, setAllWords] = useState([]); const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [translating, setTranslating] = useState(false);
  const [edit, setEdit] = useState(null);
  const [editTranslating, setEditTranslating] = useState(false);

  useEffect(() => {
    (async () => {
      const [gw, uw, gf, uf] = await Promise.all([loadVisibleWords(session), loadUserWords(session.uid), loadVisibleFolders(session), loadUserFolders(session.uid)]);
      setAllWords([...gw, ...uw]);
      setFolders([...gf.map((f) => ({ ...f, source: "global" })), ...uf.map((f) => ({ ...f, source: "personal" }))]);
      setLoading(false);
    })();
  }, []);

  async function autoTranslate() {
    if (!de.trim()) return;
    setTranslating(true);
    try {
      const parsed = await translateWord({ word: de.trim(), article: article.trim(), lang: session.lang });
      if (parsed.translation) setRu(clip(parsed.translation, LIMIT.ru));
      if (parsed.example) setExample(clip(parsed.example, LIMIT.example));
    } catch {
      alert("Fehler beim Übersetzen. Bitte manuell eingeben.");
    }
    setTranslating(false);
  }

  async function addWord() {
    if (!de.trim() || !ru.trim()) return;
    if (imageUrl && !validImageUrl(imageUrl)) { alert("Ungültige Bild-URL."); return; }
    const id = `p_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const w = {
      de: clip(de.trim(), LIMIT.de), article: cleanArticle(article), ru: clip(ru.trim(), LIMIT.ru),
      example: clip(example.trim(), LIMIT.example), folderId: folderId || null, imageUrl: imageUrl || null,
      addedBy: session.uid, source: "personal",
    };
    try {
      await dbSet(`users/${session.uid}/words/${id}`, w);
      cachePush(`users/${session.uid}/words`, { ...w, id });
      setAllWords((prev) => [...prev, { ...w, id }]);
      setDe(""); setArticle(""); setRu(""); setExample(""); setFolderId(""); setImageUrl("");
    } catch { alert("Speichern fehlgeschlagen."); }
  }

  async function deleteWord(word) {
    try {
      await dbDelete(`users/${session.uid}/words/${word.id}`);
      cacheRemove(`users/${session.uid}/words`, word.id);
      setAllWords((prev) => prev.filter((w) => w.id !== word.id));
    } catch { alert("Löschen fehlgeschlagen."); }
  }

  function startEdit(w) {
    setEdit({ id: w.id, de: w.de || "", article: w.article || "", ru: w.ru || "", example: w.example || "", folderId: w.folderId || "", imageUrl: w.imageUrl || "" });
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
    const word = allWords.find((w) => w.id === edit.id);
    if (!word) return;
    const res = validateWordInput(edit, { requireRu: true });
    if (!res.ok) { alert(res.error); return; }
    const patch = { ...res.clean, folderId: edit.folderId || null, deRev: nextDeRev(word, res.clean), updatedAt: serverTimestamp(), updatedBy: session.uid };
    try {
      await dbSet(`users/${session.uid}/words/${edit.id}`, patch);
      const localPatch = { ...patch, updatedAt: Date.now() };
      cacheUpdate(`users/${session.uid}/words`, edit.id, localPatch);
      setAllWords((prev) => prev.map((w) => (w.id === edit.id ? { ...w, ...localPatch } : w)));
      setEdit(null);
    } catch { alert("Speichern fehlgeschlagen."); }
  }

  const visible = allWords.filter((w) => {
    const mf = filterFolder === "all" || w.folderId === filterFolder;
    const ms = !search || w.de.toLowerCase().includes(search.toLowerCase()) || w.ru.toLowerCase().includes(search.toLowerCase());
    return mf && ms;
  });
  const myFolders = folders.filter((f) => f.source === "personal");
  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  return (<>
    <div className="add-form">
      <h3>+ Eigenes Wort hinzufügen</h3>
      <div className="form-row">
        <input className="in-sm" placeholder="der/die/das" value={article} onChange={(e) => setArticle(e.target.value)} />
        <input placeholder="Deutsches Wort" value={de} maxLength={LIMIT.de} onChange={(e) => setDe(e.target.value)} />
        <button className="btn-add" onClick={autoTranslate} disabled={!de.trim() || translating} style={{ background: "var(--accent)", flexShrink: 0 }}>
          {translating ? "⏳" : "🤖"}
        </button>
      </div>
      <div className="form-row">
        <input placeholder="Übersetzung (Muttersprache)" value={ru} maxLength={LIMIT.ru} onChange={(e) => setRu(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addWord()} />
      </div>
      <div className="form-row">
        <input placeholder="Beispielsatz (optional)" value={example} maxLength={LIMIT.example} onChange={(e) => setExample(e.target.value)} />
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)} style={{ flex: "none", width: 160 }}>
          <option value="">📂 Kein Ordner</option>
          {myFolders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
        </select>
      </div>
      <div className="form-row" style={{ alignItems: "flex-end" }}>
        <ImageUpload value={imageUrl} onChange={setImageUrl} small />
        <button className="btn-add" onClick={addWord} disabled={!de.trim() || !ru.trim()} style={{ alignSelf: "flex-end" }}>+</button>
      </div>
    </div>
    <div className="filter-bar">
      <input placeholder="🔍 Suchen…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <select value={filterFolder} onChange={(e) => setFilterFolder(e.target.value)}>
        <option value="all">Alle Ordner</option>
        {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
      </select>
    </div>
    <div className="sec-label">Wörter ({visible.length})</div>
    <div className="word-list">
      {visible.length === 0 && <div className="empty" style={{ padding: 24 }}><p>Keine Wörter gefunden.</p></div>}
      {visible.map((w) => {
        const folder = folders.find((f) => f.id === w.folderId);
        const isOwn = w.source === "personal";
        if (edit && edit.id === w.id) {
          return (
            <div className="word-item" key={w.id} style={{ flexWrap: "wrap" }}>
              <div className="add-form" style={{ width: "100%", margin: 0 }}>
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
            </div>
          );
        }
        return (
          <div className="word-item" key={w.id}>
            {w.imageUrl && validImageUrl(w.imageUrl) ? <img src={cldImg(w.imageUrl, 200)} className="wi-img" alt="" loading="lazy" decoding="async" /> : <div className="wi-img-placeholder">🔤</div>}
            <div className="wi-text">
              <div className="wi-de">{w.article && <span className="wi-article">{w.article}</span>}{w.de}</div>
              <div className="wi-ru">{w.ru}{w.example && <span style={{ fontStyle: "italic", color: "#aaa" }}> — {w.example}</span>}</div>
            </div>
            {folder && <span className="wi-folder">{folder.icon} {folder.name}</span>}
            <span className={`wi-badge ${w.source === "global" ? "badge-g" : "badge-p"}`}>{w.source === "global" ? "Kurs" : "Ich"}</span>
            {isOwn && <button className="btn-sm" onClick={() => startEdit(w)} title="Bearbeiten">✏️</button>}
            {isOwn && <button className="btn-del" onClick={() => deleteWord(w)}>✕</button>}
          </div>
        );
      })}
    </div>
  </>);
}
