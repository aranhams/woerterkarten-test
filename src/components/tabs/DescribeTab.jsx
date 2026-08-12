import { useState, useEffect, useRef } from "react";
import { serverTimestamp } from "firebase/firestore";
import { LIMIT } from "../../lib/constants";
import { validImageUrl, cldImg } from "../../lib/format";
import { descFresh, buildDesc } from "../../lib/word";
import { loadGlobalFolders } from "../../data/loaders";
import { newPageState, loadNextPage, countWords } from "../../data/pagination";
import { usePronunciation } from "../../data/usePron";
import { dbSet } from "../../data/db";
import { SpokenWord } from "../Pronunciation";

const SEARCH_DEBOUNCE = 350;
const MIN_QUERY = 2;

export function DescribeTab({ session }) {
  const [page, setPage] = useState(null);
  const [folders, setFolders] = useState([]);
  const [filterFolder, setFilterFolder] = useState("all");
  const [total, setTotal] = useState(null);
  const [cardIdx, setCardIdx] = useState(0);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [rowMsg, setRowMsg] = useState(null);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const searchTimer = useRef(null);
  const searchSeq = useRef(0);

  const folderScope = (fid) => (!fid || fid === "all" ? null : fid);

  useEffect(() => {
    (async () => {
      const [gf, first, n] = await Promise.all([
        loadGlobalFolders(),
        loadNextPage(newPageState({ uid: session.uid, teacher: true })),
        countWords({ source: "global", uid: session.uid, teacher: true }),
      ]);
      setFolders(gf);
      setPage(first);
      setTotal(n);
      setLoading(false);
    })();
  }, []);

  const rows = page ? page.rows : [];
  const searching = !!search.trim();
  const current = rows[cardIdx] || null;

  function resetTo(next, n) {
    setPage(next);
    setCardIdx(0);
    setRevealed(false);
    setEditing(null);
    if (n !== undefined) setTotal(n);
  }

  async function onFolderChange(v) {
    setFilterFolder(v);
    setBusy(true);
    const q = search.trim();
    const [next, n] = await Promise.all([
      loadNextPage(newPageState({ uid: session.uid, teacher: true, folderId: folderScope(v), q })),
      q ? Promise.resolve(undefined) : countWords({ source: "global", uid: session.uid, teacher: true, folderId: folderScope(v) }),
    ]);
    resetTo(next, q ? undefined : n);
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
      const next = await loadNextPage(newPageState({ uid: session.uid, teacher: true, folderId: folderScope(filterFolder), q }));
      if (seq === searchSeq.current) resetTo(next);
      setBusy(false);
    }, SEARCH_DEBOUNCE);
  }

  function applyDesc(wordId, desc) {
    setPage((p) => (p ? { ...p, rows: p.rows.map((w) => (w.id === wordId ? { ...w, desc } : w)) } : p));
  }

  function applyPron(wordId, pron) {
    setPage((p) => (p ? { ...p, rows: p.rows.map((w) => (w.id === wordId ? { ...w, pron } : w)) } : p));
  }

  function flashRow(id, text) {
    setRowMsg({ id, text });
    setTimeout(() => setRowMsg((r) => (r && r.id === id && r.text === text ? null : r)), 2500);
  }

  async function go(delta) {
    const target = cardIdx + delta;
    if (target < 0 || busy) return;
    if (target >= rows.length) {
      if (!page || page.exhausted) return;
      setBusy(true);
      const next = await loadNextPage(page);
      setPage(next);
      setBusy(false);
      if (target >= next.rows.length) return;
    }
    setRevealed(false);
    setEditing(null);
    setCardIdx(target);
  }

  async function saveDesc(w) {
    const desc = buildDesc(editing.text, w.de);
    setSaving(true);
    try {
      await dbSet(`global_words/${w.id}`, { desc, updatedAt: serverTimestamp(), updatedBy: session.uid });
      applyDesc(w.id, desc);
      setEditing(null);
      flashRow(w.id, desc ? "✓ Beschreibung gespeichert" : "✓ Beschreibung entfernt");
    } catch {
      flashRow(w.id, "⚠ Keine Berechtigung.");
    } finally {
      setSaving(false);
    }
  }

  usePronunciation(revealed ? current : null, session, applyPron);

  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  const atLast = cardIdx >= rows.length - 1 && (!page || page.exhausted);
  const posLabel = `${rows.length ? cardIdx + 1 : 0} / ${searching ? rows.length : (total ?? rows.length)}`;

  return (<>
    <div className="filter-bar">
      <input placeholder="🔍 Wörter suchen…" value={search} onChange={(e) => onSearchChange(e.target.value)} />
      <select value={filterFolder} onChange={(e) => onFolderChange(e.target.value)}>
        <option value="all">Alle Ordner</option>
        {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
      </select>
    </div>

    {!current ? (
      <div className="empty" style={{ padding: 40 }}>
        <div className="emoji">🃏</div>
        <p>{busy ? "Lädt…" : searching ? "Keine Treffer." : "Noch keine Kurswörter."}</p>
      </div>
    ) : (() => {
      const w = current;
      const folder = folders.find((f) => f.id === w.folderId);
      const fresh = descFresh(w);
      const isEditing = editing && editing.id === w.id;
      const hasImage = w.imageUrl && validImageUrl(w.imageUrl);
      return (<>
        <div className="dsc-nav">
          <button className="dsc-nav-btn" onClick={() => go(-1)} disabled={busy || cardIdx <= 0} aria-label="Vorherige Karte">‹</button>
          <span className="dsc-nav-pos">{busy ? "⏳" : posLabel}</span>
          <button className="dsc-nav-btn" onClick={() => go(1)} disabled={busy || atLast} aria-label="Nächste Karte">›</button>
        </div>

        <div className="fc-wrap">
          <div className="fc" translate="no" onClick={() => !revealed && !isEditing && setRevealed(true)} style={{ padding: 32, alignItems: "stretch", justifyContent: "flex-start", textAlign: "left" }}>
            {folder && <div className="fc-folder">{folder.icon} {folder.name}</div>}

            <div className="dsc-tag">Beschreibung</div>

            {isEditing ? (
              <div onClick={(e) => e.stopPropagation()}>
                <textarea className="dsc-desc-edit" rows={4} autoFocus maxLength={LIMIT.desc}
                  placeholder="Beschreibung für die Klasse eingeben…"
                  value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
                <div className="dsc-desc-actions">
                  <button className="btn-sm" onClick={() => saveDesc(w)} disabled={saving}>{saving ? "Speichert…" : "Speichern"}</button>
                  <button className="btn-sm" onClick={() => setEditing(null)} disabled={saving}>Abbrechen</button>
                  <span className="dsc-desc-count">{editing.text.length} / {LIMIT.desc}</span>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 24, lineHeight: 1.5, color: "var(--ink)", marginTop: 12, minHeight: 64 }}>
                {fresh
                  ? `„${w.desc.text}"`
                  : <span style={{ color: "var(--ink-soft)", fontStyle: "italic", fontSize: 19 }}>— noch keine Beschreibung</span>}
              </div>
            )}

            <hr style={{ border: 0, borderTop: "1px solid var(--ivory-dark)", margin: "18px 0", width: "100%" }} />

            <section style={{ width: "100%", textAlign: "center" }}>
              <div className="fc-hint">Wort</div>
              {!revealed ? (
                <div className="fc-tap">Tippe, um das Wort zu sehen</div>
              ) : (<>
                {hasImage && <img src={cldImg(w.imageUrl, 600)} className="fc-img" alt="" decoding="async" style={{ marginTop: 8, marginBottom: 12, marginLeft: "auto", marginRight: "auto", width: 180, height: 180, display: "block" }} />}
                {w.article && <div className="fc-article" style={{ marginTop: 8, fontSize: 20 }}>{w.article}</div>}
                <SpokenWord word={w} style={{ fontSize: 34 }} />
                {w.ru && <div className="fc-ru" style={{ opacity: 0.7, fontSize: 18 }}>{w.ru}</div>}
              </>)}
            </section>

            {!isEditing && (
              <div className="dsc-card-tools">
                <button className="dsc-icon-btn" onClick={(e) => { e.stopPropagation(); setEditing({ id: w.id, text: fresh ? w.desc.text : "" }); }}
                  title={fresh ? "Beschreibung bearbeiten" : "Beschreibung hinzufügen"} aria-label="Beschreibung bearbeiten">
                  {fresh ? "✎" : "＋"}
                </button>
              </div>
            )}
          </div>
        </div>

        {rowMsg && rowMsg.id === w.id && (
          <div style={{
            padding: "6px 10px", borderRadius: 8, fontSize: 12, fontWeight: 500, marginTop: 12, textAlign: "center",
            background: rowMsg.text.startsWith("⚠") ? "var(--red-pale)" : "var(--sage-pale)",
            color: rowMsg.text.startsWith("⚠") ? "var(--red-soft)" : "var(--sage)",
          }}>{rowMsg.text}</div>
        )}
      </>);
    })()}
  </>);
}
