import { useEffect } from "react";
import { LIMIT } from "../lib/constants";
import { clip, validImageUrl, cldImg } from "../lib/format";
import { translateWord } from "../lib/api";

export function WordCardModal({ word, folders, session, trans, onTranslated, onClose }) {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (word.source !== "global" || trans[word.id]) return;
      try {
        const parsed = await translateWord({ wordId: word.id, word: word.de, article: word.article, lang: session.lang });
        if (!cancelled && parsed.translation) {
          onTranslated(word.id, { ru: clip(parsed.translation, LIMIT.ru), example: clip(parsed.example || word.example || "", LIMIT.example) });
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [word.id]);

  const t = word.source === "global" ? trans[word.id] : null;
  const w = t ? { ...word, ru: t.ru, example: t.example || word.example } : word;
  const folder = folders.find((f) => f.id === w.folderId);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="fc" translate="no" style={{ cursor: "default", width: "fit-content", minWidth: "min(340px, 100%)", maxWidth: "100%" }} onClick={(e) => e.stopPropagation()}>
        {folder && <div className="fc-folder">{folder.icon} {folder.name}</div>}
        <button className="btn-del" style={{ position: "absolute", top: 10, right: 10 }} onClick={onClose}>✕</button>
        {w.imageUrl && validImageUrl(w.imageUrl) && <img src={cldImg(w.imageUrl, 600)} className="fc-img" alt="" decoding="async" />}
        {w.article && <div className="fc-article">{w.article}</div>}
        <div className="fc-word">{w.de}</div>
        <div className="fc-ru">{w.ru || <span style={{ color: "#ccc", fontSize: 14 }}>⏳ Wird übersetzt…</span>}</div>
        {w.example && <div className="fc-example">„{w.example}"</div>}
      </div>
    </div>
  );
}
