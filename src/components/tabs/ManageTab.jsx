import { useState, useEffect, useRef } from "react";
import { serverTimestamp, writeBatch, doc } from "firebase/firestore";
import { db } from "../../lib/firebase";
import { LIMIT, FOLDER_ICONS, WORD_PAGE_SERVER } from "../../lib/constants";
import { clip, cleanArticle, validImageUrl, cldImg } from "../../lib/format";
import { validateWordInput, germanChanged, nextDeRev, searchFields, buildDesc, descFresh } from "../../lib/word";
import { classSync, requestPronunciation, resyncPronunciation, purgeCollocationSets } from "../../lib/api";
import { pronState } from "../../lib/pron";
import { loadGlobalFolders } from "../../data/loaders";
import { newPageState, loadNextPage, countWords, ensureWindow, windowRows, canGoNext, pageCount } from "../../data/pagination";
import { dbSet, dbDelete } from "../../data/db";
import { cachePush, cacheRemove, cacheUpdate } from "../../data/cache";
import { ImageUpload } from "../ImageUpload";
import { CollocationsTeacherTab } from "./CollocationsTeacherTab";

const PRON_BATCH = 25;
const WRITE_BATCH = 450;
const SEARCH_DEBOUNCE = 350;
const MIN_QUERY = 2;
const VALID_ARTICLES = ["der", "die", "das", "ein", "eine", "-"];

function isValidArticle(v) {
  return VALID_ARTICLES.includes(String(v || "").trim().toLowerCase());
}

function normalizeArticle(v) {
  const t = String(v || "").trim().toLowerCase();
  return VALID_ARTICLES.includes(t) ? t : String(v || "");
}

export function ManageTab({ session }) {
  const [de, setDe] = useState(""); const [article, setArticle] = useState("");
  const [ru, setRu] = useState(""); const [example, setExample] = useState("");
  const [desc, setDesc] = useState("");
  const [folderId, setFolderId] = useState(""); const [imageUrl, setImageUrl] = useState("");
  const [bulk, setBulk] = useState(""); const [msg, setMsg] = useState("");
  const [folderName, setFolderName] = useState(""); const [folderIcon, setFolderIcon] = useState("📁");
  const [quickFolder, setQuickFolder] = useState(null);
  const [page, setPage] = useState(null); const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editFolderId, setEditFolderId] = useState(null); const [editFolderName, setEditFolderName] = useState("");
  const [folderSearch, setFolderSearch] = useState("");
  const [dragFolderId, setDragFolderId] = useState(null);
  const [dragOverFolderId, setDragOverFolderId] = useState(null);
  const [wordSearch, setWordSearch] = useState("");
  const [wEdit, setWEdit] = useState(null);
  const [rowMsg, setRowMsg] = useState(null);
  const [syncing, setSyncing] = useState(null);
  const cancelSync = useRef(false);
  const searchTimer = useRef(null);
  const searchSeq = useRef(0);
  const deInputRef = useRef(null);
  const editDeInputRef = useRef(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [articleTouched, setArticleTouched] = useState(false);
  const [editArticleTouched, setEditArticleTouched] = useState(false);
  const [total, setTotal] = useState(null);
  const [manageSection, setManageSection] = useState("words");
  const [showOptions, setShowOptions] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [selectedWords, setSelectedWords] = useState(new Set());

  const words = page ? page.rows : [];

  useEffect(() => {
    (async () => {
      const [gf, first, n] = await Promise.all([
        loadGlobalFolders(),
        loadNextPage(newPageState({ uid: session.uid, teacher: true })),
        countWords({ source: "global", uid: session.uid, teacher: true }),
      ]);
      setFolders(gf.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))); setPage(first); setTotal(n); setLoading(false);
    })();
  }, []);

  async function goto(i) {
    if (!page || busy || i < 0) return;
    setBusy(true);
    const next = await ensureWindow(page, i, WORD_PAGE_SERVER);
    setPage(next);
    if (i === 0 || next.rows.length > i * WORD_PAGE_SERVER) setPageIdx(i);
    setBusy(false);
  }

  function onSearchChange(v) {
    setWordSearch(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const seq = ++searchSeq.current;
    const q = v.trim();
    searchTimer.current = setTimeout(async () => {
      if (q.length > 0 && q.length < MIN_QUERY) return;
      setBusy(true);
      const next = await loadNextPage(newPageState({ uid: session.uid, teacher: true, q }));
      if (seq === searchSeq.current) { setPage(next); setPageIdx(0); }
      setBusy(false);
    }, SEARCH_DEBOUNCE);
  }

  const setWords = (fn) => setPage((p) => (p ? { ...p, rows: typeof fn === "function" ? fn(p.rows) : fn } : p));

  function toggleWordSelection(id) {
    setSelectedWords((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    const ids = pagedWords.map((w) => w.id);
    const allSelected = ids.every((id) => selectedWords.has(id));
    setSelectedWords((prev) => {
      const next = new Set(prev);
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }

  function clearSelection() { setSelectedWords(new Set()); }

  async function bulkDeleteSelected() {
    const ids = Array.from(selectedWords);
    if (!ids.length) return;
    if (!confirm(`${ids.length} Wörter wirklich löschen?`)) return;
    for (const id of ids) {
      const word = words.find((w) => w.id === id);
      if (word) await deleteWord(id);
    }
    clearSelection();
  }

  async function bulkMoveSelected(fid) {
    const ids = Array.from(selectedWords);
    if (!ids.length) return;
    for (const id of ids) {
      const word = words.find((w) => w.id === id);
      if (word) await moveWord(word, fid);
    }
    clearSelection();
  }

  function highlightMatch(text, query) {
    const t = String(text || "");
    const q = query.trim().toLowerCase();
    if (!q || !t.toLowerCase().includes(q)) return t;
    const idx = t.toLowerCase().indexOf(q);
    return (
      <>
        {t.slice(0, idx)}
        <mark style={{ background: "var(--accent-pale)", color: "var(--accent)", borderRadius: 3, padding: "0 2px" }}>{t.slice(idx, idx + q.length)}</mark>
        {t.slice(idx + q.length)}
      </>
    );
  }

  function flash(m) { setMsg(m); setTimeout(() => setMsg(""), 2500); }
  function flashRow(id, text) { setRowMsg({ id, text }); setTimeout(() => setRowMsg((r) => (r && r.id === id && r.text === text ? null : r)), 2500); }

  function folderMembersFor(fid) {
    if (!fid) return [];
    const f = folders.find((x) => x.id === fid);
    return Array.isArray(f?.memberUids) ? f.memberUids : [];
  }

  async function saveFolderName(id) {
    const nm = clip(editFolderName.trim(), LIMIT.folder);
    if (!nm) return;
    try {
      await dbSet(`global_folders/${id}`, { name: nm });
      cacheUpdate("global_folders", id, { name: nm });
      setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name: nm } : f)));
      setEditFolderId(null);
      flash("✓ Ordner umbenannt");
    } catch { flash("⚠ Keine Berechtigung."); }
  }

  async function moveWord(w, newFolderId) {
    const fid = newFolderId || null;
    if (fid === (w.folderId || null)) return;
    const memberUids = folderMembersFor(fid);
    const prevMemberUids = Array.isArray(w.memberUids) ? w.memberUids : [];
    try {
      await dbSet(`global_words/${w.id}`, { folderId: fid, memberUids, updatedAt: serverTimestamp(), updatedBy: session.uid });
      const localPatch = { folderId: fid, memberUids, updatedAt: Date.now(), updatedBy: session.uid };
      setWords((prev) => prev.map((x) => (x.id === w.id ? { ...x, ...localPatch } : x)));
      classSync("word-assigned", { wordIds: [w.id], prevMemberUids }).catch(() => {});
      flashRow(w.id, "✓ Wort verschoben");
    } catch { flashRow(w.id, "⚠ Keine Berechtigung."); }
  }

  function startWordEdit(w) {
    setWEdit({ id: w.id, de: w.de || "", article: w.article || "", ru: w.ru || "", example: w.example || "", folderId: w.folderId || "", imageUrl: w.imageUrl || "", desc: descFresh(w) ? w.desc.text : "" });
    setEditArticleTouched(false);
  }

  async function saveWordEdit() {
    const id = wEdit.id;
    const word = words.find((w) => w.id === id);
    if (!word) return;
    const res = validateWordInput(wEdit, { requireRu: false });
    if (!res.ok) { flashRow(id, "⚠ " + res.error); return; }
    const changedDe = germanChanged(word, res.clean);
    const fid = wEdit.folderId || null;
    const memberUids = folderMembersFor(fid);
    const patch = {
      ...res.clean, folderId: fid, memberUids, deRev: nextDeRev(word, res.clean),
      ...searchFields(res.clean),
      desc: buildDesc(wEdit.desc, res.clean.de),
      updatedAt: serverTimestamp(), updatedBy: session.uid,
    };
    try {
      await dbSet(`global_words/${wEdit.id}`, patch);
      const localPatch = { ...patch, updatedAt: Date.now() };
      setWords((prev) => prev.map((w) => (w.id === wEdit.id ? { ...w, ...localPatch } : w)));
      setWEdit(null);
      setEditArticleTouched(false);
      flashRow(id, "✓ Wort aktualisiert");
      const prevMemberUids = Array.isArray(word.memberUids) ? word.memberUids : [];
      if (changedDe) {
        classSync("word-updated", { wordId: word.id, prevMemberUids }).catch(() => {});
        requestPronunciation(word.id, "global").catch(() => {});
      } else {
        classSync("word-assigned", { wordIds: [word.id], prevMemberUids }).catch(() => {});
      }
    } catch { flashRow(id, "⚠ Keine Berechtigung."); }
  }

  function onArticleChange(v) {
    setArticle(v);
    if (isValidArticle(v)) deInputRef.current?.focus();
  }

  function onArticlePaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text");
    const [first, ...rest] = text.trim().split(/\s+/);
    if (isValidArticle(first)) {
      setArticle(normalizeArticle(first));
      setDe(rest.join(" "));
      deInputRef.current?.focus();
    } else {
      setArticle(text);
    }
  }

  function onEditArticleChange(v) {
    setWEdit((prev) => ({ ...prev, article: v }));
    if (isValidArticle(v)) editDeInputRef.current?.focus();
  }

  function onEditArticlePaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text");
    const [first, ...rest] = text.trim().split(/\s+/);
    if (isValidArticle(first)) {
      setWEdit((prev) => ({ ...prev, article: normalizeArticle(first), de: rest.join(" ") }));
      editDeInputRef.current?.focus();
    } else {
      setWEdit((prev) => ({ ...prev, article: text }));
    }
  }

  async function addWord() {
    if (!de.trim()) return;
    if (imageUrl && !validImageUrl(imageUrl)) { flash("⚠ Ungültige Bild-URL."); return; }
    const id = `g_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const cleanDe = clip(de.trim(), LIMIT.de);
    const w = { de: cleanDe, article: cleanArticle(article), ru: clip(ru.trim(), LIMIT.ru), example: clip(example.trim(), LIMIT.example), folderId: folderId || null, imageUrl: imageUrl || null, addedBy: "Lehrerin", source: "global", memberUids: folderMembersFor(folderId), desc: buildDesc(desc, cleanDe), ...searchFields({ de, ru }) };
    try {
      await dbSet(`global_words/${id}`, w); setWords((prev) => [...prev, { ...w, id }]);
      setDe(""); setArticle(""); setRu(""); setExample(""); setDesc(""); setImageUrl(""); setArticleTouched(false); flash("✓ Wort hinzugefügt");
      classSync("word-assigned", { wordIds: [id] }).catch(() => {});
      requestPronunciation(id, "global").catch(() => {});
    }
    catch { flash("⚠ Keine Berechtigung."); }
  }

  async function bulkAdd() {
    const lines = bulk.split("\n").map((l) => l.trim()).filter(Boolean);
    const newW = [];
    for (const line of lines) {
      const parts = line.split(/[–\-—|]/).map((s) => s.trim());
      if (!parts[0]) continue;
      let de_ = parts[0], art_ = "", ru_ = parts[1] || "", ex_ = parts[2] || "";
      const m = de_.match(/^(der|die|das|ein|eine)\s+(.+)$/i);
      if (m) { art_ = m[1]; de_ = m[2]; }
      newW.push({ de: clip(de_, LIMIT.de), article: cleanArticle(art_), ru: clip(ru_, LIMIT.ru), example: clip(ex_, LIMIT.example), folderId: folderId || null, imageUrl: null, addedBy: "Lehrerin", source: "global", memberUids: folderMembersFor(folderId), ...searchFields({ de: de_, ru: ru_ }) });
    }
    if (!newW.length) { flash("⚠ Format: Wort – Übersetzung"); return; }
    const stamp = Date.now();
    const rows = newW.map((w, i) => ({ ...w, id: `g_${stamp}_${Math.random().toString(36).slice(2)}_${i}` }));
    try {
      for (let i = 0; i < rows.length; i += WRITE_BATCH) {
        const batch = writeBatch(db);
        for (const r of rows.slice(i, i + WRITE_BATCH)) {
          const { id, ...data } = r;
          batch.set(doc(db, "global_words", id), data, { merge: true });
        }
        await batch.commit();
      }
      setWords((prev) => [...prev, ...rows]);
      setBulk(""); flash(`✓ ${rows.length} Wörter hinzugefügt`);
      classSync("word-assigned", { wordIds: rows.map((r) => r.id) }).catch(() => {});
      syncPron(rows.map((r) => r.id), { announce: false });
    } catch { flash("⚠ Keine Berechtigung."); }
  }

  async function syncPron(ids, { announce = true } = {}) {
    if (!ids.length) { if (announce) flash("✓ Alle Kurswörter haben schon eine Aussprache"); return; }
    cancelSync.current = false;
    setSyncing({ done: 0, total: ids.length });
    let ok = 0, failed = 0;
    for (let i = 0; i < ids.length; i += PRON_BATCH) {
      if (cancelSync.current) break;
      const chunk = ids.slice(i, i + PRON_BATCH);
      try {
        const res = await resyncPronunciation(chunk);
        ok += (res.done || 0) + (res.skipped || 0);
        failed += res.failed || 0;
        const patches = res.results || {};
        setWords((prev) => prev.map((w) => (patches[w.id] ? { ...w, pron: patches[w.id] } : w)));
      } catch (e) {
        failed += chunk.length;
        if (/Too many|Budget|budget|deaktiviert/.test(e.message || "")) { setSyncing(null); flash(`⚠ ${e.message}`); return; }
      }
      setSyncing({ done: Math.min(i + PRON_BATCH, ids.length), total: ids.length });
      await new Promise((r) => setTimeout(r, 250));
    }
    setSyncing(null);
    if (announce) flash(failed ? `✓ ${ok} aktualisiert, ${failed} fehlgeschlagen` : `✓ ${ok} Wörter aktualisiert`);
  }

  function nextFolderOrder() {
    return folders.reduce((max, f) => Math.max(max, f.order ?? 0), 0) + 1;
  }

  async function addFolder() {
    if (!folderName.trim()) return;
    const id = `gf_${Date.now()}`;
    const f = { name: clip(folderName.trim(), LIMIT.folder), icon: folderIcon, source: "global", memberUids: [], order: nextFolderOrder() };
    try {
      await dbSet(`global_folders/${id}`, f);
      cachePush("global_folders", { ...f, id });
      setFolders((prev) => [...prev, { ...f, id }].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
      setFolderName(""); setFolderIcon("📁"); flash("✓ Ordner erstellt");
    }
    catch { flash("⚠ Keine Berechtigung."); }
  }

  async function addQuickFolder() {
    if (!quickFolder || !quickFolder.name.trim()) return;
    const id = `gf_${Date.now()}`;
    const f = { name: clip(quickFolder.name.trim(), LIMIT.folder), icon: quickFolder.icon || "📁", source: "global", memberUids: [], order: nextFolderOrder() };
    try {
      await dbSet(`global_folders/${id}`, f);
      cachePush("global_folders", { ...f, id });
      setFolders((prev) => [...prev, { ...f, id }].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
      setFolderId(id);
      setQuickFolder(null);
      flash("✓ Ordner erstellt");
    } catch { flash("⚠ Keine Berechtigung."); }
  }

  async function deleteWord(id) {
    const word = words.find((w) => w.id === id);
    const memberUids = Array.isArray(word?.memberUids) ? word.memberUids : [];
    try {
      await dbDelete(`global_words/${id}`);
      setWords((prev) => prev.filter((w) => w.id !== id));
      classSync("cleanup", { wordId: id, memberUids }).catch(() => {});
      purgeCollocationSets(id).catch(() => {});
    } catch { flash("⚠ Keine Berechtigung."); }
  }
  async function deleteFolder(id) {
    try {
      await dbDelete(`global_folders/${id}`);
      cacheRemove("global_folders", id);
      setFolders((prev) => prev.filter((f) => f.id !== id));
      classSync("cleanup", { folderId: id }).catch(() => {});
    } catch { flash("⚠ Keine Berechtigung."); }
  }

  async function reorderFolders(dragId, targetId) {
    if (dragId === targetId) return;
    const list = [...folders].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const from = list.findIndex((f) => f.id === dragId);
    const to = list.findIndex((f) => f.id === targetId);
    if (from === -1 || to === -1) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    const reordered = list.map((f, i) => ({ ...f, order: i }));
    const prevMap = new Map(folders.map((f) => [f.id, f.order ?? 0]));
    const patches = reordered.filter((f) => f.order !== (prevMap.get(f.id) ?? f.order));
    if (!patches.length) return;
    setFolders(reordered);
    try {
      const batch = writeBatch(db);
      for (const f of patches) {
        batch.update(doc(db, "global_folders", f.id), { order: f.order });
      }
      await batch.commit();
      for (const f of patches) cacheUpdate("global_folders", f.id, { order: f.order });
      flash("✓ Reihenfolge gespeichert");
    } catch {
      flash("⚠ Reihenfolge konnte nicht gespeichert werden");
      setFolders((prev) => prev.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
    }
  }

  function onFolderDragStart(e, id) {
    setDragFolderId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }

  function onFolderDragOver(e, id) {
    e.preventDefault();
    if (id !== dragFolderId) setDragOverFolderId(id);
  }

  function onFolderDrop(e, id) {
    e.preventDefault();
    const dragId = e.dataTransfer.getData("text/plain") || dragFolderId;
    if (dragId && dragId !== id) reorderFolders(dragId, id);
    setDragFolderId(null);
    setDragOverFolderId(null);
  }

  function onFolderDragEnd() {
    setDragFolderId(null);
    setDragOverFolderId(null);
  }

  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  const fq = folderSearch.trim().toLowerCase();
  const filteredFolders = fq ? folders.filter((f) => (f.name || "").toLowerCase().includes(fq)) : folders;
  const folderSearchActive = !!fq;

  const pronTodo = words.filter((w) => pronState(w) !== "ready").map((w) => w.id);
  const searching = !!wordSearch.trim();
  const pagedWords = windowRows(page, pageIdx, WORD_PAGE_SERVER);
  const bulkCount = bulk.split("\n").map((l) => l.trim()).filter(Boolean).length;
  const pages = total != null && !searching ? pageCount(total, WORD_PAGE_SERVER) : null;
  const atLastPage = pages != null ? pageIdx >= pages - 1 : !canGoNext(page, pageIdx, WORD_PAGE_SERVER);

  return (<>
    <div className="nav-group-tabs" style={{ marginBottom: 18 }}>
      <button className={`nav-tab${manageSection === "words" ? " active" : ""}`} onClick={() => setManageSection("words")}>📋 Wörter</button>
      <button className={`nav-tab${manageSection === "folders" ? " active" : ""}`} onClick={() => setManageSection("folders")}>📁 Ordner</button>
      <button className={`nav-tab${manageSection === "collocations" ? " active" : ""}`} onClick={() => setManageSection("collocations")}>🔗 Wortverbindungen</button>
    </div>

    {manageSection === "folders" && (<div className="add-form">
      <h3>📁 Kurs-Ordner erstellen</h3>
      <div className="form-row">
        <select value={folderIcon} onChange={(e) => setFolderIcon(e.target.value)} style={{ flex: "none", width: 80 }}>
          {FOLDER_ICONS.map((ic) => <option key={ic} value={ic}>{ic}</option>)}
        </select>
        <input placeholder="Ordnername, z. B. Lektion 1" value={folderName} maxLength={LIMIT.folder} onChange={(e) => setFolderName(e.target.value)} />
        <button className="btn-add" onClick={addFolder} disabled={!folderName.trim()}>Erstellen</button>
      </div>
      {folders.length > 0 && <div style={{ marginTop: 10 }}>
        <input placeholder="🔍 Ordner suchen…" value={folderSearch} onChange={(e) => setFolderSearch(e.target.value)}
          style={{ width: "100%", padding: "8px 11px", border: "1.5px solid var(--ivory-dark)", borderRadius: 8, fontSize: 13, background: "var(--ivory)", outline: "none", fontFamily: "inherit", marginBottom: 6 }} />
        {folderSearchActive && <div className="transfer-empty" style={{ marginBottom: 8 }}>Ziehen zum Sortieren ist bei Suche deaktiviert.</div>}
        {filteredFolders.length === 0 && <div className="transfer-empty">Keine Treffer.</div>}
        {filteredFolders.map((f) => (
          <div
            key={f.id}
            className={`folder-row${dragFolderId === f.id ? " dragging" : ""}${dragOverFolderId === f.id ? " drag-over" : ""}`}
            draggable={!folderSearchActive && editFolderId !== f.id}
            onDragStart={(e) => onFolderDragStart(e, f.id)}
            onDragOver={(e) => onFolderDragOver(e, f.id)}
            onDrop={(e) => onFolderDrop(e, f.id)}
            onDragEnd={onFolderDragEnd}
          >
            <span className="folder-drag-handle">⋮⋮</span>
            <span style={{ fontSize: 16 }}>{f.icon}</span>
            {editFolderId === f.id ? (<>
              <input value={editFolderName} maxLength={LIMIT.folder} autoFocus
                onChange={(e) => setEditFolderName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveFolderName(f.id); if (e.key === "Escape") setEditFolderId(null); }}
                style={{ flex: 1, minWidth: 0, padding: "6px 9px", border: "1.5px solid var(--sage)", borderRadius: 7, fontSize: 13, background: "white", outline: "none", fontFamily: "inherit" }} />
              <button className="btn-sm" onClick={() => saveFolderName(f.id)} disabled={!editFolderName.trim()}>Speichern</button>
              <button className="btn-sm" onClick={() => setEditFolderId(null)}>Abbrechen</button>
            </>) : (<>
              <span style={{ flex: 1, fontSize: 14 }}>{f.name}</span>
              <button className="btn-sm" onClick={() => { setEditFolderId(f.id); setEditFolderName(f.name); }}>Umbenennen</button>
              <button className="btn-sm danger" onClick={() => deleteFolder(f.id)}>Löschen</button>
            </>)}
          </div>
        ))}
      </div>}
    </div>)}

    {manageSection === "words" && (
    <div className="manage-words-layout">
      <div className="manage-words-forms">
        <div className="add-form">
          <h3>Einzelnes Wort hinzufügen</h3>
          <div className="form-row">
            <input
              className={`in-sm article-input${isValidArticle(article) ? " valid" : articleTouched && article.trim() ? " invalid" : ""}`}
              placeholder="der/die/das/ein/eine"
              value={article}
              onChange={(e) => onArticleChange(e.target.value)}
              onPaste={onArticlePaste}
              onBlur={() => setArticleTouched(true)}
              onKeyDown={(e) => { if (e.key === "Enter" && de.trim()) addWord(); }}
            />
            <input ref={deInputRef} placeholder="Deutsches Wort" value={de} maxLength={LIMIT.de} onChange={(e) => setDe(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && de.trim()) addWord(); }} />
            <select value={folderId} onChange={(e) => {
              const v = e.target.value;
              if (v === "__new__") { setQuickFolder({ name: "", icon: "📁" }); setFolderId(""); }
              else { setFolderId(v); setQuickFolder(null); }
            }} style={{ flex: "none", width: 160 }}>
              <option value="">📂 Kein Ordner</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
              <optgroup label="Neu">
                <option value="__new__">+ Neuer Ordner</option>
              </optgroup>
            </select>
          </div>

          {quickFolder && (
            <div className="form-row" style={{ alignItems: "center", background: "var(--sage-pale)", padding: "10px 12px", borderRadius: 8, marginTop: -4 }}>
              <select value={quickFolder.icon} onChange={(e) => setQuickFolder({ ...quickFolder, icon: e.target.value })} style={{ flex: "none", width: 80 }}>
                {FOLDER_ICONS.map((ic) => <option key={ic} value={ic}>{ic}</option>)}
              </select>
              <input placeholder="Ordnername" value={quickFolder.name} maxLength={LIMIT.folder}
                onChange={(e) => setQuickFolder({ ...quickFolder, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") addQuickFolder(); }} />
              <button className="btn-add" onClick={addQuickFolder} disabled={!quickFolder.name.trim()}>Erstellen</button>
              <button className="btn-sm" onClick={() => setQuickFolder(null)}>Abbrechen</button>
            </div>
          )}

          <button
            type="button"
            className="options-toggle"
            aria-expanded={showOptions}
            onClick={() => setShowOptions((s) => !s)}
          >
            <span className="toggle-text">Weitere Optionen</span>
            {(example || desc || ru) && <span className="options-dot" />}
          </button>

          {showOptions && (<>
            <div className="form-row">
              <input placeholder="Beispielsatz (optional)" value={example} maxLength={LIMIT.example} onChange={(e) => setExample(e.target.value)} />
            </div>
            <div className="form-row">
              <textarea placeholder="Beschreibung / Rätsel für die Klasse (optional)" value={desc} maxLength={LIMIT.desc}
                rows={2} onChange={(e) => setDesc(e.target.value)}
                style={{ width: "100%", padding: "9px 12px", border: "1.5px solid var(--ivory-dark)", borderRadius: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical", outline: "none" }} />
            </div>
            <div className="form-row">
              <input placeholder="Übersetzung (optional — Schüler übersetzen selbst)" value={ru} maxLength={LIMIT.ru} onChange={(e) => setRu(e.target.value)} />
            </div>
          </>)}

          <div className="form-row" style={{ alignItems: "flex-end" }}>
            <ImageUpload value={imageUrl} onChange={setImageUrl} small />
            <button className="btn-add" onClick={addWord} disabled={!de.trim()} style={{ alignSelf: "flex-end" }}>Wort hinzufügen</button>
          </div>
          {msg && <p className="ok">{msg}</p>}
        </div>

        <div className="add-form">
          <button
            type="button"
            className="bulk-toggle"
            aria-expanded={bulkOpen}
            onClick={() => setBulkOpen((s) => !s)}
          >
            <span className="toggle-text">Mehrere Wörter auf einmal</span>
            {bulkCount > 0 && <span className="bulk-count-chip">{bulkCount} erkannt</span>}
          </button>
          {bulkOpen && (<>
            <p style={{ fontSize: 12, color: "var(--ink-soft)", margin: "10px 0" }}>Format: <code>der Hund – собака</code> oder <code>arbeiten – работать – Ich arbeite gern.</code></p>
            <div className="form-row" style={{ marginBottom: 10 }}>
              <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
                <option value="">📂 Kein Ordner</option>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
              </select>
            </div>
            <textarea value={bulk} onChange={(e) => setBulk(e.target.value)} rows={5}
              placeholder={"der Hund – собака\ndie Katze – кошка\narbeiten – работать"}
              style={{ width: "100%", padding: "9px 12px", border: "1.5px solid var(--ivory-dark)", borderRadius: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical", background: "var(--ivory)", outline: "none", marginBottom: 10 }} />
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <button className="btn-add" onClick={bulkAdd} disabled={!bulk.trim()} style={{ flex: 1 }}>Alle hinzufügen</button>
              {bulkCount > 0 && <span style={{ fontSize: 12, color: "var(--sage)" }}>{bulkCount} Wörter erkannt</span>}
            </div>
          </>)}
        </div>
      </div>

      <div className="manage-words-list">
        <div className="words-header-sticky">
          <div className="words-header-main">
            <label className="words-select-all">
              <input type="checkbox" checked={pagedWords.length > 0 && pagedWords.every((w) => selectedWords.has(w.id))} onChange={selectAllVisible} />
              <span className="sec-label" style={{ margin: 0 }}>Kurswörter ({searching ? words.length : (total ?? words.length)})</span>
            </label>
            <div className="words-header-actions">
              <button className="btn-sm" onClick={() => syncPron(pronTodo)} disabled={!!syncing || !words.length}
                title="Worttrennung, Lautschrift und Audio für die geladenen Kurswörter nachladen">
                {syncing ? `🔊 ${syncing.done} / ${syncing.total}` : `🔊 Aussprache synchronisieren${pronTodo.length ? ` (${pronTodo.length})` : ""}`}
              </button>
              {syncing && <button className="btn-sm" onClick={() => { cancelSync.current = true; }}>Abbrechen</button>}
              <input placeholder="🔍 Wörter suchen…" value={wordSearch} onChange={(e) => onSearchChange(e.target.value)}
                style={{ flex: "1 1 160px", maxWidth: 260, padding: "8px 11px", border: "1.5px solid var(--ivory-dark)", borderRadius: 8, fontSize: 13, background: "white", outline: "none", fontFamily: "inherit" }} />
            </div>
          </div>
          {selectedWords.size > 0 && (
            <div className="bulk-actions-bar">
              <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>{selectedWords.size} ausgewählt</span>
              <select value="" onChange={(e) => { if (e.target.value) bulkMoveSelected(e.target.value); }} style={{ flex: "none", maxWidth: 180 }}>
                <option value="">📁 In Ordner verschieben</option>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
                <option value="">📂 Kein Ordner</option>
              </select>
              <button className="btn-sm danger" onClick={bulkDeleteSelected}>Löschen</button>
              <button className="btn-sm" onClick={clearSelection}>Auswahl aufheben</button>
            </div>
          )}
        </div>

        <div className="word-list">
          {pagedWords.length === 0 && (
            <div className="empty">
              <div className="emoji">📝</div>
              <h3>{busy ? "Lädt…" : searching ? "Keine Treffer." : "Noch keine Kurswörter."}</h3>
              {!busy && !searching && <p>Füge oben dein erstes Wort hinzu oder importiere mehrere auf einmal.</p>}
            </div>
          )}
          {pagedWords.map((w) => (
            <div key={w.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {wEdit && wEdit.id === w.id ? (
              <div className="word-item" style={{ flexWrap: "wrap" }}>
                <div className="add-form" style={{ width: "100%", margin: 0 }}>
                  <div className="form-row">
                    <input
                      className={`in-sm article-input${isValidArticle(wEdit.article) ? " valid" : editArticleTouched && (wEdit.article || "").trim() ? " invalid" : ""}`}
                      placeholder="der/die/das/ein/eine"
                      value={wEdit.article}
                      onChange={(e) => onEditArticleChange(e.target.value)}
                      onPaste={onEditArticlePaste}
                      onBlur={() => setEditArticleTouched(true)}
                    />
                    <input ref={editDeInputRef} placeholder="Deutsches Wort" value={wEdit.de} maxLength={LIMIT.de} onChange={(e) => setWEdit({ ...wEdit, de: e.target.value })} />
                    <input placeholder="Übersetzung (optional)" value={wEdit.ru} maxLength={LIMIT.ru} onChange={(e) => setWEdit({ ...wEdit, ru: e.target.value })} />
                  </div>
                  <div className="form-row">
                    <input placeholder="Beispielsatz (optional)" value={wEdit.example} maxLength={LIMIT.example} onChange={(e) => setWEdit({ ...wEdit, example: e.target.value })} />
                    <select value={wEdit.folderId} onChange={(e) => setWEdit({ ...wEdit, folderId: e.target.value })} style={{ flex: "none", width: 160 }}>
                      <option value="">📂 Kein Ordner</option>
                      {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
                    </select>
                  </div>
                  <div className="form-row">
                    <textarea placeholder="Beschreibung / Rätsel für die Klasse (optional)" value={wEdit.desc} maxLength={LIMIT.desc}
                      rows={2} onChange={(e) => setWEdit({ ...wEdit, desc: e.target.value })}
                      style={{ width: "100%", padding: "9px 12px", border: "1.5px solid var(--ivory-dark)", borderRadius: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical", outline: "none" }} />
                  </div>
                  <div className="form-row" style={{ alignItems: "flex-end" }}>
                    <ImageUpload value={wEdit.imageUrl} onChange={(url) => setWEdit({ ...wEdit, imageUrl: url })} small />
                    <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
                      <button className="btn-sm" onClick={saveWordEdit} disabled={!wEdit.de.trim()}>Speichern</button>
                      <button className="btn-sm" onClick={() => setWEdit(null)}>Abbrechen</button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className={`word-item word-item-card${selectedWords.has(w.id) ? " selected" : ""}`}>
                <div className="word-card-main">
                  <label className="word-checkbox">
                    <input type="checkbox" checked={selectedWords.has(w.id)} onChange={() => toggleWordSelection(w.id)} />
                  </label>
                  {w.imageUrl && validImageUrl(w.imageUrl) ? <img src={cldImg(w.imageUrl, 200)} className="wi-img" alt="" loading="lazy" decoding="async" /> : <div className="wi-img-placeholder">🔤</div>}
                  <div className="wi-text">
                    <div className="wi-de">{w.article && <span className="wi-article">{w.article}</span>}{highlightMatch(w.de, wordSearch)}</div>
                    <div className="wi-ru">{highlightMatch(w.ru, wordSearch)}{w.example && <span style={{ fontStyle: "italic", color: "#aaa" }}> — {w.example}</span>}</div>
                    {w.desc?.text && <div className="wi-desc">{w.desc.text}</div>}
                  </div>
                </div>
                <div className="wi-tools">
                  {(() => {
                    const s = pronState(w);
                    const label = s === "ready" ? "🔊" : s === "failed" ? "🔊" : "🔊";
                    const title = s === "ready" ? "Aussprache vorhanden" : s === "failed" ? "Keine Aussprachedaten" : "Aussprache fehlt noch";
                    return <span className={`pron-badge${s === "ready" ? " ready" : s === "failed" ? " failed" : ""}`} title={title}>{label}</span>;
                  })()}
                  <select value={w.folderId || ""} onChange={(e) => moveWord(w, e.target.value)} title="Ordner wechseln">
                    <option value="">📂 Kein Ordner</option>
                    {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
                  </select>
                  <button className="btn-sm" onClick={() => startWordEdit(w)} title="Bearbeiten">✏️</button>
                  <button className="btn-del" onClick={() => deleteWord(w.id)}>✕</button>
                </div>
              </div>
            )}
            {rowMsg && rowMsg.id === w.id && (
              <div style={{
                padding: "8px 12px", borderRadius: 8, fontSize: 13, fontWeight: 500,
                background: rowMsg.text.startsWith("⚠") ? "var(--red-pale)" : "var(--sage-pale)",
                color: rowMsg.text.startsWith("⚠") ? "var(--red-soft)" : "var(--sage)",
              }}>{rowMsg.text}</div>
            )}
            </div>
          ))}
        </div>
        {(pageIdx > 0 || !atLastPage) && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 12 }}>
            <button className="btn-sm" onClick={() => goto(pageIdx - 1)} disabled={busy || pageIdx <= 0}>‹ Zurück</button>
            <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>
              {busy ? "⏳ Lädt…" : `Seite ${pageIdx + 1}${pages != null ? ` / ${pages}` : ""}`}
            </span>
            <button className="btn-sm" onClick={() => goto(pageIdx + 1)} disabled={busy || atLastPage}>Weiter ›</button>
          </div>
        )}
      </div>
    </div>
    )}

    {manageSection === "collocations" && <CollocationsTeacherTab session={session} />}
  </>);
}
