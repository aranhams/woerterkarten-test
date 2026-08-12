export const PRESENT_CHANNEL = "dw_present";
export const PRESENT_PARAM = "present";

export function isAudienceWindow() {
  try {
    return new URLSearchParams(window.location.search).get(PRESENT_PARAM) === "1";
  } catch { return false; }
}

export function openChannel() {
  try { return new BroadcastChannel(PRESENT_CHANNEL); }
  catch { return null; }
}

export function cardPayload(word, folder) {
  if (!word) return null;
  return {
    id: word.id,
    de: word.de,
    article: word.article || "",
    ru: word.ru || "",
    desc: word.desc && word.desc.text ? { text: word.desc.text } : null,
    imageUrl: word.imageUrl || "",
    pron: word.pron || null,
    folder: folder ? { icon: folder.icon, name: folder.name } : null,
  };
}
