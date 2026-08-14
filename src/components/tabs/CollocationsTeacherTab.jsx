import { useState, useEffect, useRef } from "react";
import { loadGlobalFolders } from "../../data/loaders";
import { loadCollocationSet } from "../../data/collocations";
import { newPageState, loadNextPage, countWords, ensureWindow, windowRows, canGoNext, pageCount } from "../../data/pagination";
import { WORD_PAGE_SERVER } from "../../lib/constants";
import { validImageUrl, cldImg } from "../../lib/format";
import { collocationSync, bulkActivateCollocations, bulkDeactivateCollocations } from "../../lib/api";

const SEARCH_DEBOUNCE = 350;
const MIN_QUERY = 2;

const MAX_OPTIONS = 20;
const SERVED_WRONG = 3;
// Mirrors WORD_CATEGORIES / PARTNER_LABELS in api/_collocations.js (validated server-side).
const WORD_CATEGORIES = ["Nomen", "Verb", "Reflexivverb", "Trennbares Verb", "Adjektiv", "Adverb", "Sonstige"];
const PARTNER_LABELS = ["Nomen", "Verb", "Adjektiv", "Adverb"];
const countCorrect = (opts) => (opts || []).filter((o) => o.correct).length;
const countWrong = (opts) => (opts || []).filter((o) => !o.correct).length;
// Ready = we can always serve 3 wrong + 1 correct: at least one correct and at least three wrong.
const isReady = (set) => set?.optedIn === true && countCorrect(set.options) >= 1 && countWrong(set.options) >= SERVED_WRONG;

const normDe = (s) => String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

function SmartBatchButton({ selectedIds, sets, filteredWords, rowBusy, onActivate, onDeactivate }) {
  const selected = filteredWords.filter((w) => selectedIds.has(w.id));
  const loaded = selected.filter((w) => sets[w.id] !== undefined);
  if (selected.length === 0 || loaded.length === 0) {
    return <button className="btn-add" disabled>Aktivieren</button>;
  }
  const activeCount = loaded.filter((w) => sets[w.id]?.optedIn === true).length;
  const inactiveCount = loaded.length - activeCount;
  if (activeCount > 0 && inactiveCount === 0) {
    return <button className="btn-add" onClick={onDeactivate} disabled={rowBusy}>Deaktivieren</button>;
  }
  return <button className="btn-add" onClick={onActivate} disabled={rowBusy}>Aktivieren</button>;
}

// The set snapshots the word's German (de/deRev) at generation. If the teacher later edits
// the word, the stored options may no longer fit — surface a hint rather than silently
// serving stale collocations. deRev is the primary signal; de covers pre-snapshot sets.
function hasDrifted(word, set) {
  if (!word || !set || set.optedIn !== true || (set.options || []).length === 0) return false;
  if ((word.deRev || 0) !== (set.deRev || 0)) return true;
  return !!set.de && normDe(word.de) !== normDe(set.de);
}

export function CollocationsTeacherTab({ session }) {
  const [page, setPage] = useState(null);
  const [folders, setFolders] = useState([]);
  const [filterFolder, setFilterFolder] = useState("all");
  const [total, setTotal] = useState(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [expandedId, setExpandedId] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activationFilter, setActivationFilter] = useState("all");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const searchTimer = useRef(null);
  const searchSeq = useRef(0);
  const [sets, setSets] = useState({});
  const [rowBusy, setRowBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [edit, setEdit] = useState(null);
  const [manual, setManual] = useState(null);

  const folderScope = (fid) => (!fid || fid === "all" ? null : fid);

  async function loadListPage({ folderId = folderScope(filterFolder), q = searchQuery.trim(), pageIndex = 0 } = {}) {
    setBusy(true);
    const [next, n] = await Promise.all([
      loadNextPage(newPageState({ uid: session.uid, teacher: true, folderId, q })),
      countWords({ source: "global", uid: session.uid, teacher: true, folderId, q }),
    ]);
    setPage(next);
    setPageIdx(pageIndex);
    setExpandedId(null);
    setSelectionMode(false);
    setSelectedIds(new Set());
    setTotal(n);
    setBusy(false);
  }

  function onSearchChange(v) {
    setSearchQuery(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const seq = ++searchSeq.current;
    const q = v.trim();
    searchTimer.current = setTimeout(async () => {
      if (q.length > 0 && q.length < MIN_QUERY) return;
      if (seq !== searchSeq.current) return;
      await loadListPage({ q, pageIndex: 0 });
    }, SEARCH_DEBOUNCE);
  }

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

  const pagedWords = page ? windowRows(page, pageIdx, WORD_PAGE_SERVER) : [];

  const filteredWords = pagedWords.filter((w) => {
    const set = sets[w.id];
    if (activationFilter === "active") return set?.optedIn === true;
    if (activationFilter === "inactive") return set !== undefined && set?.optedIn !== true;
    return true;
  });

  useEffect(() => {
    if (!pagedWords.length) return;
    let cancelled = false;
    (async () => {
      const needed = pagedWords.filter((w) => sets[w.id] === undefined);
      if (!needed.length) return;
      const loaded = await Promise.all(needed.map((w) => loadCollocationSet(w.id).catch(() => null)));
      if (cancelled) return;
      setSets((prev) => {
        const next = { ...prev };
        needed.forEach((w, i) => { if (loaded[i] !== undefined) next[w.id] = loaded[i]; });
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [pagedWords.map((w) => w.id).join(",")]);

  function flash(text) {
    setMsg(text);
    setTimeout(() => setMsg((m) => (m === text ? null : m)), 2800);
  }
  const putSet = (wordId, set) => setSets((s) => ({ ...s, [wordId]: set }));

  async function onFolderChange(v) {
    setFilterFolder(v);
    setEdit(null);
    setManual(null);
    await loadListPage({ folderId: folderScope(v), q: searchQuery.trim(), pageIndex: 0 });
  }

  async function goto(i) {
    if (!page || busy || i < 0) return;
    setBusy(true);
    const next = await ensureWindow(page, i, WORD_PAGE_SERVER);
    setPage(next);
    if (i === 0 || next.rows.length > i * WORD_PAGE_SERVER) setPageIdx(i);
    setExpandedId(null);
    setEdit(null);
    setManual(null);
    setBusy(false);
  }

  function toggleExpand(id) {
    setExpandedId((cur) => (cur === id ? null : id));
    setEdit(null);
    setManual(null);
  }

  async function act(action, payload, okMsg) {
    if (rowBusy) return null;
    setRowBusy(true);
    try {
      const r = await collocationSync(action, payload);
      if (okMsg) flash(okMsg);
      return r;
    } catch (e) {
      flash("⚠ " + (e.message || "Fehler"));
      return null;
    } finally {
      setRowBusy(false);
    }
  }

  async function optIn(w) {
    const r = await act("opt-in", { wordId: w.id }, "✓ Aktiviert");
    if (r) putSet(w.id, r.set);
  }
  async function optOut(w) {
    const r = await act("opt-out", { wordId: w.id }, "Deaktiviert");
    if (r) putSet(w.id, r.set);
  }
  async function generate(w) {
    const r = await act("generate", { wordId: w.id }, "✓ KI-Optionen ergänzt");
    if (r) putSet(w.id, r.set);
  }
  async function resync(w) {
    const r = await act("resync", { wordId: w.id }, "✓ Als aktuell markiert");
    if (r) putSet(w.id, r.set);
  }
  async function toggleCorrect(w, optionId) {
    const r = await act("toggle-correct", { wordId: w.id, optionId });
    if (r) putSet(w.id, r.set);
  }
  async function removeOption(w, optionId) {
    const r = await act("remove-option", { wordId: w.id, optionId }, "Entfernt");
    if (r) putSet(w.id, r.set);
  }
  async function saveEdit(w) {
    const r = await act("edit-option", { wordId: w.id, optionId: edit.optionId, text: edit.text }, "✓ Gespeichert");
    if (r) { putSet(w.id, r.set); setEdit(null); }
  }
  async function saveManual(w) {
    const r = await act("add-option", { wordId: w.id, text: manual.text, correct: manual.correct }, "✓ Hinzugefügt");
    if (r) { putSet(w.id, r.set); setManual(null); }
  }
  async function saveCategory(w, cat, partnerLabel) {
    const r = await act("set-category", { wordId: w.id, cat, partnerLabel }, "✓ Wortart gespeichert");
    if (r) putSet(w.id, r.set);
  }

  function enterSelectionMode() {
    setSelectionMode(true);
    setSelectedIds(new Set());
    setExpandedId(null);
    setEdit(null);
    setManual(null);
  }

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }

  function toggleSelection(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelectedIds(new Set(filteredWords.map((w) => w.id)));
  }

  function selectNone() {
    setSelectedIds(new Set());
  }

  async function batchActivate() {
    if (rowBusy || selectedIds.size === 0) return;
    setRowBusy(true);
    try {
      const ids = [...selectedIds];
      const r = await bulkActivateCollocations(ids);
      for (const id of ids) {
        const set = await loadCollocationSet(id).catch(() => null);
        if (set) putSet(id, set);
      }
      flash(`✓ ${ids.length - (r.skipped || 0)} Wörter aktiviert${r.skipped ? `, ${r.skipped} übersprungen` : ""}`);
      exitSelectionMode();
    } catch (e) {
      flash("⚠ " + (e.message || "Fehler"));
    } finally {
      setRowBusy(false);
    }
  }

  async function batchDeactivate() {
    if (rowBusy || selectedIds.size === 0) return;
    setRowBusy(true);
    try {
      const ids = [...selectedIds];
      await bulkDeactivateCollocations(ids);
      for (const id of ids) {
        const set = await loadCollocationSet(id).catch(() => null);
        if (set) putSet(id, set);
      }
      flash(`✓ ${ids.length} Wörter deaktiviert`);
      exitSelectionMode();
    } catch (e) {
      flash("⚠ " + (e.message || "Fehler"));
    } finally {
      setRowBusy(false);
    }
  }

  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  const pages = total != null ? pageCount(total, WORD_PAGE_SERVER) : null;
  const atLastPage = pages != null ? pageIdx >= pages - 1 : !canGoNext(page, pageIdx, WORD_PAGE_SERVER);

  return (<>
    <div className="filter-bar">
      {!selectionMode && (
        <button className="btn-sm" onClick={enterSelectionMode}
          title="Mehrere Wörter auswählen und aktivieren/deaktivieren"
          style={{ flex: "none", padding: "9px 12px" }}>
          ☰
        </button>
      )}
      <input
        placeholder="🔍 Wörter suchen…"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        style={{ flex: 2, minWidth: 140 }}
      />
      <select value={filterFolder} onChange={(e) => onFolderChange(e.target.value)}>
        <option value="all">Alle Ordner</option>
        {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
      </select>
      <select value={activationFilter} onChange={(e) => { setActivationFilter(e.target.value); setExpandedId(null); }}>
        <option value="all">Alle Status</option>
        <option value="active">Aktiviert</option>
        <option value="inactive">Nicht aktiviert</option>
      </select>
    </div>

    {selectionMode && (
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14, padding: "10px 12px", background: "var(--ivory)", borderRadius: 8, border: "1px solid var(--ivory-dark)" }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{selectedIds.size} ausgewählt</span>
        <button className="btn-sm" onClick={selectAllVisible} disabled={rowBusy}>Alle auf Seite</button>
        <button className="btn-sm" onClick={selectNone} disabled={rowBusy}>Keine</button>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <SmartBatchButton
            selectedIds={selectedIds}
            sets={sets}
            filteredWords={filteredWords}
            rowBusy={rowBusy}
            onActivate={batchActivate}
            onDeactivate={batchDeactivate}
          />
          <button className="btn-sm" onClick={exitSelectionMode} disabled={rowBusy}>Abbrechen</button>
        </div>
      </div>
    )}

    {msg && (
      <div style={{
        padding: "8px 12px", borderRadius: 8, fontSize: 13, fontWeight: 500, marginBottom: 12, textAlign: "center",
        background: msg.startsWith("⚠") ? "var(--red-pale)" : "var(--sage-pale)",
        color: msg.startsWith("⚠") ? "var(--red-soft)" : "var(--sage)",
      }}>{msg}</div>
    )}

    <div className="word-list">
      {filteredWords.length === 0 && (
        <div className="empty" style={{ padding: 40 }}>
          <div className="emoji">🔗</div>
          <p>{busy ? "Lädt…" : pagedWords.length ? "Keine Wörter passen zum Filter." : "Noch keine Kurswörter."}</p>
        </div>
      )}
      {filteredWords.map((w) => {
        const folder = folders.find((f) => f.id === w.folderId);
        const set = sets[w.id];
        const isExpanded = expandedId === w.id;
        const optedIn = set?.optedIn === true;
        const options = set?.options || [];
        const nCorrect = countCorrect(options);
        const nWrong = countWrong(options);
        const ready = isReady(set);
        const drifted = hasDrifted(w, set);
        const wordCat = set?.cat || (w.article && ["der", "die", "das"].includes(w.article.trim().toLowerCase()) ? "Nomen" : null);

        return (
          <div key={w.id} className="word-item" style={{ flexDirection: "column", alignItems: "stretch", gap: 10, padding: 14 }}>
            <div
              onClick={() => toggleExpand(w.id)}
              style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0, cursor: "pointer" }}
            >
              {selectionMode && (
                <span onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(w.id)}
                    onChange={() => toggleSelection(w.id)}
                    disabled={rowBusy}
                    style={{ width: 18, height: 18, cursor: "pointer" }}
                  />
                </span>
              )}
              {w.imageUrl && validImageUrl(w.imageUrl) ? (
                <img src={cldImg(w.imageUrl, 200)} className="wi-img" alt="" loading="lazy" decoding="async" style={{ flexShrink: 0 }} />
              ) : (
                <div className="wi-img-placeholder" style={{ flexShrink: 0 }}>🔗</div>
              )}
              <div className="wi-text" style={{ flex: 1, minWidth: 0 }}>
                <div className="wi-de">
                  {w.article && <span className="wi-article">{w.article}</span>}{w.de}
                  {wordCat && <span className="pron-badge" style={{ marginLeft: 8 }}>{wordCat}</span>}
                </div>
                <div className="wi-ru" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {folder && <span>{folder.icon} {folder.name}</span>}
                </div>
              </div>
              {set === undefined ? (
                <span className="dsc-tag" style={{ marginTop: 0, background: "var(--ivory-dark)", color: "var(--ink-soft)" }}>Lädt…</span>
              ) : optedIn ? (
                <span className="dsc-tag" style={{ marginTop: 0, ...(ready ? {} : { color: "var(--red-soft)", background: "var(--red-pale)" }) }}>
                  {ready ? "übungsbereit" : nCorrect === 0 ? "keine richtige Antwort" : `noch ${SERVED_WRONG - nWrong} falsche nötig`}
                </span>
              ) : (
                <span className="dsc-tag" style={{ marginTop: 0, background: "var(--ivory-dark)", color: "var(--ink-soft)" }}>nicht aktiviert</span>
              )}
              <span style={{ fontSize: 18, color: "var(--ink-soft)", transform: isExpanded ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▼</span>
            </div>

            {isExpanded && (
              <div style={{ borderTop: "1px solid var(--ivory-dark)", paddingTop: 12 }}>
                {drifted && (
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 12px", borderRadius: 8, background: "var(--red-pale)", border: "1px solid var(--red-soft)", marginBottom: 12 }}>
                    <span style={{ fontSize: 13, color: "var(--red-soft)", fontWeight: 600, flex: "1 1 200px" }}>
                      ⚠ Das Wort wurde geändert{set.de && normDe(set.de) !== normDe(w.de) ? ` (früher „${set.de}")` : ""}. Die Optionen passen evtl. nicht mehr.
                    </span>
                    <button className="btn-sm" onClick={() => generate(w)} disabled={rowBusy || options.length >= MAX_OPTIONS} title="Neue passende Optionen ergänzen">🤖 Neu generieren</button>
                    <button className="btn-sm" onClick={() => resync(w)} disabled={rowBusy} title="Optionen sind noch passend – Hinweis ausblenden">✓ Passt noch</button>
                  </div>
                )}

                {set === undefined ? (
                  <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>Lädt…</p>
                ) : !optedIn ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <button className="btn-add" onClick={() => optIn(w)} disabled={rowBusy}>🔗 Aktivieren</button>
                    <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>Danach Optionen per KI vorschlagen lassen oder selbst eingeben.</span>
                  </div>
                ) : (<>
                  <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: "0 0 10px" }}>
                    Markiere die <strong>richtigen</strong> Kollokationen (✓) — mindestens eine richtige und {SERVED_WRONG} falsche.
                    Schüler sehen pro Frage {SERVED_WRONG + 1} zufällige Optionen (1 richtig, {SERVED_WRONG} falsch).
                  </p>

                  {/* Manual counterpart to AI categorization: without this, cat/partnerLabel can
                      only be set by "generate" — teachers building options by hand need a way. */}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12, padding: "8px 12px", background: "var(--ivory)", border: "1px solid var(--ivory-dark)", borderRadius: 8 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--ink-soft)" }}>
                      Wortart
                      <select value={set.cat || ""} disabled={rowBusy} aria-label="Wortart des Wortes"
                        onChange={(e) => saveCategory(w, e.target.value, set.partnerLabel || "")}
                        style={{ padding: "5px 8px", border: "1.5px solid var(--ivory-dark)", borderRadius: 7, fontSize: 12, background: "white", color: "var(--ink)", fontFamily: "inherit", outline: "none" }}>
                        <option value="">— wählen</option>
                        {WORD_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--ink-soft)" }}>
                      Optionen sind
                      <select value={set.partnerLabel || ""} disabled={rowBusy} aria-label="Wortart der Optionen"
                        onChange={(e) => saveCategory(w, set.cat || "", e.target.value)}
                        style={{ padding: "5px 8px", border: "1.5px solid var(--ivory-dark)", borderRadius: 7, fontSize: 12, background: "white", color: "var(--ink)", fontFamily: "inherit", outline: "none" }}>
                        <option value="">— wählen</option>
                        {PARTNER_LABELS.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </label>
                    {!set.partnerLabel && (
                      <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>Schüler sehen sonst keinen Hinweis zur Wortart</span>
                    )}
                  </div>

                  {options.length === 0 ? (
                    <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>Noch keine Optionen. Per KI vorschlagen lassen oder manuell hinzufügen.</p>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                      {options.map((o) => {
                        const isEditing = edit && edit.optionId === o.id;
                        return (
                          <div key={o.id} style={{
                            display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                            border: `1px solid ${o.correct ? "var(--sage)" : "var(--ivory-dark)"}`,
                            background: o.correct ? "var(--sage-pale)" : "white", borderRadius: 8,
                          }}>
                            <button onClick={() => toggleCorrect(w, o.id)} disabled={rowBusy}
                              title={o.correct ? "Nicht mehr als richtig markieren" : "Als richtig markieren"}
                              aria-label="Als richtig markieren" aria-pressed={o.correct} style={{
                                width: 22, height: 22, flexShrink: 0, borderRadius: 6, cursor: "pointer",
                                border: `2px solid ${o.correct ? "var(--sage)" : "var(--ivory-dark)"}`,
                                background: o.correct ? "var(--sage)" : "white", color: "white",
                                display: "flex", alignItems: "center", justifyContent: "center", padding: 0, fontSize: 13, fontWeight: 700,
                              }}>
                              {o.correct && "✓"}
                            </button>
                            {isEditing ? (
                              <>
                                <input autoFocus value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                                  onKeyDown={(e) => { if (e.key === "Enter") saveEdit(w); if (e.key === "Escape") setEdit(null); }}
                                  style={{ flex: 1, minWidth: 0, padding: "6px 9px", border: "1.5px solid var(--sage)", borderRadius: 7, fontSize: 14, outline: "none", fontFamily: "inherit" }} />
                                <button className="btn-sm" onClick={() => saveEdit(w)} disabled={rowBusy || !edit.text.trim()}>Speichern</button>
                                <button className="btn-sm" onClick={() => setEdit(null)} disabled={rowBusy}>Abbrechen</button>
                              </>
                            ) : (
                              <>
                                <span style={{ flex: 1, fontSize: 15, fontWeight: o.correct ? 600 : 400 }}>{o.text}</span>
                                <span className="pron-badge" style={{ background: "transparent", color: "var(--ink-soft)" }}>
                                  {o.source === "ai" ? "KI" : "Lehrer"} · {o.correct ? "richtig" : "falsch"}
                                </span>
                                <button className="btn-sm" onClick={() => setEdit({ optionId: o.id, text: o.text })} disabled={rowBusy} title="Bearbeiten">✎</button>
                                <button className="btn-del" onClick={() => removeOption(w, o.id)} disabled={rowBusy} title="Entfernen">✕</button>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <button className="btn-add" onClick={() => generate(w)} disabled={rowBusy || options.length >= MAX_OPTIONS}
                      title={options.length >= MAX_OPTIONS ? `Höchstens ${MAX_OPTIONS} Optionen` : "Optionen per KI ergänzen"}>
                      {rowBusy ? "⏳…" : `🤖 KI: ${Math.max(0, 4 - options.length) > 0 ? `auffüllen (${Math.max(0, 4 - options.length)})` : "+1 Option"}`}
                    </button>
                    <button className="btn-sm" onClick={() => setManual(manual ? null : { text: "", correct: nCorrect === 0 })} disabled={rowBusy || options.length >= MAX_OPTIONS}>
                      ＋ Option manuell
                    </button>
                    <button className="btn-sm danger" onClick={() => optOut(w)} disabled={rowBusy} style={{ marginLeft: "auto" }}>Deaktivieren</button>
                  </div>

                  {manual && (
                    <div style={{ marginTop: 12, padding: "12px 14px", background: "var(--ivory)", border: "1px solid var(--ivory-dark)", borderRadius: 10 }}>
                      <input placeholder="Option, z. B. beenden" value={manual.text} autoFocus
                        onChange={(e) => setManual({ ...manual, text: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter" && manual.text.trim()) saveManual(w); if (e.key === "Escape") setManual(null); }}
                        style={{ width: "100%", boxSizing: "border-box", padding: "9px 12px", border: "1.5px solid var(--ivory-dark)", borderRadius: 8, fontSize: 14, background: "white", color: "var(--ink)", outline: "none", fontFamily: "inherit", marginBottom: 10 }} />
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <div role="group" aria-label="Antworttyp"
                          style={{ display: "inline-flex", gap: 2, background: "var(--ivory-dark)", borderRadius: 99, padding: 3 }}>
                          <button type="button" onClick={() => setManual({ ...manual, correct: true })} aria-pressed={manual.correct}
                            style={{
                              padding: "6px 14px", borderRadius: 99, border: "none", cursor: "pointer", fontFamily: "inherit",
                              fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", transition: "all .15s",
                              background: manual.correct ? "var(--sage)" : "transparent",
                              color: manual.correct ? "white" : "var(--ink-soft)",
                            }}>
                            ✓ richtig
                          </button>
                          <button type="button" onClick={() => setManual({ ...manual, correct: false })} aria-pressed={!manual.correct}
                            style={{
                              padding: "6px 14px", borderRadius: 99, border: "none", cursor: "pointer", fontFamily: "inherit",
                              fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", transition: "all .15s",
                              background: !manual.correct ? "white" : "transparent",
                              color: "var(--ink-soft)",
                              boxShadow: !manual.correct ? "0 1px 3px rgba(0,0,0,.12)" : "none",
                            }}>
                            falsch
                          </button>
                        </div>
                        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                          <button className="btn-add" onClick={() => saveManual(w)} disabled={rowBusy || !manual.text.trim()} style={{ padding: "7px 16px" }}>Speichern</button>
                          <button className="btn-sm" onClick={() => setManual(null)} disabled={rowBusy}>Abbrechen</button>
                        </div>
                      </div>
                    </div>
                  )}
                </>)}
              </div>
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
  </>);
}
