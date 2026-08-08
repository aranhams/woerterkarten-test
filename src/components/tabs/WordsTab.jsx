import { useState, useEffect, useRef } from "react";
import { serverTimestamp } from "firebase/firestore";
import { LIMIT } from "../../lib/constants";
import { clip, cleanArticle, validImageUrl, cldImg } from "../../lib/format";
import { validateWordInput, germanChanged, nextDeRev, searchFields, withTrans } from "../../lib/word";
import { effProgress, lvlEmoji } from "../../lib/srs";
import { translateWord, requestPronunciation } from "../../lib/api";
import {
  loadVisibleFolders, loadUserFolders, loadUserWords, loadProgress, cachePron,
  personalSearchFieldsReady, markPersonalSearchFieldsReady, healPersonalSearchFields,
} from "../../data/loaders";
import { newPageState, loadNextPage, countWords } from "../../data/pagination";
import { dbSet, dbDelete } from "../../data/db";
import { cachePush, cacheRemove, cacheUpdate, cacheGet, cacheSet } from "../../data/cache";
import { ImageUpload } from "../ImageUpload";
import { WordCardModal } from "../WordCardModal";

const SEARCH_DEBOUNCE = 350;
const MIN_QUERY = 2;

function nextReviewText(due) {
  if (!due || Date.now() >= due) return "jetzt fällig";
  const ms = due - Date.now(), DAY = 86400000, HR = 3600000, MIN = 60000;
  if (ms >= DAY) { const d = Math.round(ms / DAY); return `in ${d} ${d === 1 ? "Tag" : "Tagen"}`; }
  if (ms >= HR) { const h = Math.round(ms / HR); return `in ${h} Std.`; }
  const m = Math.max(1, Math.round(ms / MIN)); return `in ${m} Min.`;
}

export function WordsTab({ session }) {
  const [de, setDe] = useState(""); const [article, setArticle] = useState("");
  const [ru, setRu] = useState(""); const [example, setExample] = useState("");
  const [folderId, setFolderId] = useState(""); const [imageUrl, setImageUrl] = useState("");
  const [search, setSearch] = useState(""); const [filterFolder, setFilterFolder] = useState("all");
  const [page, setPage] = useState(null);
  const [legacyPersonal, setLegacyPersonal] = useState(null);
  const [folders, setFolders] = useState([]);
  const [progress, setProgress] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [edit, setEdit] = useState(null);
  const [editTranslating, setEditTranslating] = useState(false);
  const [preview, setPreview] = useState(null);
  const [trans, setTrans] = useState({});
  const [counts, setCounts] = useState(null);
  const searchTimer = useRef(null);
  const searchSeq = useRef(0);

  // Tabs unmount on switch, so component state is lost. Browsing state is kept in the
  // module cache and revalidated with two count queries instead of re-reading the page.
  const pageKey = (fid) => `words_page1:${session.uid}:${fid || "all"}`;

  const countOpts = (fid) => ({
    uid: session.uid, teacher: !!session.isTeacher,
    folderId: !fid || fid === "all" ? null : fid,
  });

  // Always hits the server: validating a cached page against counts derived from that
  // same page would compare it with itself and never detect drift.
  async function liveCounts(fid) {
    const o = countOpts(fid);
    const [g, p] = await Promise.all([
      countWords({ source: "global", ...o }),
      countWords({ source: "personal", ...o }),
    ]);
    return { g, p };
  }

  // Only safe right after a fresh load: an exhausted page is the whole result set.
  function countsFor(fid, p) {
    if (p && p.exhausted && !p.q) {
      return Promise.resolve({
        g: p.rows.filter((r) => r.source === "global").length,
        p: p.rows.filter((r) => r.source === "personal").length,
      });
    }
    return liveCounts(fid);
  }

  const countsMatch = (a, b) => a && b && a.g != null && a.p != null && a.g === b.g && a.p === b.p;

  function basePageState(over = {}) {
    return newPageState({
      uid: session.uid,
      teacher: !!session.isTeacher,
      folderId: filterFolder === "all" ? null : filterFolder,
      sources: legacyPersonal ? ["global"] : ["global", "personal"],
      ...over,
    });
  }

  useEffect(() => {
    (async () => {
      const [gf, uf, prog, ready] = await Promise.all([
        loadVisibleFolders(session), loadUserFolders(session.uid),
        loadProgress(session.uid), personalSearchFieldsReady(session.uid),
      ]);
      setFolders([...gf.map((f) => ({ ...f, source: "global" })), ...uf.map((f) => ({ ...f, source: "personal" }))]);
      setProgress(prog);

      let personal = null;
      if (!ready) {
        const uw = (await loadUserWords(session.uid)).map((w) => ({ ...w, source: "personal" }));
        const healed = await healPersonalSearchFields(session.uid, uw);
        if (healed) await markPersonalSearchFieldsReady(session.uid);
        personal = uw;
        setLegacyPersonal(uw);
      }

      if (!personal) {
        const hit = cacheGet(pageKey("all"));
        if (hit) {
          const now = await liveCounts("all");
          if (countsMatch(now, hit.counts)) {
            setPage(hit.state); setCounts(now); setLoading(false);
            return;
          }
        }
      }

      const first = await loadNextPage(newPageState({
        uid: session.uid, teacher: !!session.isTeacher,
        sources: personal ? ["global"] : ["global", "personal"],
      }));
      setPage(first);
      if (!personal) setCounts(await countsFor("all", first));
      setLoading(false);
    })();
  }, []);

  // Keeps the cached browse state in step with local edits, adds and deletes, so a tab
  // switch restores what the student last saw rather than a stale page.
  useEffect(() => {
    if (!page || page.q || legacyPersonal || !counts) return;
    cacheSet(pageKey(page.folderId), { state: page, counts });
  }, [page, counts, legacyPersonal]);

  async function reloadPage(over = {}) {
    setBusy(true);
    const next = await loadNextPage(basePageState(over));
    setPage(next);
    if (!over.q && !legacyPersonal) setCounts(await countsFor(over.folderId ?? filterFolder, next));
    setBusy(false);
  }

  async function more() {
    if (!page || page.exhausted || busy) return;
    setBusy(true);
    setPage(await loadNextPage(page));
    setBusy(false);
  }

  function onSearchChange(v) {
    setSearch(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const seq = ++searchSeq.current;
    const q = v.trim();
    searchTimer.current = setTimeout(async () => {
      if (q.length > 0 && q.length < MIN_QUERY) return;
      setBusy(true);
      const next = await loadNextPage(basePageState({ q }));
      if (seq === searchSeq.current) setPage(next);
      setBusy(false);
    }, SEARCH_DEBOUNCE);
  }

  async function onFolderChange(v) {
    setFilterFolder(v);
    const q = search.trim();
    if (!q && !legacyPersonal) {
      const hit = cacheGet(pageKey(v));
      if (hit) {
        setBusy(true);
        const now = await liveCounts(v);
        setBusy(false);
        if (countsMatch(now, hit.counts)) { setPage(hit.state); setCounts(now); return; }
      }
    }
    reloadPage({ folderId: v === "all" ? null : v, q });
  }

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

  function patchLocal(id, patch) {
    setPage((p) => (p ? { ...p, rows: p.rows.map((w) => (w.id === id ? { ...w, ...patch } : w)) } : p));
    setLegacyPersonal((prev) => (prev ? prev.map((w) => (w.id === id ? { ...w, ...patch } : w)) : prev));
  }

  function applyPron(wordId, pron) {
    patchLocal(wordId, { pron });
    const word = visible.find((w) => w.id === wordId);
    if (word) cachePron(session, word, pron);
  }

  async function addWord() {
    if (!de.trim() || !ru.trim()) return;
    if (imageUrl && !validImageUrl(imageUrl)) { alert("Ungültige Bild-URL."); return; }
    const id = `p_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const w = {
      de: clip(de.trim(), LIMIT.de), article: cleanArticle(article), ru: clip(ru.trim(), LIMIT.ru),
      example: clip(example.trim(), LIMIT.example), folderId: folderId || null, imageUrl: imageUrl || null,
      addedBy: session.uid, source: "personal",
      ...searchFields({ de: de.trim(), ru: ru.trim() }),
    };
    try {
      await dbSet(`users/${session.uid}/words/${id}`, w);
      cachePush(`users/${session.uid}/words`, { ...w, id });
      const row = { ...w, id };
      setPage((p) => (p ? { ...p, rows: [row, ...p.rows] } : p));
      setLegacyPersonal((prev) => (prev ? [row, ...prev] : prev));
      setCounts((c) => (c ? { ...c, p: c.p + 1 } : c));
      setDe(""); setArticle(""); setRu(""); setExample(""); setFolderId(""); setImageUrl("");
      requestPronunciation(id, "personal").catch(() => {});
    } catch { alert("Speichern fehlgeschlagen."); }
  }

  async function deleteWord(word) {
    try {
      await dbDelete(`users/${session.uid}/words/${word.id}`);
      cacheRemove(`users/${session.uid}/words`, word.id);
      setPage((p) => (p ? { ...p, rows: p.rows.filter((w) => w.id !== word.id) } : p));
      setLegacyPersonal((prev) => (prev ? prev.filter((w) => w.id !== word.id) : prev));
      setCounts((c) => (c ? { ...c, p: Math.max(0, c.p - 1) } : c));
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
    const word = visible.find((w) => w.id === edit.id);
    if (!word) return;
    const res = validateWordInput(edit, { requireRu: true });
    if (!res.ok) { alert(res.error); return; }
    const changedDe = germanChanged(word, res.clean);
    const patch = {
      ...res.clean, folderId: edit.folderId || null, deRev: nextDeRev(word, res.clean),
      ...searchFields(res.clean),
      updatedAt: serverTimestamp(), updatedBy: session.uid,
    };
    try {
      await dbSet(`users/${session.uid}/words/${edit.id}`, patch);
      const localPatch = { ...patch, updatedAt: Date.now() };
      cacheUpdate(`users/${session.uid}/words`, edit.id, localPatch);
      patchLocal(edit.id, localPatch);
      setEdit(null);
      if (changedDe) requestPronunciation(edit.id, "personal").catch(() => {});
    } catch { alert("Speichern fehlgeschlagen."); }
  }

  const rows = page ? page.rows : [];
  const q = search.trim().toLowerCase();
  const legacyRows = (legacyPersonal || []).filter((w) => {
    const mf = filterFolder === "all" || w.folderId === filterFolder;
    const ms = !q || (w.de || "").toLowerCase().startsWith(q);
    return mf && ms;
  });
  const visible = [...rows, ...legacyRows]
    .map((w) => (w.source === "global" ? withTrans(w, session.lang) : w));
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
      <input placeholder="🔍 Deutsches Wort suchen…" value={search} onChange={(e) => onSearchChange(e.target.value)} />
      <select value={filterFolder} onChange={(e) => onFolderChange(e.target.value)}>
        <option value="all">Alle Ordner</option>
        {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
      </select>
    </div>
    <div className="sec-label">Wörter ({visible.length}{page && !page.exhausted ? "+" : ""})</div>
    <div className="word-list">
      {visible.length === 0 && <div className="empty" style={{ padding: 24 }}><p>{busy ? "Lädt…" : "Keine Wörter gefunden."}</p></div>}
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
          <div className="word-item" key={w.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 9 }}>
            {}
            <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0, cursor: "pointer" }} onClick={() => setPreview(w.id)}>
              {w.imageUrl && validImageUrl(w.imageUrl) ? <img src={cldImg(w.imageUrl, 200)} className="wi-img" alt="" loading="lazy" decoding="async" /> : <div className="wi-img-placeholder">🔤</div>}
              <div className="wi-text">
                <div className="wi-de">{w.article && <span className="wi-article">{w.article}</span>}{w.de}</div>
                <div className="wi-ru">{w.ru}{w.example && <span style={{ fontStyle: "italic", color: "#aaa" }}> — {w.example}</span>}</div>
              </div>
            </div>
            {}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", borderTop: "1px solid var(--ivory-dark)", paddingTop: 8 }}>
              {(() => {
                const p = progress[w.id];
                const eff = effProgress(w, p) || {};
                const base = { fontSize: 12, color: "var(--ink-soft)" };
                if (!p) return <span style={base}>🌱 Noch nicht gelernt</span>;
                const level = eff.level || 0;
                return (
                  <span style={{ ...base, display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span title={`Stufe ${level} von 5`}>{lvlEmoji(level)} Stufe {level}</span>
                    <span style={{ color: "var(--ivory-dark)" }}>·</span>
                    <span>🔄 {nextReviewText(eff.due)}</span>
                  </span>
                );
              })()}
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {folder && <span className="wi-folder">{folder.icon} {folder.name}</span>}
                <span className={`wi-badge ${w.source === "global" ? "badge-g" : "badge-p"}`}>{w.source === "global" ? "Kurs" : "Ich"}</span>
                {isOwn && <button className="btn-sm" onClick={() => startEdit(w)} title="Bearbeiten">✏️</button>}
                {isOwn && <button className="btn-del" onClick={() => deleteWord(w)}>✕</button>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
    {page && !page.exhausted && (
      <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
        <button className="btn-sm" onClick={more} disabled={busy}>{busy ? "⏳ Lädt…" : "Mehr laden"}</button>
      </div>
    )}
    {preview && (() => {
      const pw = visible.find((w) => w.id === preview);
      if (!pw) return null;
      return (
        <WordCardModal word={pw} folders={folders} session={session} trans={trans}
          onTranslated={(id, t) => setTrans((prev) => ({ ...prev, [id]: t }))}
          onPron={applyPron}
          onClose={() => setPreview(null)} />
      );
    })()}
  </>);
}
