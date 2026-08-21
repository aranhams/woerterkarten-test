import { useState, useEffect } from "react";
import { getArticleQuiz, translateWord } from "../../lib/api";
import { withTrans } from "../../lib/word";
import { clip, validImageUrl, cldImg } from "../../lib/format";
import { LIMIT } from "../../lib/constants";
import { loadVisibleFolders, loadAllClasses } from "../../data/loaders";
import { loadArticleProgress, saveOneArticleProgress } from "../../data/articleProgress";
import {
  buildArticleCards, buildArticleDeck, selectDueArticles, answerArticle, ARTICLE_OPTIONS,
} from "../../lib/article";

export function ArticleTab({ session }) {
  const isTeacher = session.isTeacher;

  const [cards, setCards] = useState([]);
  const [progress, setProgress] = useState({});
  const [folders, setFolders] = useState([]);
  const [classes, setClasses] = useState([]);
  const [filterClass, setFilterClass] = useState("");
  const [filterFolder, setFilterFolder] = useState(isTeacher ? "" : "all");
  const [deck, setDeck] = useState([]);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState(null);
  const [round, setRound] = useState({ answered: 0, correct: 0 });
  const [showTrans, setShowTrans] = useState(false);
  const [trans, setTrans] = useState({});
  const [translatedIds, setTranslatedIds] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  function prepDeck(built, prog) {
    setCards(built);
    setProgress(prog);
    setDeck(buildArticleDeck(isTeacher ? built.map((c) => ({ ...c, deRev: -1 })) : built, prog));
    setIdx(0);
    setPicked(null);
    setRound({ answered: 0, correct: 0 });
  }

  async function load({ folderId = null, classId = null } = {}) {
    setLoading(true);
    setError("");
    try {
      const [r, prog] = await Promise.all([
        getArticleQuiz({ folderId: folderId === "all" ? null : folderId, classId }),
        isTeacher ? Promise.resolve({}) : loadArticleProgress(session.uid),
      ]);
      prepDeck(buildArticleCards(r.cards || []), prog);
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
      const [gf, cs] = await Promise.all([
        loadVisibleFolders(session),
        isTeacher ? loadAllClasses() : Promise.resolve([]),
      ]);
      const list = gf.map((f) => ({ ...f, source: "global" }));
      if (cancelled) return;
      setFolders(list);
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
    setDeck(buildArticleDeck(subset.map((c) => ({ ...c, deRev: -1 })), {}));
    setIdx(0);
    setPicked(null);
    setRound({ answered: 0, correct: 0 });
  }

  const selectedClass = isTeacher ? classes.find((c) => c.id === filterClass) : null;
  const classFolders = selectedClass
    ? folders.filter((f) => (selectedClass.folders || []).some((e) => e && e.folderId === f.id))
    : [];
  const scopedCards = isTeacher && filterFolder
    ? cards.filter((c) => (c.folderId ?? null) === filterFolder)
    : cards;

  const current = deck[idx] || null;
  const answered = picked !== null;
  const currentTrans = current ? (trans[current.id] ?? withTrans(current, session.lang).ru ?? "") : "";

  async function revealTranslation() {
    setShowTrans(true);
    if (!current || currentTrans || translatedIds.has(current.id)) return;
    const id = current.id;
    setTranslatedIds((s) => new Set(s).add(id));
    try {
      const parsed = await translateWord({ wordId: id, word: current.de, article: current.answer, lang: session.lang });
      if (parsed.translation) setTrans((t) => ({ ...t, [id]: clip(parsed.translation, LIMIT.ru) }));
    } catch {
      setTranslatedIds((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }

  const stats = selectDueArticles(
    isTeacher ? scopedCards.map((c) => ({ ...c, deRev: -1 })) : cards,
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
    setShowTrans(false);
    setIdx((i) => i + 1);
  }

  function restart() {
    setDeck(buildArticleDeck(isTeacher ? scopedCards.map((c) => ({ ...c, deRev: -1 })) : cards, isTeacher ? {} : progress));
    setIdx(0);
    setPicked(null);
    setShowTrans(false);
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

  const total = isTeacher ? scopedCards.length : cards.length;
  const done = idx >= deck.length;

  return (<>
    {error && <p className="err" style={{ marginBottom: 10 }}>⚠ {error}</p>}

    <div className="stats-bar">
      <div className="stat"><div className="stat-n">{total}</div><div className="stat-l">Nomen</div></div>
      <div className="stat"><div className={`stat-n${deck.length > 0 && !done ? " due" : ""}`}>{isTeacher ? deck.length : stats.dueCount}</div><div className="stat-l">Zu üben</div></div>
      <div className="stat"><div className="stat-n ok">{learned}</div><div className="stat-l">Gemeistert</div></div>
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
        <p style={{ fontSize: 14 }}>Wähle oben einen Kurs, um die Artikel seiner Nomen zu üben.</p>
      </div>
    ) : total === 0 ? (
      <div className="empty" style={{ padding: 40 }}>
        <div className="emoji">🔤</div>
        <h3>Noch keine Nomen</h3>
        <p style={{ fontSize: 14 }}>
          {isTeacher
            ? "In diesem Kurs gibt es noch keine Nomen mit erkanntem Artikel."
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
          {current.imageUrl && validImageUrl(current.imageUrl) && (
            <img src={cldImg(current.imageUrl, 600)} className="fc-img" alt="" decoding="async" />
          )}
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

        <div
          className="article-trans"
          style={{
            textAlign: "center",
            marginTop: 8,
            marginBottom: 4,
            paddingTop: 14,
            borderTop: "1px solid var(--ivory-dark)",
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--ink-soft)", marginBottom: 8 }}>
            Übersetzung
          </div>
          {showTrans ? (
            <div className="fc-ru" style={{ fontSize: 16, fontWeight: 600 }}>
              {currentTrans || <span style={{ color: "#ccc", fontSize: 14 }}>⏳ Wird übersetzt…</span>}
            </div>
          ) : (
            <button
              type="button"
              className="fc-tap"
              style={{ background: "none", border: "none", cursor: "pointer", font: "inherit" }}
              onClick={revealTranslation}
            >
              Übersetzung anzeigen
            </button>
          )}
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
