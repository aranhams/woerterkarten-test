import { useState, useEffect } from "react";
import { LIMIT, LANGUAGES } from "../lib/constants";
import { clip, validImageUrl, cldImg } from "../lib/format";
import { withTrans } from "../lib/word";
import { shuffle } from "../lib/article";
import { translateWord, getRepeatQueue } from "../lib/api";
import { cachePron } from "../data/loaders";
import { usePronunciation } from "../data/usePron";
import { SpokenWord } from "./Pronunciation";

// A repeat session renders the normal flashcards but persists NOTHING: it never
// touches meta/progress or meta/activity, so a student's SRS state and stats are
// untouched no matter how they answer. "Nochmal" only re-queues in memory.
export function RepeatSession({ session, repeat, onExit }) {
  const [deck, setDeck] = useState([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [direction, setDirection] = useState(() => localStorage.getItem("dw_dir") || "de2ru");
  const [allWords, setAllWords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [translatedIds, setTranslatedIds] = useState(() => new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const r = await getRepeatQueue({ classId: repeat.classId, repeatId: repeat.repeatId });
        if (cancelled) return;
        if (!r.active) { setError("Diese Wiederholung ist nicht mehr aktiv."); setDeck([]); setAllWords([]); }
        else { setAllWords(r.words || []); setDeck(shuffle(r.words || [])); setIdx(0); setRevealed(false); }
      } catch (e) {
        if (!cancelled) { setError(e.message || "Fehler"); setDeck([]); }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [repeat.classId, repeat.repeatId]);

  const setDir = (d) => { setDirection(d); localStorage.setItem("dw_dir", d); setRevealed(false); };

  const rawCard = deck[idx] || null;
  const card = rawCard ? withTrans(rawCard, session.lang) : null;

  async function ensureTranslation(c) {
    if (!c || c.ru || translatedIds.has(c.id)) return;
    setTranslatedIds((s) => new Set(s).add(c.id));
    try {
      const parsed = await translateWord({ wordId: c.id, word: c.de, article: c.article, lang: session.lang });
      if (parsed.translation) {
        const t = { ru: clip(parsed.translation, LIMIT.ru), example: clip(parsed.example || "", LIMIT.example) };
        const patch = (w) => (w.id === c.id ? { ...w, t: { ...(w.t || {}), [session.lang]: { ...t, de: w.de } } } : w);
        setAllWords((prev) => prev.map(patch));
        setDeck((prev) => prev.map(patch));
      }
    } catch {
      setTranslatedIds((s) => { const n = new Set(s); n.delete(c.id); return n; });
    }
  }

  useEffect(() => { if (card) ensureTranslation(card); }, [card?.id]);

  function applyPron(wordId, pron) {
    const patch = (w) => (w.id === wordId ? { ...w, pron } : w);
    setAllWords((prev) => prev.map(patch));
    setDeck((prev) => prev.map(patch));
  }
  usePronunciation(card, session, applyPron);

  function advance(reQueue) {
    if (!card) return;
    setRevealed(false);
    if (reQueue) setDeck((prev) => [...prev, prev[idx]]);
    setIdx((i) => i + 1);
  }

  const langLabel = LANGUAGES.find((l) => l.code === session.lang)?.label?.split(" ")[0] || "Muttersprache";
  const front = card ? (direction === "de2ru" ? { hint: "Deutsch → ?", article: card.article, word: card.de, isDE: true } : { hint: `${langLabel} → ?`, word: card.ru || "…", isDE: false }) : null;
  const back = card ? (direction === "de2ru" ? { word: card.ru, isDE: false } : { article: card.article, word: card.de, isDE: true }) : null;

  const done = !loading && !error && deck.length > 0 && idx >= deck.length;

  return (<>
    <div className="repeat-banner active">
      <span className="repeat-banner-txt">🔁 Wiederholung: {repeat.label || "Ordner"} — dein Fortschritt bleibt unverändert.</span>
      <button className="btn-sm" onClick={onExit}>Zurück zum normalen Lernen</button>
    </div>

    {loading ? (
      <div className="loading"><div className="spinner" /><br />Lädt…</div>
    ) : error ? (
      <div className="empty">
        <div className="emoji">⚠</div>
        <h3>{error}</h3>
        <button className="btn-add" style={{ marginTop: 14 }} onClick={onExit}>Zurück</button>
      </div>
    ) : allWords.length === 0 ? (
      <div className="empty">
        <div className="emoji">📭</div>
        <h3>Keine Wörter zum Wiederholen</h3>
        <button className="btn-add" style={{ marginTop: 14 }} onClick={onExit}>Zurück</button>
      </div>
    ) : done ? (
      <div className="empty">
        <div className="emoji">🎉</div>
        <h3>Wiederholung geschafft!</h3>
        <p style={{ fontSize: 14 }}>Dein Fortschritt wurde nicht verändert.</p>
        <button className="btn-add" style={{ marginTop: 14 }} onClick={onExit}>Zurück zum normalen Lernen</button>
      </div>
    ) : card ? (<>
      <div className="dir-toggle">
        <button className={`dir-btn${direction === "de2ru" ? " active" : ""}`} onClick={() => setDir("de2ru")}>Deutsch</button>
        <span style={{ color: "var(--sage-light)", padding: "0 2px" }}>⇄</span>
        <button className={`dir-btn${direction === "ru2de" ? " active" : ""}`} onClick={() => setDir("ru2de")}>{langLabel}</button>
      </div>
      <div className="dsc-nav"><span className="dsc-nav-pos">{idx + 1} / {deck.length}</span></div>
      <div className="fc-wrap">
        <div className="fc" translate="no" onClick={() => !revealed && setRevealed(true)}>
          <div className="fc-folder">🔁 {repeat.label || "Wiederholung"}</div>
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
        <button className="btn-forgot" onClick={() => advance(true)}>😬 Nochmal</button>
        <button className="btn-knew" onClick={() => advance(false)}>✓ Weiter</button>
      </div>}
    </>) : null}
  </>);
}
