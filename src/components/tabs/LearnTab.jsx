import { useState, useEffect, useRef } from "react";
import { LIMIT, LANGUAGES, CARDS_CAP } from "../../lib/constants";
import { clip, validImageUrl, cldImg } from "../../lib/format";
import { isDue, nextReview, lvlEmoji, effProgress, MASTERY_LEVEL, INTERVALS } from "../../lib/srs";
import { withTrans } from "../../lib/word";
import { translateWord, getLearnQueue } from "../../lib/api";
import {
  loadVisibleFolders, loadUserWords, loadUserFolders,
  loadProgress, saveOneProgress, queueActivity, flushActivity, cachePron,
} from "../../data/loaders";
import { newPageState, loadNextPage } from "../../data/pagination";
import { usePronunciation } from "../../data/usePron";
import { SpokenWord } from "../Pronunciation";

const TEACHER_PREVIEW = { level: INTERVALS.length - 1, due: 0 };

export function LearnTab({ session }) {
  const [revealed, setRevealed] = useState(false);
  const [idx, setIdx] = useState(0);
  const [direction, setDirection] = useState(() => localStorage.getItem("dw_dir") || "de2ru");
  const [filterFolder, setFilterFolder] = useState(session.isTeacher ? "" : "all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [allWords, setAllWords] = useState([]);
  const [folders, setFolders] = useState([]);
  const [progress, setProgress] = useState({});
  const [stats, setStats] = useState(null);
  const [delta, setDelta] = useState({ due: 0, learned: 0 });
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [queueError, setQueueError] = useState("");
  const [translatedIds, setTranslatedIds] = useState(() => new Set());
  const fetching = useRef(false);

  useEffect(() => () => { flushActivity(); }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [gf, uf, uw, prog] = await Promise.all([
        loadVisibleFolders(session),
        loadUserFolders(session.uid),
        session.isTeacher ? Promise.resolve([]) : loadUserWords(session.uid),
        session.isTeacher ? Promise.resolve({}) : loadProgress(session.uid),
      ]);
      if (cancelled) return;
      const list = [...gf.map((f) => ({ ...f, source: "global" })), ...uf.map((f) => ({ ...f, source: "personal" }))];
      setFolders(list);
      setProgress(prog);
      if (session.isTeacher) {
        const first = list[0];
        if (first) {
          const page = await fetchFolderCards(first.id);
          if (cancelled) return;
          setFilterFolder(first.id);
          setAllWords(page.rows);
          setCapped(!page.exhausted);
        } else {
          setAllWords([]);
        }
        setLoading(false);
        return;
      }
      try {
        const r = await getLearnQueue({});
        if (cancelled) return;
        setAllWords([...r.dueWords, ...uw]);
        setStats(r.stats); setDelta({ due: 0, learned: 0 });
        setCapped(!!r.capped);
      } catch (e) {
        if (!cancelled) { setAllWords([...uw]); setQueueError(e.message || "Fehler"); }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [session.uid, session.isTeacher]);

  const fetchFolderCards = (fid) => loadNextPage(newPageState({
    uid: session.uid, teacher: true, folderId: fid, pageSize: CARDS_CAP,
  }));

  async function loadTeacherFolder(fid) {
    setFilterFolder(fid);
    setIdx(0); setRevealed(false); setProgress({});
    if (!fid) { setAllWords([]); return; }
    setLoading(true);
    const page = await fetchFolderCards(fid);
    setAllWords(page.rows);
    setCapped(!page.exhausted);
    setLoading(false);
  }

  async function switchStudentFolder(fid) {
    setFilterFolder(fid);
    setIdx(0); setRevealed(false);
    setLoading(true);
    try {
      const r = await getLearnQueue({ folderId: fid === "all" ? null : fid });
      const uw = await loadUserWords(session.uid);
      setAllWords([...r.dueWords, ...uw]);
      setStats(r.stats); setDelta({ due: 0, learned: 0 });
      setCapped(!!r.capped);
    } catch (e) { setQueueError(e.message || "Fehler"); }
    setLoading(false);
  }

  async function fetchMore() {
    if (session.isTeacher || fetching.current || !capped) return;
    fetching.current = true;
    try {
      const r = await getLearnQueue({ folderId: filterFolder === "all" ? null : filterFolder });
      setAllWords((prev) => {
        const have = new Set(prev.map((w) => w.id));
        return [...prev, ...r.dueWords.filter((w) => !have.has(w.id))];
      });
      setStats(r.stats); setDelta({ due: 0, learned: 0 });
      setCapped(!!r.capped);
    } catch {}
    fetching.current = false;
  }

  const setDir = (d) => { setDirection(d); localStorage.setItem("dw_dir", d); setRevealed(false); setIdx(0); };

  const allFolders = filterFolder === "all" || filterFolder === "";
  const matchSource = (w) => sourceFilter === "all" || (sourceFilter === "global" ? w.source === "global" : w.source !== "global");
  const scoped = (allFolders || session.isTeacher
    ? allWords
    : allWords.filter((w) => w.folderId === filterFolder)).filter(matchSource);

  const progressOf = (w) => (session.isTeacher ? TEACHER_PREVIEW : effProgress(w, progress[w.id]));
  const dueCards = scoped.filter((w) => isDue(progressOf(w)));
  const isLearned = (w) => (progressOf(w)?.level || 0) >= MASTERY_LEVEL;

  const gStats = stats && sourceFilter !== "personal"
    ? (allFolders ? stats : (stats.perFolder && stats.perFolder[filterFolder]) || { total: 0, due: 0, learned: 0 })
    : null;
  const personal = sourceFilter === "global"
    ? []
    : allWords.filter((w) => w.source !== "global" && (allFolders || w.folderId === filterFolder));

  const total = gStats ? gStats.total + personal.length : scoped.length;
  const learned = gStats
    ? Math.max(0, gStats.learned + delta.learned) + personal.filter(isLearned).length
    : scoped.filter(isLearned).length;
  const dueTotal = session.isTeacher
    ? 0
    : gStats
      ? Math.max(0, gStats.due + delta.due) + personal.filter((w) => isDue(progressOf(w))).length
      : dueCards.length;
  const rawCard = dueCards[idx % Math.max(dueCards.length, 1)] || null;
  const card = rawCard && rawCard.source === "global" ? withTrans(rawCard, session.lang) : rawCard;

  async function ensureTranslation(c) {
    if (!c || c.source !== "global" || c.ru || translatedIds.has(c.id)) return;
    setTranslatedIds((s) => new Set(s).add(c.id));
    try {
      const parsed = await translateWord({ wordId: c.id, word: c.de, article: c.article, lang: session.lang });
      if (parsed.translation) {
        const t = { ru: clip(parsed.translation, LIMIT.ru), example: clip(parsed.example || "", LIMIT.example) };
        setAllWords((prev) => prev.map((w) => (w.id === c.id ? { ...w, t: { ...(w.t || {}), [session.lang]: { ...t, de: w.de } } } : w)));
      }
    } catch {
      setTranslatedIds((s) => { const n = new Set(s); n.delete(c.id); return n; });
    }
  }

  useEffect(() => { if (card) ensureTranslation(card); }, [card?.id]);

  function applyPron(wordId, pron) {
    setAllWords((prev) => prev.map((w) => (w.id === wordId ? { ...w, pron } : w)));
    const word = allWords.find((w) => w.id === wordId);
    if (word && word.source !== "global") cachePron(session, word, pron);
  }

  usePronunciation(card, session, applyPron);

  async function answer(knew) {
    if (!card) return;

    if (session.isTeacher) {
      setRevealed(false);
      setIdx((i) => (i >= dueCards.length - 1 ? 0 : i + 1));
      return;
    }

    const p = effProgress(card, progress[card.id]) || { level: 0 };
    const nx = nextReview(p.level, knew);
    const nm = Math.max(0, ((progress[card.id]?.nm) || 0) + (knew ? -1 : 1));
    const lapsed = !knew && p.level >= MASTERY_LEVEL;
    let lp = ((progress[card.id]?.lp) || 0) + (lapsed ? 1 : 0);
    if (knew && nx.level >= MASTERY_LEVEL) lp = 0;
    const lt = ((progress[card.id]?.lt) || 0) + (lapsed ? 1 : 0);
    const val = { ...nx, rev: card.deRev || 0, nm, lp, lt };
    const staysDue = isDue(val);
    const newProgress = { ...progress, [card.id]: val };
    setRevealed(false);
    setProgress(newProgress);

    const wasLearned = (p.level || 0) >= MASTERY_LEVEL;
    const nowLearned = (val.level || 0) >= MASTERY_LEVEL;
    const learnedStep = (nowLearned ? 1 : 0) - (wasLearned ? 1 : 0);
    if (card.source === "global") {
      setDelta((d) => ({ due: d.due + (staysDue ? 0 : -1), learned: d.learned + learnedStep }));
    }

    await saveOneProgress(session.uid, card.id, val);
    const nextLearned = learned + learnedStep;
    queueActivity(session.uid, knew, total ? Math.round((nextLearned / total) * 100) : undefined);

    setIdx((i) => {
      if (staysDue) return i >= dueCards.length - 1 ? 0 : i + 1;
      const remaining = dueCards.length - 1;
      return remaining <= 0 ? 0 : i % remaining;
    });
    if (dueCards.length - 1 < 5) fetchMore();
  }

  const langLabel = LANGUAGES.find((l) => l.code === session.lang)?.label?.split(" ")[0] || "Muttersprache";
  const front = card ? (direction === "de2ru" ? { hint: "Deutsch → ?", article: card.article, word: card.de, isDE: true } : { hint: `${langLabel} → ?`, word: card.ru || "…", isDE: false }) : null;
  const back = card ? (direction === "de2ru" ? { word: card.ru, isDE: false } : { article: card.article, word: card.de, isDE: true }) : null;
  const cardFolder = card ? folders.find((f) => f.id === card.folderId) : null;

  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  if (session.isTeacher && !filterFolder) {
    return (
      <div className="empty">
        <div className="emoji">📂</div>
        <h3>Noch keine Ordner</h3>
        <p style={{ fontSize: 14 }}>Erstelle im Tab „Verwalten" einen Ordner mit Wörtern.</p>
      </div>
    );
  }

  return (<>
    {queueError && <p className="err" style={{ marginBottom: 10 }}>⚠ {queueError}</p>}
    <div className="stats-bar">
      <div className="stat"><div className="stat-n">{total}</div><div className="stat-l">Gesamt</div></div>
      <div className="stat"><div className={`stat-n${dueCards.length > 0 ? " due" : ""}`}>{dueTotal}</div><div className="stat-l">Zu lernen</div></div>
      <div className="stat"><div className="stat-n ok">{learned}</div><div className="stat-l">Gelernt</div></div>
    </div>
    {total > 0 && <div className="prog-wrap">
      <div className="prog-bar"><div className="prog-fill" style={{ width: `${Math.round(learned / total * 100)}%` }} /></div>
      <div className="prog-text">{Math.round(learned / total * 100)}% gemeistert</div>
    </div>}
    {folders.length > 0 && <div className="filter-bar">
      <select value={filterFolder} onChange={(e) => (session.isTeacher ? loadTeacherFolder(e.target.value) : switchStudentFolder(e.target.value))}>
        {!session.isTeacher && <option value="all">📂 Alle Ordner</option>}
        {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
      </select>
      {!session.isTeacher && <select value={sourceFilter} onChange={(e) => { setSourceFilter(e.target.value); setIdx(0); setRevealed(false); }}>
        <option value="all">Alle Wörter</option>
        <option value="personal">Meine Wörter</option>
        <option value="global">Kurswörter</option>
      </select>}
    </div>}
    {total > 0 && <div className="dir-toggle">
      <button className={`dir-btn${direction === "de2ru" ? " active" : ""}`} onClick={() => setDir("de2ru")}>Deutsch</button>
      <span style={{ color: "var(--sage-light)", padding: "0 2px" }}>⇄</span>
      <button className={`dir-btn${direction === "ru2de" ? " active" : ""}`} onClick={() => setDir("ru2de")}>{langLabel}</button>
    </div>}
    {!card ? (
      <div className="empty">
        <div className="emoji">{total === 0 ? "📭" : "🎉"}</div>
        <h3>{total === 0 ? "Noch keine Wörter" : "Alle Karten gelernt!"}</h3>
        <p style={{ fontSize: 14 }}>{total === 0 ? "Die Lehrerin fügt bald Wörter hinzu." : "Komm später wieder zurück."}</p>
      </div>
    ) : (<>
      <div className="fc-wrap">
        <div className="fc" translate="no" onClick={() => !revealed && setRevealed(true)}>
          {cardFolder && <div className="fc-folder">{cardFolder.icon} {cardFolder.name}</div>}
          <div className="fc-lvl">{lvlEmoji(progressOf(card)?.level)}</div>
          {card.imageUrl && validImageUrl(card.imageUrl) && <img src={cldImg(card.imageUrl, 600)} className="fc-img" alt="" decoding="async" />}
          <div className="fc-hint">{front.hint}</div>
          {front.isDE && front.article && <div className="fc-article">{front.article}</div>}
          {front.isDE
            ? <SpokenWord word={card} />
            : <div className="fc-word" style={{ fontFamily: "'Inter',sans-serif", fontSize: 28 }}>{front.word}</div>}
          {revealed ? (<>
            {back.isDE && back.article && <div className="fc-article" style={{ marginTop: 10 }}>{back.article}</div>}
            {back.isDE
              ? <SpokenWord word={card} style={{ marginTop: 6, fontSize: 28 }} />
              : <div className="fc-ru">{back.word || <span style={{ color: "#ccc", fontSize: 14 }}>⏳ Wird übersetzt…</span>}</div>}
            {card.example && <div className="fc-example">„{card.example}"</div>}
          </>) : <div className="fc-tap">Tippe, um {direction === "de2ru" ? "die Übersetzung" : "das deutsche Wort"} zu sehen</div>}
        </div>
      </div>
      {revealed && <div className="ans-btns">
        <button className="btn-forgot" onClick={() => answer(false)}>😬 Nochmal</button>
        <button className="btn-knew" onClick={() => answer(true)}>✓ Wusste ich</button>
      </div>}
    </>)}
  </>);
}
