import { useState, useEffect, useRef } from "react";
import { DESC_V } from "../../lib/constants";
import { validImageUrl, cldImg } from "../../lib/format";
import { descFresh } from "../../lib/word";
import { describeWord } from "../../lib/api";
import { loadGlobalFolders } from "../../data/loaders";
import { newPageState, loadNextPage, countWords } from "../../data/pagination";
import { usePronunciation } from "../../data/usePron";
import { SpokenWord } from "../Pronunciation";
import { openChannel, cardPayload, PRESENT_PARAM } from "../../lib/present";

const SEARCH_DEBOUNCE = 350;
const MIN_QUERY = 2;
const GEN_THROTTLE_MS = 300;
const PREFETCH = 3;

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

  const rows = page ? page.rows : [];
  const searching = !!search.trim();
  const current = rows[cardIdx] || null;

  async function resetTo(next, n) {
    setPage(next);
    setCardIdx(0);
    setRevealed(false);
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
    await resetTo(next, q ? undefined : n);
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
      if (seq === searchSeq.current) await resetTo(next);
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
    setCardIdx(target);
  }

  // Auto-generate for the current card and a small look-ahead window so flipping forward
  // rarely lands on an empty card. In-flight dedupe via generating.current; sequential with
  // a small delay to respect the per-minute rate limit. Re-runs when the position or any
  // freshness in the window changes.
  const genWindow = rows.slice(cardIdx, cardIdx + PREFETCH);
  const windowSig = genWindow.map((w) => `${w.id}:${descFresh(w) ? 1 : 0}`).join(",");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const w of genWindow) {
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
  }, [windowSig]);

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

  usePronunciation(revealed ? current : null, session, applyPron);

  const [presenting, setPresenting] = useState(false);
  const presentWin = useRef(null);
  const channel = useRef(null);

  const currentFolder = current ? folders.find((f) => f.id === current.folderId) : null;
  function broadcast() {
    if (!channel.current) return;
    channel.current.postMessage({ type: "state", card: cardPayload(current, currentFolder), revealed });
  }
  // Push state to the audience window whenever the card, reveal, or its pronunciation
  // changes; the audience also re-requests on its own "hello" when it (re)connects.
  useEffect(() => { if (presenting) broadcast(); }, [presenting, current?.id, revealed, current?.pron?.url]);

  function stopPresenting() {
    if (channel.current) { channel.current.postMessage({ type: "closed" }); channel.current.close(); channel.current = null; }
    if (presentWin.current && !presentWin.current.closed) presentWin.current.close();
    presentWin.current = null;
    setPresenting(false);
  }

  function startPresenting() {
    if (presenting) { stopPresenting(); return; }
    const ch = openChannel();
    if (!ch) { alert("Präsentationsmodus wird von diesem Browser nicht unterstützt."); return; }
    ch.onmessage = (e) => { if (e.data && e.data.type === "hello") broadcast(); };
    channel.current = ch;
    const url = `${window.location.pathname}?${PRESENT_PARAM}=1`;
    presentWin.current = window.open(url, "dw_present", "width=1280,height=800");
    setPresenting(true);
  }

  useEffect(() => () => {
    if (channel.current) { try { channel.current.postMessage({ type: "closed" }); } catch {} channel.current.close(); }
    if (presentWin.current && !presentWin.current.closed) presentWin.current.close();
  }, []);

  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  const atLast = cardIdx >= rows.length - 1 && (!page || page.exhausted);
  const posLabel = searching
    ? `${rows.length ? cardIdx + 1 : 0} / ${rows.length}`
    : `${rows.length ? cardIdx + 1 : 0} / ${total ?? rows.length}`;

  return (<>
    <div className="filter-bar">
      <input placeholder="🔍 Wörter suchen…" value={search} onChange={(e) => onSearchChange(e.target.value)} />
      <select value={filterFolder} onChange={(e) => onFolderChange(e.target.value)}>
        <option value="all">Alle Ordner</option>
        {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
      </select>
      <button type="button" className={`dsc-present-btn${presenting ? " active" : ""}`} onClick={startPresenting}
        title={presenting ? "Präsentation beenden" : "In zweitem Fenster präsentieren"}>
        {presenting ? "⏹ Beenden" : "📺 Präsentieren"}
      </button>
    </div>
    {presenting && (
      <div className="dsc-present-note">
        📺 Präsentationsfenster aktiv — auf den Beamer ziehen &amp; Vollbild (F11). Bei Bedarf auf „erweiterten" Bildschirm umstellen, nicht „duplizieren".
      </div>
    )}

    {!current ? (
      <div className="empty" style={{ padding: 40 }}>
        <div className="emoji">🃏</div>
        <p>{busy ? "Lädt…" : searching ? "Keine Treffer." : "Noch keine Kurswörter."}</p>
      </div>
    ) : (() => {
      const w = current;
      const folder = folders.find((f) => f.id === w.folderId);
      const fresh = descFresh(w);
      const isGenerating = genActive.has(w.id) && !fresh;
      const hasImage = w.imageUrl && validImageUrl(w.imageUrl);
      return (<>
        <div className="dsc-nav">
          <button className="dsc-nav-btn" onClick={() => go(-1)} disabled={busy || cardIdx <= 0} aria-label="Vorherige Karte">‹</button>
          <span className="dsc-nav-pos">{busy ? "⏳" : posLabel}</span>
          <button className="dsc-nav-btn" onClick={() => go(1)} disabled={busy || atLast} aria-label="Nächste Karte">›</button>
        </div>

        <div className="fc-wrap">
          <div className="fc" translate="no" onClick={() => !revealed && setRevealed(true)} style={{ padding: 32, alignItems: "stretch", justifyContent: "flex-start", textAlign: "left" }}>
            {folder && <div className="fc-folder">{folder.icon} {folder.name}</div>}

            <div className="dsc-tag">Beschreibung</div>
            <div style={{ fontSize: 24, lineHeight: 1.5, color: "var(--ink)", marginTop: 12, minHeight: 64 }}>
              {fresh
                ? `„${w.desc.text}"`
                : <span style={{ color: "var(--ink-soft)", fontStyle: "italic", fontSize: 19 }}>{isGenerating ? "⏳ Beschreibung wird erstellt…" : "— noch keine Beschreibung"}</span>}
            </div>

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

            <div className="dsc-card-tools">
              <button className="dsc-icon-btn" onClick={(e) => { e.stopPropagation(); regenerate(w); }} disabled={regen.has(w.id)}
                title="Neue Beschreibung erstellen" aria-label="Neue Beschreibung erstellen">
                {regen.has(w.id) ? "⏳" : "↻"}
              </button>
            </div>
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
