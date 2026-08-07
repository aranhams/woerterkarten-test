import { useState, useRef, useEffect } from "react";
import { validAudioUrl } from "../lib/format";
import { pronState } from "../lib/pron";

let currentAudio = null;

export function Pronunciation({ word }) {
  const [playing, setPlaying] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const audioRef = useRef(null);

  const state = pronState(word);
  const p = word.pron || {};
  const url = state === "ready" && validAudioUrl(p.url) ? p.url : null;

  useEffect(() => () => {
    if (audioRef.current) {
      audioRef.current.pause();
      if (currentAudio === audioRef.current) currentAudio = null;
      audioRef.current = null;
    }
  }, []);

  useEffect(() => { setPlaying(false); }, [word.id]);

  function play(e) {
    e.stopPropagation();
    if (!url) return;
    if (currentAudio && currentAudio !== audioRef.current) currentAudio.pause();
    if (audioRef.current) audioRef.current.pause();

    const audio = new Audio(url);
    audio.preload = "none";
    audio.addEventListener("ended", () => setPlaying(false));
    audio.addEventListener("error", () => setPlaying(false));
    audioRef.current = audio;
    currentAudio = audio;
    setPlaying(true);
    audio.play().catch(() => setPlaying(false));
  }

  const hint =
    state === "pending" ? "⏳ Aussprache wird vorbereitet …"
    : !url ? "Keine Aussprachedaten"
    : null;

  return (
    <div className="pron" onClick={(e) => e.stopPropagation()}>
      <div className="pron-head">
        <span className="pron-label">
          Aussprache
          <button type="button" className="pron-info-btn" aria-expanded={showInfo}
            aria-label="Was die Markierung bedeutet" onClick={() => setShowInfo((v) => !v)}>ⓘ</button>
        </span>
        <span className="pron-title">Betonung</span>
      </div>

      <div className="pron-main">
        <button type="button" className={`pron-play${playing ? " playing" : ""}`} onClick={play}
          disabled={!url} aria-label={url ? `${word.de} anhören` : "Aussprache nicht verfügbar"}>
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">
            <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
          </svg>
        </button>
        <span className="pron-word" translate="no">{p.bet || word.de}</span>
      </div>

      {hint && <div className="pron-hint">{hint}</div>}

      {showInfo && (
        <div className="pron-info">
          Der Strich unter dem Vokal heißt <b>betont und lang</b>, der Punkt darunter
          <b> betont und kurz</b>.
          <br />
          <span className="pron-credit">Betonungsdaten: Wiktionary (CC BY-SA)</span>
        </div>
      )}
    </div>
  );
}
