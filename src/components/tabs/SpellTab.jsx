import { useState, useEffect, useRef } from "react";
import { getSpellDeck, translateWord } from "../../lib/api";
import { withTrans } from "../../lib/word";
import { clip, validImageUrl, cldImg } from "../../lib/format";
import { LIMIT } from "../../lib/constants";
import { loadVisibleFolders, loadAllClasses } from "../../data/loaders";
import { loadSpellProgress, saveOneSpellProgress } from "../../data/spellProgress";
import {
  buildSpellCards, buildSpellDeck, isSpellCorrect, spellDiff, recordSpell, hasDescription,
} from "../../lib/spell";

export function SpellTab({ session }) {
  const isTeacher = session.isTeacher;

  const [cards, setCards] = useState([]);
  const [progress, setProgress] = useState({});
  const [folders, setFolders] = useState([]);
  const [classes, setClasses] = useState([]);
  const [filterClass, setFilterClass] = useState("");
  const [filterFolder, setFilterFolder] = useState(isTeacher ? "" : "all");
  const [deck, setDeck] = useState([]);
  const [idx, setIdx] = useState(0);
  const [guess, setGuess] = useState("");
  const [checked, setChecked] = useState(null);
  const [firstCheckDone, setFirstCheckDone] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [round, setRound] = useState({ answered: 0, correct: 0 });
  const [trans, setTrans] = useState({});
  const [translatedIds, setTranslatedIds] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  function prepDeck(built) {
    setCards(built);
    setDeck(buildSpellDeck(built));
    resetCard(0);
    setRound({ answered: 0, correct: 0 });
  }

  function resetCard(nextIdx) {
    setIdx(nextIdx);
    setGuess("");
    setChecked(null);
    setFirstCheckDone(false);
    setFlipped(false);
    setReveal(false);
  }

  async function load({ folderId = null, classId = null } = {}) {
    setLoading(true);
    setError("");
    try {
      const r = await getSpellDeck({ folderId: folderId === "all" ? null : folderId, classId });
      prepDeck(buildSpellCards(r.cards || []));
    } catch (e) {
      setError(e.message || "Fehler");
      setCards([]);
      setDeck([]);
    }
    setLoading(false);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [gf, cs, prog] = await Promise.all([
        loadVisibleFolders(session),
        isTeacher ? loadAllClasses() : Promise.resolve([]),
        isTeacher ? Promise.resolve({}) : loadSpellProgress(session.uid),
      ]);
      if (cancelled) return;
      setFolders(gf.map((f) => ({ ...f, source: "global" })));
      setProgress(prog);
      if (isTeacher) {
        setClasses(cs);
        setLoading(false);
        return;
      }
      await load({ folderId: "all" });
    })();
    return () => { cancelled = true; };
  }, [session.uid]);

  async function onFolderChange(v) {
    setFilterFolder(v);
    await load({ folderId: v });
  }

  async function onClassChange(v) {
    setFilterClass(v);
    setFilterFolder("");
    if (!v) { setCards([]); setDeck([]); return; }
    await load({ classId: v });
  }

  function onTeacherFolderChange(v) {
    setFilterFolder(v);
    const subset = v ? cards.filter((c) => (c.folderId ?? null) === v) : cards;
    setDeck(buildSpellDeck(subset));
    resetCard(0);
    setRound({ answered: 0, correct: 0 });
  }

  const selectedClass = isTeacher ? classes.find((c) => c.id === filterClass) : null;
  const classFolders = selectedClass
    ? folders.filter((f) => (selectedClass.folders || []).some((e) => e && e.folderId === f.id))
    : [];

  const current = deck[idx] || null;
  const currentTrans = current ? (trans[current.id] ?? withTrans(current, session.lang).ru ?? "") : "";

  useEffect(() => {
    if (!current) return;
    const id = current.id;
    if (currentTrans || translatedIds.has(id)) return;
    setTranslatedIds((s) => new Set(s).add(id));
    translateWord({ wordId: id, word: current.de, lang: session.lang })
      .then((parsed) => { if (parsed.translation) setTrans((t) => ({ ...t, [id]: clip(parsed.translation, LIMIT.ru) })); })
      .catch(() => setTranslatedIds((s) => { const n = new Set(s); n.delete(id); return n; }));
  }, [current?.id]);

  useEffect(() => { if (current) inputRef.current?.focus(); }, [current?.id]);

  const solved = !!(checked && checked.correct);

  function check() {
    if (!current || solved) return;
    const correct = isSpellCorrect(guess, current.de);
    setChecked({ segs: spellDiff(guess, current.de), correct });
    if (!firstCheckDone) {
      setFirstCheckDone(true);
      setRound((s) => ({ answered: s.answered + 1, correct: s.correct + (correct ? 1 : 0) }));
      if (!isTeacher) {
        const val = recordSpell(progress[current.id], correct, guess, Date.now());
        setProgress((p) => ({ ...p, [current.id]: val }));
        saveOneSpellProgress(session.uid, current.id, val).catch(() => {});
      }
    }
  }

  function retry() {
    setGuess("");
    setChecked(null);
    setReveal(false);
    inputRef.current?.focus();
  }

  function next() {
    resetCard(idx + 1);
  }

  function restart() {
    setDeck(buildSpellDeck(isTeacher && filterFolder ? cards.filter((c) => (c.folderId ?? null) === filterFolder) : cards));
    resetCard(0);
    setRound({ answered: 0, correct: 0 });
  }

  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  if (isTeacher && classes.length === 0) {
    return (
      <div className="empty" style={{ padding: 40 }}>
        <div className="emoji">👥</div>
        <h3>Noch keine Kurse</h3>
        <p style={{ fontSize: 14 }}>Erstelle im Tab „Kurse" einen Kurs und weise ihm Ordner oder Wörter zu.</p>
      </div>
    );
  }

  const total = deck.length;
  const done = idx >= deck.length;

  return (<>
    {error && <p className="err" style={{ marginBottom: 10 }}>⚠ {error}</p>}

    <div className="stats-bar">
      <div className="stat"><div className="stat-n">{cards.length}</div><div className="stat-l">Wörter</div></div>
      <div className="stat"><div className={`stat-n${round.answered > 0 ? " due" : ""}`}>{round.answered}</div><div className="stat-l">Geübt</div></div>
      <div className="stat"><div className="stat-n ok">{round.correct}</div><div className="stat-l">Richtig</div></div>
    </div>

    {isTeacher ? (
      <div className="filter-bar">
        <select value={filterClass} onChange={(e) => onClassChange(e.target.value)}>
          <option value="">👥 Kurs wählen…</option>
          {classes.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
        </select>
        {filterClass && classFolders.length > 0 && (
          <select value={filterFolder} onChange={(e) => onTeacherFolderChange(e.target.value)}>
            <option value="">📂 Alle Ordner</option>
            {classFolders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
          </select>
        )}
      </div>
    ) : folders.length > 0 && (
      <div className="filter-bar">
        <select value={filterFolder} onChange={(e) => onFolderChange(e.target.value)}>
          <option value="all">📂 Alle Ordner</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
        </select>
      </div>
    )}

    {isTeacher && (
      <p style={{ fontSize: 12, color: "var(--ink-soft)", textAlign: "center", marginBottom: 10 }}>
        Vorschau — als Lehrkraft wird kein Fortschritt gespeichert.
      </p>
    )}

    {isTeacher && !filterClass ? (
      <div className="empty" style={{ padding: 40 }}>
        <div className="emoji">👥</div>
        <h3>Kurs wählen</h3>
        <p style={{ fontSize: 14 }}>Wähle oben einen Kurs, um die Rechtschreibung seiner Wörter zu üben.</p>
      </div>
    ) : cards.length === 0 ? (
      <div className="empty" style={{ padding: 40 }}>
        <div className="emoji">✍️</div>
        <h3>Noch keine Wörter</h3>
        <p style={{ fontSize: 14 }}>
          {isTeacher
            ? "In diesem Kurs gibt es noch keine Wörter für das Schreibtraining."
            : "Sobald deine Lehrkraft dir Wörter zuweist, kannst du hier die Rechtschreibung üben."}
        </p>
      </div>
    ) : done ? (
      <div className="empty" style={{ padding: 40 }}>
        <div className="emoji">🎉</div>
        <h3>{round.answered > 0 ? "Runde geschafft!" : "Alles geübt!"}</h3>
        {round.answered > 0 && (
          <p style={{ fontSize: 16, marginTop: 4 }}>
            {round.correct} / {round.answered} richtig
            {" "}({Math.round((round.correct / round.answered) * 100)}%)
          </p>
        )}
        <button className="btn-add" style={{ marginTop: 14 }} onClick={restart}>Nochmal üben</button>
      </div>
    ) : current ? (<>
      <div className="dsc-nav">
        <span className="dsc-nav-pos">{idx + 1} / {total}</span>
      </div>

      <div className="colloc-card">
        <div className="spell-prompt" translate="no">
          <div className="colloc-hint">{flipped ? "Beschreibung" : "Übersetzung"}</div>
          {!flipped && current.imageUrl && validImageUrl(current.imageUrl) && (
            <img src={cldImg(current.imageUrl, 600)} className="fc-img" alt="" decoding="async" />
          )}
          {flipped ? (
            <div className="spell-desc">„{current.desc.text}"</div>
          ) : (
            <div className="spell-trans">
              {currentTrans || <span style={{ color: "#ccc", fontSize: 15 }}>⏳ Wird übersetzt…</span>}
            </div>
          )}
          {hasDescription(current) && (
            <button type="button" className="btn-sm spell-flip" onClick={() => setFlipped((f) => !f)}>
              {flipped ? "↩ Übersetzung" : "🔄 Beschreibung zeigen"}
            </button>
          )}
        </div>

        <div className="spell-input-row">
          <input
            ref={inputRef}
            className="spell-input"
            translate="no"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Wort auf Deutsch schreiben…"
            maxLength={LIMIT.de}
            value={guess}
            disabled={solved}
            onChange={(e) => { setGuess(e.target.value); if (checked) setChecked(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") check(); }}
          />
          {!solved && <button className="btn-add" onClick={check} disabled={!guess.trim()}>Prüfen</button>}
        </div>

        {checked && (
          <div className="spell-result" translate="no">
            {checked.segs.map((seg, i) => (
              <span
                key={i}
                className={seg.status === "match" ? "spell-ok" : seg.status === "missing" ? "spell-missing" : "spell-bad"}
                title={seg.status === "wrong" && seg.expected ? `erwartet: ${seg.expected}` : undefined}
              >
                {seg.ch}
              </span>
            ))}
          </div>
        )}

        {checked && (
          <div style={{ textAlign: "center", width: "100%" }}>
            <div style={{
              fontSize: 15, fontWeight: 600, padding: "10px 12px", borderRadius: 8,
              background: solved ? "var(--sage-pale)" : "var(--red-pale)",
              color: solved ? "var(--sage)" : "var(--red-soft)",
            }}>
              {solved ? "✓ Richtig geschrieben!" : "✕ Noch nicht ganz"}
              {!solved && reveal && (
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ink)", marginTop: 6 }}>{current.de}</div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14, flexWrap: "wrap" }}>
              {solved ? (
                <button className="btn-add" onClick={next}>Weiter ›</button>
              ) : (<>
                <button className="btn-knew" onClick={retry}>↻ Nochmal versuchen</button>
                {!reveal && <button className="btn-sm" onClick={() => setReveal(true)}>Lösung zeigen</button>}
                <button className="btn-sm" onClick={next}>Überspringen ›</button>
              </>)}
            </div>
          </div>
        )}
      </div>
    </>) : null}
  </>);
}
