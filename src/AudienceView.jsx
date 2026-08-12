import { useState, useEffect } from "react";
import { validImageUrl, cldImg } from "./lib/format";
import { SpokenWord } from "./components/Pronunciation";
import { openChannel } from "./lib/present";

export default function AudienceView() {
  const [state, setState] = useState({ card: null, revealed: false });

  useEffect(() => {
    const ch = openChannel();
    if (!ch) return;
    ch.onmessage = (e) => {
      const m = e.data;
      if (!m || typeof m !== "object") return;
      if (m.type === "state") setState({ card: m.card, revealed: !!m.revealed });
      if (m.type === "closed") setState({ card: null, revealed: false });
    };
    ch.postMessage({ type: "hello" });
    return () => ch.close();
  }, []);

  const w = state.card;
  const revealed = state.revealed;
  const hasImage = w && w.imageUrl && validImageUrl(w.imageUrl);

  if (!w) {
    return (
      <div className="aud-stage">
        <div className="aud-idle">
          <div className="aud-idle-emoji">🃏</div>
          <p>Warte auf die Lehrkraft …</p>
        </div>
      </div>
    );
  }

  return (
    <div className="aud-stage">
      <div className="aud-card" translate="no">
        {w.folder && <div className="fc-folder aud-folder">{w.folder.icon} {w.folder.name}</div>}

        <div className="dsc-tag aud-tag">Beschreibung</div>
        <div className="aud-desc">
          {w.desc && w.desc.text
            ? `„${w.desc.text}"`
            : <span style={{ color: "var(--ink-soft)", fontStyle: "italic" }}>— noch keine Beschreibung</span>}
        </div>

        {revealed && (<>
          <hr className="aud-hr" />
          <div className="aud-reveal">
            {hasImage && <img src={cldImg(w.imageUrl, 900)} className="aud-img" alt="" decoding="async" />}
            {w.article && <div className="fc-article aud-article">{w.article}</div>}
            <SpokenWord word={w} style={{ fontSize: 64 }} />
            {w.ru && <div className="fc-ru aud-ru">{w.ru}</div>}
          </div>
        </>)}
      </div>
    </div>
  );
}
