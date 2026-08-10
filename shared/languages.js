export const LANGS = [
  { code: "RU", label: "Русский 🇷🇺",     name: "Russisch" },
  { code: "UK", label: "Українська 🇺🇦",  name: "Ukrainisch" },
  { code: "TR", label: "Türkçe 🇹🇷",      name: "Türkisch" },
  { code: "AR", label: "العربية 🇸🇦",      name: "Arabisch" },
  { code: "PL", label: "Polski 🇵🇱",      name: "Polnisch" },
  { code: "RO", label: "Română 🇷🇴",      name: "Rumänisch" },
  { code: "FA", label: "فارسی 🇮🇷",       name: "Persisch" },
  { code: "VI", label: "Tiếng Việt 🇻🇳",  name: "Vietnamesisch" },
  { code: "ZH", label: "中文 🇨🇳",         name: "Chinesisch" },
  { code: "ES", label: "Español 🇪🇸",     name: "Spanisch" },
  { code: "FR", label: "Français 🇫🇷",    name: "Französisch" },
  { code: "EN", label: "English 🇬🇧",     name: "Englisch" },
  { code: "IT", label: "Italiano 🇮🇹",    name: "Italienisch" },
  { code: "PT", label: "Português 🇧🇷",   name: "Portugiesisch" },
  { code: "JA", label: "日本語 🇯🇵",       name: "Japanisch" },
  { code: "MK", label: "Македонски 🇲🇰",   name: "Mazedonisch" },
];

export const LANGUAGES = LANGS.map(({ code, label }) => ({ code, label }));

export const LANG_CODES = LANGS.map((l) => l.code);

export const LANG_NAMES = Object.fromEntries(LANGS.map((l) => [l.code, l.name]));
