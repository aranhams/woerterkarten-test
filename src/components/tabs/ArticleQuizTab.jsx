import { useState, useEffect } from "react";
import { getArticleQuiz } from "../../lib/api";
import { loadVisibleFolders } from "../../data/loaders";
import { loadArticleProgress, saveOneArticleProgress } from "../../data/articleProgress";
import {
  buildArticleCards, buildArticleDeck, selectDueArticles, answerArticle, ARTICLE_OPTIONS,
} from "../../lib/article";

export function ArticleQuizTab({ session }) {
  const isTeacher = session.isTeacher;

  const [cards, setCards] = useState([]);
  const [progress, setProgress] = useState({});
  const [folders, setFolders] = useState([]);
  const [filterFolder, setFilterFolder] = useState(isTeacher ? "" : "all");
  const [deck, setDeck] = useState([]);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState(null);
  const [round, setRound] = useState({ answered: 0, correct: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load(folderId) {
    setLoading(true);
    setError("");
    try {
      const [r, prog] = await Promise.all([
        getArticleQuiz({ folderId: folderId === "all" ? null : folderId }),
        isTeacher ? Promise.resolve({}) : loadArticleProgress(session.uid),
      ]);
      const built = buildArticleCards(r.cards || []);
      setCards(built);
      setProgress(prog);
      setDeck(buildArticleDeck(isTeacher ? built.map((c) => ({ ...c, deRev: -1 })) : built, prog));
      setIdx(0);
      setPicked(null);
      setRound({ answered: 0, correct: 0 });
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

  const stats = selectDueArticles(
    isTeacher ? cards.map((c) => ({ ...c, deRev: -1 })) : cards,
    isTeacher ? {} : progress,
  );
  const learned = isTeacher ? 0 : stats.learned;

  async function pick(option) {
    if (answered || !current) return;
    setPicked(option);
    const wasCorrect = option === current.answer;
    setRound((s) => ({ answered: s.answered + 1, correct: s.correct + (wasCorrect ? 1 : 0) }));
    if (isTeacher) return;
    const val = answerArticle(current, progress[current.id], wasCorrect);
    setProgress((p) => ({ ...p, [current.id]: val }));
    await saveOneArticleProgress(session.uid, current.id, val).catch(() => {});
  }

  function next() {
    setPicked(null);
    setIdx((i) => i + 1);
  }

  function restart() {
    setDeck(buildArticleDeck(isTeacher ? cards.map((c) => ({ ...c, deRev: -1 })) : cards, isTeacher ? {} : progress));
    setIdx(0);
    setPicked(null);
    setRound({ answered: 0, correct: 0 });
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

  const total = cards.length;
  const done = idx >= deck.length;

  return (<>
    {error && <p className="err" style={{ marginBottom: 10 }}>⚠ {error}</p>}

    <div className="stats-bar">
      <div className="stat"><div className="stat-n">{total}</div><div className="stat-l">Nomen</div></div>
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
        <div className="emoji">🔤</div>
        <h3>Noch keine Nomen</h3>
        <p style={{ fontSize: 14 }}>
          {isTeacher
            ? "In diesem Ordner gibt es noch keine Nomen mit erkanntem Artikel."
            : "Sobald deine Lehrkraft dir Nomen zuweist, kannst du hier die Artikel üben."}
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
        <span className="dsc-nav-pos">{idx + 1} / {deck.length}</span>
      </div>

      <div className="colloc-card">
        <div className="colloc-prompt">
          <div className="colloc-hint">Welcher Artikel?</div>
          <div className="colloc-phrase">
            <span className="blank">___</span> {current.de}
          </div>
        </div>

        <div className="colloc-options articles">
          {ARTICLE_OPTIONS.map((art) => {
            const isPicked = picked === art;
            const isAnswer = art === current.answer;
            let cls = "colloc-opt";
            if (answered && isAnswer) cls += " correct";
            else if (answered && isPicked && !isAnswer) cls += " wrong";
            return (
              <button key={art} className={cls} onClick={() => pick(art)} disabled={answered}>
                <span>{art}</span>
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
              background: picked === current.answer ? "var(--sage-pale)" : "var(--red-pale)",
              color: picked === current.answer ? "var(--sage)" : "var(--red-soft)",
            }}>
              {picked === current.answer ? "✓ Richtig!" : "✕ Leider falsch"}
              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ink)", marginTop: 6 }}>
                <span style={{ color: "var(--accent)", fontStyle: "italic" }}>{current.answer}</span> {current.de}
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
