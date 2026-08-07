import { useState, useEffect } from "react";
import { LIMIT, LANGUAGES } from "../../lib/constants";
import { clip, validImageUrl, cldImg } from "../../lib/format";
import { isDue, nextReview, lvlEmoji, effProgress, MASTERY_LEVEL } from "../../lib/srs";
import { translateWord } from "../../lib/api";
import {
  loadVisibleWords, loadVisibleFolders, loadUserWords, loadUserFolders,
  loadProgress, loadLangTranslations, saveOneProgress, recordActivity, cachePron,
} from "../../data/loaders";
import { usePronunciation } from "../../data/usePron";
import { SpokenWord } from "../Pronunciation";

export function LearnTab({ session }) {
  const [revealed, setRevealed] = useState(false);
  const [idx, setIdx] = useState(0);
  const [direction, setDirection] = useState(() => localStorage.getItem("dw_dir") || "de2ru");
  const [filterFolder, setFilterFolder] = useState("all");
  const [allWords, setAllWords] = useState([]);
  const [folders, setFolders] = useState([]);
  const [progress, setProgress] = useState({});
  const [loading, setLoading] = useState(true);
  const [translatedIds, setTranslatedIds] = useState(() => new Set());

  useEffect(() => {
    (async () => {
      const [gw, uw, gf, uf, prog, ut] = await Promise.all([loadVisibleWords(session), loadUserWords(session.uid), loadVisibleFolders(session), loadUserFolders(session.uid), loadProgress(session.uid), loadLangTranslations(session.lang)]);
      const tmap = {};
      ut.forEach((t) => { tmap[t.id] = t; });
      const mergedGW = gw.map((w) => (tmap[w.id] ? { ...w, ru: tmap[w.id].ru, example: tmap[w.id].example || w.example } : w));
      setAllWords([...mergedGW, ...uw]);
      setTranslatedIds(new Set(Object.keys(tmap)));
      setFolders([...gf.map((f) => ({ ...f, source: "global" })), ...uf.map((f) => ({ ...f, source: "personal" }))]);
      setProgress(prog); setLoading(false);
    })();
  }, []);

  const setDir = (d) => { setDirection(d); localStorage.setItem("dw_dir", d); setRevealed(false); setIdx(0); };
  const filteredWords = filterFolder === "all" ? allWords : allWords.filter((w) => w.folderId === filterFolder);
  const dueCards = filteredWords.filter((w) => isDue(effProgress(w, progress[w.id])));
  const total = filteredWords.length;
  const learned = filteredWords.filter((w) => (effProgress(w, progress[w.id])?.level || 0) >= MASTERY_LEVEL).length;
  const card = dueCards[idx % Math.max(dueCards.length, 1)] || null;

  async function ensureTranslation(c) {
    if (!c || c.source !== "global" || translatedIds.has(c.id)) return;
    setTranslatedIds((s) => new Set(s).add(c.id));
    try {
      const parsed = await translateWord({ wordId: c.id, word: c.de, article: c.article, lang: session.lang });
      if (parsed.translation) {
        const trans = { ru: clip(parsed.translation, LIMIT.ru), example: clip(parsed.example || c.example || "", LIMIT.example) };
        setAllWords((prev) => prev.map((w) => (w.id === c.id ? { ...w, ...trans } : w)));
      }
    } catch {
      setTranslatedIds((s) => { const n = new Set(s); n.delete(c.id); return n; });
    }
  }

  useEffect(() => { if (card) ensureTranslation(card); }, [card?.id]);

  function applyPron(wordId, pron) {
    setAllWords((prev) => prev.map((w) => (w.id === wordId ? { ...w, pron } : w)));
    const word = allWords.find((w) => w.id === wordId);
    if (word) cachePron(session, word, pron);
  }

  usePronunciation(card, session, applyPron);

  async function answer(knew) {
    if (!card) return;
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
    setProgress(newProgress);
    await saveOneProgress(session.uid, card.id, val);
    const classWords = allWords.filter((w) => w.source === "global");
    const masteryPct = classWords.length
      ? Math.round(classWords.filter((w) => (effProgress(w, newProgress[w.id])?.level || 0) >= MASTERY_LEVEL).length / classWords.length * 100)
      : undefined;
    recordActivity(session.uid, knew, masteryPct).catch(() => {});
    setRevealed(false);
    setIdx((i) => {
      if (staysDue) return i >= dueCards.length - 1 ? 0 : i + 1;
      const remaining = dueCards.length - 1;
      return remaining <= 0 ? 0 : i % remaining;
    });
  }

  const langLabel = LANGUAGES.find((l) => l.code === session.lang)?.label?.split(" ")[0] || "Muttersprache";
  const front = card ? (direction === "de2ru" ? { hint: "Deutsch → ?", article: card.article, word: card.de, isDE: true } : { hint: `${langLabel} → ?`, word: card.ru || "…", isDE: false }) : null;
  const back = card ? (direction === "de2ru" ? { word: card.ru, isDE: false } : { article: card.article, word: card.de, isDE: true }) : null;
  const cardFolder = card ? folders.find((f) => f.id === card.folderId) : null;

  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  return (<>
    <div className="stats-bar">
      <div className="stat"><div className="stat-n">{total}</div><div className="stat-l">Gesamt</div></div>
      <div className="stat"><div className={`stat-n${dueCards.length > 0 ? " due" : ""}`}>{dueCards.length}</div><div className="stat-l">Zu lernen</div></div>
      <div className="stat"><div className="stat-n ok">{learned}</div><div className="stat-l">Gelernt</div></div>
    </div>
    {total > 0 && <div className="prog-wrap">
      <div className="prog-bar"><div className="prog-fill" style={{ width: `${Math.round(learned / total * 100)}%` }} /></div>
      <div className="prog-text">{Math.round(learned / total * 100)}% gemeistert</div>
    </div>}
    {folders.length > 0 && <div className="filter-bar">
      <select value={filterFolder} onChange={(e) => { setFilterFolder(e.target.value); setIdx(0); setRevealed(false); }}>
        <option value="all">📂 Alle Ordner</option>
        {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
      </select>
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
          <div className="fc-lvl">{lvlEmoji(effProgress(card, progress[card.id])?.level)}</div>
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
