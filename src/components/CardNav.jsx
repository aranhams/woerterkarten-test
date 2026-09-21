import { useEffect } from "react";

export function useCardNavKeys(goPrev, goNext, deps) {
  useEffect(() => {
    function onKey(e) {
      if (e.target.closest?.('input, select, textarea, [contenteditable="true"]')) return;
      if (e.key === "ArrowRight") { e.preventDefault(); goNext(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

export function CardNav({ pos, len, onPrev, onNext, children }) {
  return (<>
    <div className="fc-pos" aria-live="polite" aria-atomic="true">{len ? pos + 1 : 0} / {len}</div>
    <div className="fc-stage">
      <button type="button" className="fc-nav-btn" onClick={onPrev} disabled={pos <= 0} aria-label="Vorherige Karte">‹</button>
      <div className="fc-wrap">{children}</div>
      <button type="button" className="fc-nav-btn" onClick={onNext} disabled={pos >= len - 1} aria-label="Nächste Karte">›</button>
    </div>
  </>);
}
