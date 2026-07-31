import { LIMIT } from "./constants";
import { clip, cleanArticle, validImageUrl } from "./format";

export function validateWordInput({ de, article, ru, example, imageUrl }, { requireRu = false } = {}) {
  const cleanDe = clip(String(de ?? "").trim(), LIMIT.de);
  if (!cleanDe) return { ok: false, error: "Bitte ein deutsches Wort eingeben." };

  const cleanRu = clip(String(ru ?? "").trim(), LIMIT.ru);
  if (requireRu && !cleanRu) return { ok: false, error: "Bitte eine Übersetzung eingeben." };

  const img = String(imageUrl ?? "").trim();
  if (img && !validImageUrl(img)) return { ok: false, error: "Ungültige Bild-URL." };

  return {
    ok: true,
    clean: {
      de: cleanDe,
      article: cleanArticle(article),
      ru: cleanRu,
      example: clip(String(example ?? "").trim(), LIMIT.example),
      imageUrl: img || null,
    },
  };
}

export function germanChanged(oldWord, next) {
  const oldDe = String(oldWord?.de ?? "").trim();
  const newDe = String(next?.de ?? "").trim();
  return oldDe !== newDe || cleanArticle(oldWord?.article) !== cleanArticle(next?.article);
}

export function nextDeRev(oldWord, next) {
  return (oldWord?.deRev || 0) + (germanChanged(oldWord, next) ? 1 : 0);
}
