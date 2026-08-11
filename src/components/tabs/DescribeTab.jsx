import { useState, useEffect, useRef } from "react";
import { WORD_PAGE_SERVER, DESC_V } from "../../lib/constants";
import { validImageUrl, cldImg } from "../../lib/format";
import { descFresh } from "../../lib/word";
import { describeWord } from "../../lib/api";
import { loadGlobalFolders } from "../../data/loaders";
import { newPageState, loadNextPage, countWords, ensureWindow, windowRows, canGoNext, pageCount } from "../../data/pagination";
import { DescribeCardModal } from "../DescribeCardModal";
import { SpokenButton } from "../Pronunciation";

const SEARCH_DEBOUNCE = 350;
const MIN_QUERY = 2;
const GEN_THROTTLE_MS = 300;

export function DescribeTab({ session }) {
  const [page, setPage] = useState(null);
  const [folders, setFolders] = useState([]);
  const [filterFolder, setFilterFolder] = useState("all");
  const [total, setTotal] = useState(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showWords, setShowWords] = useState(false);
  const [revealedRows, setRevealedRows] = useState(() => new Set());
  const [preview, setPreview] = useState(null);
  const [rowMsg, setRowMsg] = useState(null);
  const [regen, setRegen] = useState(() => new Set());
  const [genActive, setGenActive] = useState(() => new Set());
  const generating = useRef(new Set());
  const markGen = (id, on) => {
    if (on) generating.current.add(id); else generating.current.delete(id);
    setGenActive((s) => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; });
  };
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

  async function goto(i) {
    if (!page || busy || i < 0) return;
    setBusy(true);
    const next = await ensureWindow(page, i, WORD_PAGE_SERVER);
    setPage(next);
    if (i === 0 || next.rows.length > i * WORD_PAGE_SERVER) setPageIdx(i);
    setBusy(false);
  }

  async function onFolderChange(v) {
    setFilterFolder(v);
    setBusy(true);
    setPageIdx(0);
    const q = search.trim();
    const [next, n] = await Promise.all([
      loadNextPage(newPageState({ uid: session.uid, teacher: true, folderId: folderScope(v), q })),
      q ? Promise.resolve(null) : countWords({ source: "global", uid: session.uid, teacher: true, folderId: folderScope(v) }),
    ]);
    setPage(next);
    if (!q) setTotal(n);
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
      if (seq === searchSeq.current) { setPage(next); setPageIdx(0); }
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

  const searching = !!search.trim();
  const visible = windowRows(page, pageIdx, WORD_PAGE_SERVER);

  // Auto-generate on load: for the visible page only, request a description for each
  // word that lacks a fresh one. In-flight dedupe via generating.current; sequential
  // with a small delay so the per-minute rate limit is not tripped. Re-runs when the
  // visible set or any freshness changes (a saved desc removes that word from the todo).
  const visibleSig = visible.map((w) => `${w.id}:${descFresh(w) ? 1 : 0}`).join(",");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const w of visible) {
        if (cancelled) return;
        if (descFresh(w) || generating.current.has(w.id)) continue;
        markGen(w.id, true);
        try {
          const r = await describeWord({ wordId: w.id, word: w.de, article: w.article });
          if (!cancelled && r.description) {
            applyDesc(w.id, { text: r.description, de: w.de, v: DESC_V, st: "ready" });
          }
        } catch {
          // leave it un-fresh; a later visit (or manual regen) retries
        } finally {
          markGen(w.id, false);
        }
        if (cancelled) return;
        await new Promise((res) => setTimeout(res, GEN_THROTTLE_MS));
      }
    })();
    return () => { cancelled = true; };
  }, [visibleSig]);

  async function regenerate(w) {
    if (regen.has(w.id)) return;
    setRegen((s) => new Set(s).add(w.id));
    try {
      const r = await describeWord({ wordId: w.id, word: w.de, article: w.article, force: true });
      if (r.description) {
        applyDesc(w.id, { text: r.description, de: w.de, v: DESC_V, st: "ready" });
        flashRow(w.id, "✓ Neu erstellt");
      }
    } catch (e) {
      flashRow(w.id, "⚠ " + (e.message || "Fehlgeschlagen"));
    } finally {
      setRegen((s) => { const n = new Set(s); n.delete(w.id); return n; });
    }
  }


  function toggleRow(id) {
    setRevealedRows((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setShowWords((v) => !v);
    setRevealedRows(new Set());
  }

  const pages = total != null && !searching ? pageCount(total, WORD_PAGE_SERVER) : null;
  const atLastPage = pages != null ? pageIdx >= pages - 1 : !canGoNext(page, pageIdx, WORD_PAGE_SERVER);

  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  return (<>
    <div className="filter-bar">
      <input placeholder="🔍 Wörter suchen…" value={search} onChange={(e) => onSearchChange(e.target.value)} />
      <select value={filterFolder} onChange={(e) => onFolderChange(e.target.value)}>
        <option value="all">Alle Ordner</option>
        {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
      </select>
    </div>

    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 9, marginTop: 2 }}>
      <div className="sec-label" style={{ margin: 0 }}>Kurswörter ({searching ? visible.length : (total ?? visible.length)})</div>
      <button className="btn-sm" onClick={toggleAll} disabled={!visible.length}>
        {showWords ? "Wörter verbergen" : "Wörter zeigen"}
      </button>
    </div>
    <div className="word-list">
      {visible.length === 0 && <div className="empty" style={{ padding: 24 }}><p>{busy ? "Lädt…" : searching ? "Keine Treffer." : "Noch keine Kurswörter."}</p></div>}
      {visible.map((w) => {
        const folder = folders.find((f) => f.id === w.folderId);
        const fresh = descFresh(w);
        const isGenerating = genActive.has(w.id) && !fresh;
        return (
          <div className="word-item" key={w.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 0 }}>
            <div className="dsc-riddle" onClick={() => setPreview(w.id)} style={{ cursor: "pointer" }}
              title="Karte öffnen">
              {fresh
                ? w.desc.text
                : <span style={{ color: "var(--ink-soft)", fontStyle: "italic" }}>{isGenerating ? "⏳ Beschreibung wird erstellt…" : "— noch keine Beschreibung"}</span>}
            </div>

            <div className="dsc-meta">
              {showWords || revealedRows.has(w.id)
                ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <SpokenButton word={w} />
                    <button type="button" className="dsc-word-btn" onClick={(e) => { e.stopPropagation(); toggleRow(w.id); }} title="Wort verbergen">
                      {w.article && <span className="wi-article">{w.article}</span>}{w.de}
                    </button>
                  </span>
                : <button type="button" className="dsc-hidden-btn" onClick={(e) => { e.stopPropagation(); toggleRow(w.id); }} title="Wort zeigen" aria-label="Wort zeigen">••••••</button>}
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
                {folder && <span className="wi-folder">{folder.icon} {folder.name}</span>}
                <button className="dsc-icon-btn" onClick={(e) => { e.stopPropagation(); regenerate(w); }} disabled={regen.has(w.id)}
                  title="Neue Beschreibung erstellen" aria-label="Neue Beschreibung erstellen">
                  {regen.has(w.id) ? "⏳" : "↻"}
                </button>
              </div>
            </div>
            {rowMsg && rowMsg.id === w.id && (
              <div style={{
                padding: "6px 10px", borderRadius: 8, fontSize: 12, fontWeight: 500, marginTop: 8,
                background: rowMsg.text.startsWith("⚠") ? "var(--red-pale)" : "var(--sage-pale)",
                color: rowMsg.text.startsWith("⚠") ? "var(--red-soft)" : "var(--sage)",
              }}>{rowMsg.text}</div>
            )}
          </div>
        );
      })}
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

    {preview && (() => {
      const pw = visible.find((w) => w.id === preview);
      if (!pw) return null;
      return (
        <DescribeCardModal word={pw} folders={folders} session={session}
          onPron={applyPron} onClose={() => setPreview(null)} />
      );
    })()}
  </>);
}
