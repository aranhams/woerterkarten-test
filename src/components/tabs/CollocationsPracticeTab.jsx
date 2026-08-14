import { useState, useEffect } from "react";
import { getCollocationPractice } from "../../lib/api";
import { loadVisibleFolders } from "../../data/loaders";
import { loadCollocationProgress, saveOneCollocationProgress } from "../../data/collocations";
import {
  buildDeck, selectDueCollocations, answerCollocation, fullPhrase, reflexiveParts, separableParts,
} from "../../lib/collocation";

export function CollocationsPracticeTab({ session }) {
  const isTeacher = session.isTeacher;

  const [questions, setQuestions] = useState([]);
  const [progress, setProgress] = useState({});
  const [folders, setFolders] = useState([]);
  const [filterFolder, setFilterFolder] = useState(isTeacher ? "" : "all");
  const [deck, setDeck] = useState([]);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState(null);
  const [session_, setSession_] = useState({ answered: 0, correct: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load(folderId) {
    setLoading(true);
    setError("");
    try {
      const [r, prog] = await Promise.all([
        getCollocationPractice({ folderId: folderId === "all" ? null : folderId }),
        isTeacher ? Promise.resolve({}) : loadCollocationProgress(session.uid),
      ]);
      const qs = r.questions || [];
      setQuestions(qs);
      setProgress(prog);
      setDeck(buildDeck(isTeacher ? qs.map((q) => ({ ...q, rev: -1 })) : qs, prog));
      setIdx(0);
      setPicked(null);
      setSession_({ answered: 0, correct: 0 });
    } catch (e) {
      setError(e.message || "Fehler");
      setQuestions([]);
      setDeck([]);
    }
    setLoading(false);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const gf = await loadVisibleFolders(session);
      const list = gf.map((f) => ({ ...f, source: "global" }));
      if (cancelled) return;
      setFolders(list);
      if (isTeacher) {
        const first = list[0];
        if (first) {
          setFilterFolder(first.id);
          await load(first.id);
        } else {
          setLoading(false);
        }
        return;
      }
      await load("all");
    })();
    return () => { cancelled = true; };
  }, [session.uid]);

  async function onFolderChange(v) {
    setFilterFolder(v);
    await load(v);
  }

  const current = deck[idx] || null;
  const answered = picked !== null;
  const correctId = current?.answerId;

  const stats = selectDueCollocations(
    isTeacher ? questions.map((q) => ({ ...q, rev: -1 })) : questions,
    isTeacher ? {} : progress,
  );
  const learned = isTeacher ? 0 : stats.learned;

  async function pick(optionId) {
    if (answered || !current) return;
    setPicked(optionId);
    const wasCorrect = optionId === correctId;
    setSession_((s) => ({ answered: s.answered + 1, correct: s.correct + (wasCorrect ? 1 : 0) }));
    if (isTeacher) return;
    const val = answerCollocation(current, progress[current.wordId], wasCorrect);
    setProgress((p) => ({ ...p, [current.wordId]: val }));
    await saveOneCollocationProgress(session.uid, current.wordId, val).catch(() => {});
  }

  function next() {
    setPicked(null);
    setIdx((i) => i + 1);
  }

  function restart() {
    setDeck(buildDeck(isTeacher ? questions.map((q) => ({ ...q, rev: -1 })) : questions, isTeacher ? {} : progress));
    setIdx(0);
    setPicked(null);
    setSession_({ answered: 0, correct: 0 });
  }

  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  if (isTeacher && !filterFolder) {
    return (
      <div className="empty" style={{ padding: 40 }}>
        <div className="emoji">📂</div>
        <h3>Noch keine Ordner</h3>
        <p style={{ fontSize: 14 }}>Erstelle im Tab „Verwalten" einen Ordner mit Wörtern.</p>
      </div>
    );
  }

  const total = questions.length;
  const done = idx >= deck.length;

  return (<>
    {error && <p className="err" style={{ marginBottom: 10 }}>⚠ {error}</p>}

    <div className="stats-bar">
      <div className="stat"><div className="stat-n">{total}</div><div className="stat-l">Verbindungen</div></div>
      <div className="stat"><div className={`stat-n${deck.length > 0 && !done ? " due" : ""}`}>{isTeacher ? deck.length : stats.dueCount}</div><div className="stat-l">Zu üben</div></div>
      <div className="stat"><div className="stat-n ok">{learned}</div><div className="stat-l">Gemeistert</div></div>
    </div>

    {folders.length > 0 && (
      <div className="filter-bar">
        <select value={filterFolder} onChange={(e) => onFolderChange(e.target.value)}>
          {!isTeacher && <option value="all">📂 Alle Ordner</option>}
          {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
        </select>
      </div>
    )}

    {isTeacher && (
      <p style={{ fontSize: 12, color: "var(--ink-soft)", textAlign: "center", marginBottom: 10 }}>
        Vorschau — als Lehrkraft wird kein Fortschritt gespeichert.
      </p>
    )}

    {total === 0 ? (
      <div className="empty" style={{ padding: 40 }}>
        <div className="emoji">🔗</div>
        <h3>Noch keine Übungen</h3>
        <p style={{ fontSize: 14 }}>
          {isTeacher
            ? "In diesem Ordner sind noch keine Wortverbindungen freigegeben."
            : "Sobald deine Lehrkraft Wortverbindungen freigibt, kannst du sie hier üben."}
        </p>
      </div>
    ) : done ? (
      <div className="empty" style={{ padding: 40 }}>
        <div className="emoji">🎉</div>
        <h3>{session_.answered > 0 ? "Runde geschafft!" : "Alles geübt!"}</h3>
        {session_.answered > 0 && (
          <p style={{ fontSize: 16, marginTop: 4 }}>
            {session_.correct} / {session_.answered} richtig
            {" "}({Math.round((session_.correct / session_.answered) * 100)}%)
          </p>
        )}
        <button className="btn-add" style={{ marginTop: 14 }} onClick={restart}>Nochmal üben</button>
      </div>
    ) : current ? (<>
      <div className="dsc-nav">
        <span className="dsc-nav-pos">{idx + 1} / {deck.length}</span>
      </div>

      <div className="colloc-card">
        <div className="colloc-prompt">
          <div className="colloc-hint">Welches Wort passt?{current.partnerLabel ? ` (${current.partnerLabel})` : ""}</div>
          <div className="colloc-phrase">
            {current.cat === "Reflexivverb"
              ? (() => { const { pron, verb } = reflexiveParts(current.de); return <><span className="reflexive">{pron}</span> <span className="blank">_____</span> {verb}</>; })()
              : current.cat === "Trennbares Verb"
                ? (() => { const { prefix, stem } = separableParts(current.de); return <>{stem} <span className="blank">_____</span> {prefix && <span className="prefix">{prefix}</span>}</>; })()
                : current.partnerLabel === "Nomen"
                  ? (current.cat === "Adjektiv"
                    ? <><span className="blank">_____</span> ist {current.de}</>
                    : <><span className="blank">_____</span> {current.de}</>)
                  : <>{current.article && <span className="article">{current.article}</span>}{current.de} <span className="blank">_____</span></>}
          </div>
        </div>

        <div className="colloc-options">
          {current.shuffled.map((o) => {
            const isPicked = picked === o.id;
            const isAnswer = o.id === correctId;
            let cls = "colloc-opt";
            if (answered && isAnswer) cls += " correct";
            else if (answered && isPicked && !isAnswer) cls += " wrong";
            return (
              <button key={o.id} className={cls} onClick={() => pick(o.id)} disabled={answered}>
                <span>{o.text}</span>
                {answered && isAnswer && <span>✓</span>}
                {answered && isPicked && !isAnswer && <span>✕</span>}
              </button>
            );
          })}
        </div>

        {answered && (
          <div style={{ textAlign: "center" }}>
            <div style={{
              fontSize: 15, fontWeight: 600, padding: "10px 12px", borderRadius: 8,
              background: picked === correctId ? "var(--sage-pale)" : "var(--red-pale)",
              color: picked === correctId ? "var(--sage)" : "var(--red-soft)",
            }}>
              {picked === correctId ? "✓ Richtig!" : "✕ Leider falsch"}
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--ink)", marginTop: 6 }}>
                „{fullPhrase(current, current.options.find((o) => o.id === correctId)?.text)}"
              </div>
            </div>
            <button className="btn-add" style={{ marginTop: 14 }} onClick={next}>Weiter ›</button>
          </div>
        )}
      </div>
    </>) : (
      <div className="empty" style={{ padding: 40 }}>
        <div className="emoji">🎉</div>
        <h3>Alles geübt!</h3>
        <p style={{ fontSize: 14 }}>Komm später wieder zurück.</p>
      </div>
    )}
  </>);
}
