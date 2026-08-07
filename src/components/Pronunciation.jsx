import { useState, useRef, useEffect } from "react";
import { validAudioUrl } from "../lib/format";
import { pronState } from "../lib/pron";

let currentAudio = null;

export function SpokenWord({ word, style }) {
  const [playing, setPlaying] = useState(false);
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

  return (<>
    <div className="fc-word-row">
      <button type="button" className={`pron-play${playing ? " playing" : ""}`} onClick={play}
        disabled={!url} aria-label={url ? `${word.de} anhören` : "Aussprache nicht verfügbar"}>
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">
          <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
        </svg>
      </button>
      <span className="fc-word" style={style}>{word.de}</span>
      <span className="pron-spacer" aria-hidden="true" />
    </div>
    {hint && <div className="pron-hint">{hint}</div>}
  </>);
}
