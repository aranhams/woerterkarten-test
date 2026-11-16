import { cldImg, validImageUrl } from "./format";
import { LANG_NAMES } from "../../shared/languages.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const CSS = `
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1a1a2e;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
@page{size:A4;margin:12mm 10mm;}
.lang-section{padding-bottom:4mm;}
h1{font-size:19px;font-weight:700;margin-bottom:3px;padding-bottom:8px;border-bottom:2px solid #ede9e0;}
h1 .lang{color:#5a7a6a;font-weight:600;font-size:15px;}
.hint{font-size:11px;color:#8a8aa0;margin:7px 0 12px;}
.pairs{display:flex;flex-direction:column;gap:9px;}
.pair{display:flex;gap:9px;break-inside:avoid;page-break-inside:avoid;}
.card{flex:1;min-width:0;border:1.5px solid #1a1a2e;border-radius:10px;padding:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:6px;min-height:120px;}
.f-img{max-height:86px;max-width:92%;object-fit:contain;border-radius:6px;}
.f-ph{font-size:30px;color:#c9c2b4;}
.de{font-family:Georgia,'Times New Roman',serif;font-size:21px;font-weight:600;line-height:1.2;overflow-wrap:break-word;}
.de .art{color:#c8773a;font-style:italic;font-weight:500;}
.tr{font-size:18px;color:#1a1a2e;font-weight:600;overflow-wrap:break-word;}
.ex{font-size:12px;color:#6b6b85;font-style:italic;overflow-wrap:break-word;}
.empty-note{font-size:13px;color:#8a8aa0;padding:20px 0;}
@media screen{body{background:#f8f5ef;padding:24px;} .lang-section{background:white;max-width:820px;margin:0 auto 24px;padding:20px;border-radius:12px;box-shadow:0 4px 24px rgba(26,26,46,.1);}}
`;

function cardHtml(w, langCode, fields) {
  const t = w.t && langCode ? w.t[langCode] : null;
  const translation = t && t.ru ? t.ru : "";
  const example = w.example || "";
  const exTrans = t && t.example ? t.example : "";
  const img = fields.image && w.imageUrl && validImageUrl(w.imageUrl) ? cldImg(w.imageUrl, 320) : null;
  const article = String(w.article || "").trim();

  const left = `<div class="card">${
    img ? `<img class="f-img" src="${esc(img)}" alt="">` : `<div class="f-ph">🔤</div>`
  }<div class="de">${article ? `<span class="art">${esc(article)}</span> ` : ""}${esc(w.de || "")}</div></div>`;

  const rightBits = [];
  if (fields.translation && langCode && translation) rightBits.push(`<div class="tr">${esc(translation)}</div>`);
  if (fields.example && (exTrans || example)) {
    const ex = exTrans && langCode ? exTrans : example;
    rightBits.push(`<div class="ex">${esc(ex)}</div>`);
  }
  const right = `<div class="card">${rightBits.join("") || "&nbsp;"}</div>`;

  return `<div class="pair">${left}${right}</div>`;
}

export function buildFolderPrintHtml({ title, langs, words, fields }) {
  const effLangs = (fields.translation && langs && langs.length) ? langs : [null];
  const sections = effLangs.map((code, i) => {
    const header = code ? `${esc(title)} <span class="lang">· ${esc(LANG_NAMES[code] || code)}</span>` : esc(title);
    const body = words.length
      ? `<div class="hint">✂ Zum Ausschneiden — links die Karte mit Bild & Deutsch, rechts die passende Karte mit Übersetzung${fields.example ? " & Beispiel" : ""}.</div><div class="pairs">${words.map((w) => cardHtml(w, code, fields)).join("")}</div>`
      : `<div class="empty-note">Keine Wörter in diesem Ordner.</div>`;
    return `<section class="lang-section"${i > 0 ? ' style="break-before:page;page-break-before:always;"' : ""}><h1>${header}</h1>${body}</section>`;
  }).join("");
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${sections}<script>window.addEventListener('load',function(){setTimeout(function(){try{window.focus();window.print();}catch(e){}},400);});</script></body></html>`;
}

export function openFolderPrint(args) {
  const win = window.open("", "_blank");
  if (!win) return false;
  win.document.open();
  win.document.write(buildFolderPrintHtml(args));
  win.document.close();
  return true;
}
