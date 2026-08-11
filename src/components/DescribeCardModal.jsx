import { useState } from "react";
import { validImageUrl, cldImg } from "../lib/format";
import { descFresh } from "../lib/word";
import { usePronunciation } from "../data/usePron";
import { SpokenWord } from "./Pronunciation";

export function DescribeCardModal({ word, folders, session, onPron, onClose }) {
  const [revealed, setRevealed] = useState(false);
  usePronunciation(revealed ? word : null, session, onPron || (() => {}));

  const folder = folders.find((f) => f.id === word.folderId);
  const fresh = descFresh(word);
  const hasImage = word.imageUrl && validImageUrl(word.imageUrl);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="fc" translate="no" style={{ cursor: "default", width: "min(520px, 100%)", minWidth: "min(420px, 100%)", maxWidth: "100%", padding: 36 }} onClick={(e) => e.stopPropagation()}>
        {folder && <div className="fc-folder">{folder.icon} {folder.name}</div>}
        <button className="btn-del" style={{ position: "absolute", top: 10, right: 10 }} onClick={onClose}>✕</button>

        <section style={{ width: "100%", textAlign: "left" }}>
          <div className="fc-hint">Beschreibung</div>
          {hasImage && <img src={cldImg(word.imageUrl, 600)} className="fc-img" alt="" decoding="async" style={{ marginTop: 8, marginLeft: "auto", marginRight: "auto", width: 180, height: 180, display: "block" }} />}
          <div style={{ fontSize: 18, lineHeight: 1.5, color: "var(--ink)", marginTop: hasImage ? 12 : 4 }}>
            {fresh
              ? `„${word.desc.text}"`
              : <span style={{ color: "#ccc", fontSize: 14 }}>Noch keine Beschreibung.</span>}
          </div>
        </section>

        <hr style={{ border: 0, borderTop: "1px solid var(--ivory-dark)", margin: "20px 0", width: "100%" }} />

        <section style={{ width: "100%", textAlign: "center" }}>
          <div className="fc-hint">Wort</div>
          {!revealed ? (
            <button className="btn-main" style={{ marginTop: 10 }} onClick={() => setRevealed(true)}>Auflösen</button>
          ) : (<>
            {word.article && <div className="fc-article" style={{ marginTop: 10 }}>{word.article}</div>}
            <SpokenWord word={word} style={{ fontSize: 30 }} />
            {word.ru && <div className="fc-ru" style={{ opacity: 0.7, fontSize: 16 }}>{word.ru}</div>}
          </>)}
        </section>
      </div>
    </div>
  );
}
