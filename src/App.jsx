// Woerterkarten — HARDENED (security patch).
// See SECURITY_PATCH_CHANGES.txt for the full finding->fix mapping.
//
//   F2  Real authentication via Firebase Auth (no localStorage "session").
//   F3  Role (isTeacher) read ONLY from the verified ID-token claim.
//   F4  No client-side password hashing — Firebase Auth handles credentials.
//   F5  Teacher code verified server-side (/api/claim-teacher); not in the bundle.
//   F6  All user data keyed by request.auth.uid (not a client string) -> no IDOR.
//   F8  Username sanitised + base32-encoded -> no Firestore path injection.
//   F9  Integrity fields (source/addedBy) enforced by firestore.rules, not trusted.
//   F10 Translate goes through the authenticated, rate-limited /api/translate.
//   F11 Generic auth errors (no user enumeration).
//   F13 Minimum password length raised to 8.
//   F7  Cloudinary uploads are SIGNED via /api/sign-cloudinary (auth required).
// NOTE: not sufficient alone — deploy firestore.rules + the /api functions + vercel.json.

import { useState, useEffect } from "react";
import { initializeApp } from "firebase/app";
import {
  getFirestore, doc, getDoc, setDoc, collection, getDocs, deleteDoc, serverTimestamp,
} from "firebase/firestore";
import {
  getAuth, onAuthStateChanged, signOut, setPersistence, browserLocalPersistence,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, getIdTokenResult,
} from "firebase/auth";

// Firebase Web config is public by design; harden it with API-key HTTP-referrer
// restrictions + Firebase App Check (see the patch notes), not by hiding it.
// Firebase Web config. Values come from VITE_FIREBASE_* env vars when set (point
// these at a TEST project for local/staging), falling back to the production
// project otherwise. The config is public by design (harden with API-key
// referrer restrictions + App Check, not by hiding it).
const env = import.meta.env;
const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(() => {});

// ---- validation limits (defence in depth; firestore.rules re-enforces) ----
const LIMIT = { username: 32, password: 8, de: 100, ru: 200, example: 300, folder: 60 };
const ARTICLES = ["", "der", "die", "das", "ein", "eine"];
const clip = (s, n) => String(s ?? "").slice(0, n);
function cleanArticle(a) { a = String(a || "").trim().toLowerCase(); return ARTICLES.includes(a) ? a : ""; }
function validImageUrl(u) { return u == null || /^https:\/\/res\.cloudinary\.com\/[^\s]+$/.test(u); }
// Rewrite a stored Cloudinary secure_url into an optimized delivery URL:
// f_auto (WebP/AVIF), q_auto (auto quality) and c_limit,w_<w> to cap the
// delivered pixel size. Stored URLs have no transforms, so we insert once.
function cldImg(u, w = 400) {
  if (!u || !u.includes("/image/upload/") || /\/image\/upload\/[^/]*(?:f_auto|q_auto|w_\d)/.test(u)) return u;
  return u.replace("/image/upload/", `/image/upload/f_auto,q_auto,c_limit,w_${w}/`);
}

// Deterministic, collision-free username -> email local part (base32 of UTF-8).
// Guarantees a valid email and lets Firebase Auth enforce username uniqueness (F8).
function b32(str) {
  const bytes = new TextEncoder().encode(str);
  const A = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, val = 0, out = "";
  for (const byte of bytes) { val = (val << 8) | byte; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}
const emailForUsername = (u) => `u-${b32(u.trim().toLowerCase())}@users.woerterkarten.app`;

async function idToken() { return auth.currentUser ? auth.currentUser.getIdToken() : null; }

// ---- Cloudinary signed upload via /api/sign-cloudinary (fixes F7) ----------
async function uploadImage(file) {
  if (!file.type.startsWith("image/")) throw new Error("Nur Bilder erlaubt.");
  if (file.size > 5 * 1024 * 1024) throw new Error("Bild zu groß (max 5 MB).");
  const token = await idToken();
  const sigRes = await fetch("/api/sign-cloudinary", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (!sigRes.ok) throw new Error("Signatur fehlgeschlagen.");
  const { signature, timestamp, apiKey, cloudName, folder } = await sigRes.json();
  const fd = new FormData();
  fd.append("file", file);
  fd.append("api_key", apiKey);
  fd.append("timestamp", timestamp);
  fd.append("signature", signature);
  if (folder) fd.append("folder", folder);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { method: "POST", body: fd });
  const data = await res.json();
  if (!data.secure_url) throw new Error("Upload fehlgeschlagen");
  return data.secure_url;
}

// ---- Firestore helpers: paths built from a trusted uid, never user text -----
async function dbGet(path) {
  try { const snap = await getDoc(doc(db, ...path.split("/"))); return snap.exists() ? snap.data() : null; } catch { return null; }
}
async function dbSet(path, data) {
  await setDoc(doc(db, ...path.split("/")), data, { merge: true });
}
async function dbGetAll(col) {
  try { const snap = await getDocs(collection(db, col)); return snap.docs.map((d) => ({ id: d.id, ...d.data() })); } catch { return []; }
}

const INTERVALS = [0, 1, 3, 7, 14, 30];
function nextReview(level, knew) { const l = knew ? Math.min(level + 1, INTERVALS.length - 1) : 0; return { level: l, due: Date.now() + INTERVALS[l] * 86400000 }; }
function isDue(p) { return !p?.due || Date.now() >= p.due; }
const lvlEmoji = (l) => ["🌱", "🌿", "🌲", "⭐", "🏆", "💎"][l ?? 0] || "🌱";

const LANGUAGES = [
  { code: "RU", label: "Русский 🇷🇺" }, { code: "UK", label: "Українська 🇺🇦" }, { code: "TR", label: "Türkçe 🇹🇷" },
  { code: "AR", label: "العربية 🇸🇦" }, { code: "PL", label: "Polski 🇵🇱" }, { code: "RO", label: "Română 🇷🇴" },
  { code: "FA", label: "فارسی 🇮🇷" }, { code: "VI", label: "Tiếng Việt 🇻🇳" }, { code: "ZH", label: "中文 🇨🇳" },
  { code: "ES", label: "Español 🇪🇸" }, { code: "FR", label: "Français 🇫🇷" }, { code: "EN", label: "English 🇬🇧" },
  { code: "IT", label: "Italiano 🇮🇹" }, { code: "PT", label: "Português 🇵🇹" }, { code: "JA", label: "日本語 🇯🇵" },
];

const css = `
  @import url('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  :root{--ink:#1a1a2e;--ink-soft:#3d3d5c;--ivory:#f8f5ef;--ivory-dark:#ede9e0;--sage:#5a7a6a;--sage-light:#8aaa96;--sage-pale:#e8f0eb;--accent:#c8773a;--accent-pale:#f5ebe0;--red-soft:#c0392b;--red-pale:#fdecea;--shadow:0 4px 24px rgba(26,26,46,0.10);--radius:14px;}
  body{background:var(--ivory);color:var(--ink);font-family:'Inter',system-ui,sans-serif;min-height:100vh;}
  h1,h2,h3{font-family:'Lora',Georgia,serif;}
  .app{max-width:700px;margin:0 auto;padding:24px 16px 60px;}
  .header{display:flex;align-items:center;justify-content:space-between;padding-bottom:18px;border-bottom:1.5px solid var(--ivory-dark);margin-bottom:24px;}
  .brand h1{font-size:21px;letter-spacing:-0.5px;} .brand span{font-size:12px;color:var(--sage);font-style:italic;font-family:'Lora',serif;}
  .user-pill{display:flex;align-items:center;gap:8px;background:var(--sage-pale);border-radius:99px;padding:6px 14px 6px 10px;cursor:pointer;border:none;font-size:13px;color:var(--sage);font-family:inherit;transition:background .15s;}
  .user-pill:hover{background:#d4e4da;} .dot{width:8px;height:8px;border-radius:50%;background:var(--sage);}
  .teacher-badge{background:var(--accent-pale);color:var(--accent);font-size:11px;padding:2px 8px;border-radius:99px;font-weight:600;}
  .auth-wrap{display:flex;flex-direction:column;align-items:center;padding:40px 0 24px;}
  .auth-wrap h2{font-size:26px;margin-bottom:6px;} .auth-wrap p{color:var(--ink-soft);font-size:14px;margin-bottom:28px;}
  .auth-box{background:white;border-radius:var(--radius);box-shadow:var(--shadow);padding:28px;width:100%;max-width:360px;}
  .auth-box label{display:block;font-size:12px;font-weight:600;color:var(--ink-soft);margin-bottom:5px;letter-spacing:.3px;text-transform:uppercase;}
  .auth-box input,.auth-box select{width:100%;padding:10px 13px;border:1.5px solid var(--ivory-dark);border-radius:8px;font-size:14px;color:var(--ink);background:var(--ivory);outline:none;font-family:inherit;margin-bottom:14px;transition:border-color .15s;}
  .auth-box input:focus,.auth-box select:focus{border-color:var(--sage);background:white;}
  .btn-main{width:100%;padding:11px;background:var(--ink);color:white;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .15s;}
  .btn-main:hover{background:var(--ink-soft);} .btn-main:disabled{opacity:.4;cursor:not-allowed;}
  .auth-switch{margin-top:16px;font-size:13px;color:var(--sage);cursor:pointer;background:none;border:none;text-decoration:underline;font-family:inherit;display:block;width:100%;text-align:center;}
  .err{color:var(--red-soft);font-size:13px;margin-top:4px;} .ok{color:var(--sage);font-size:13px;margin-top:4px;}
  .nav{display:flex;gap:4px;background:var(--ivory-dark);border-radius:10px;padding:4px;margin-bottom:22px;}
  .nav-tab{flex:1;padding:8px 6px;border:none;border-radius:7px;font-size:13px;font-weight:500;cursor:pointer;background:transparent;color:var(--ink-soft);font-family:inherit;transition:all .15s;}
  .nav-tab.active{background:white;color:var(--ink);box-shadow:0 1px 4px rgba(0,0,0,.10);}
  .stats-bar{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px;}
  .stat{background:white;border-radius:10px;padding:13px 10px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.06);}
  .stat-n{font-family:'Lora',serif;font-size:24px;font-weight:600;line-height:1;}
  .stat-l{font-size:10px;color:var(--ink-soft);margin-top:3px;text-transform:uppercase;letter-spacing:.5px;}
  .stat-n.due{color:var(--accent);} .stat-n.ok{color:var(--sage);}
  .dir-toggle{display:flex;align-items:center;gap:0;background:var(--ivory-dark);border-radius:99px;padding:3px;margin:0 auto 16px;width:fit-content;}
  .dir-btn{padding:6px 16px;border:none;border-radius:99px;font-size:13px;font-weight:500;cursor:pointer;background:transparent;color:var(--ink-soft);font-family:inherit;transition:all .15s;}
  .dir-btn.active{background:white;color:var(--ink);box-shadow:0 1px 4px rgba(0,0,0,.10);font-weight:600;}
  .prog-wrap{margin-bottom:14px;} .prog-bar{height:4px;background:var(--ivory-dark);border-radius:99px;overflow:hidden;margin-bottom:6px;}
  .prog-fill{height:100%;background:var(--sage);border-radius:99px;transition:width .3s;} .prog-text{font-size:11px;color:var(--ink-soft);text-align:right;}
  .fc-wrap{margin:0 auto 18px;}
  .fc{background:white;border-radius:var(--radius);box-shadow:var(--shadow);padding:28px;min-height:210px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;cursor:pointer;transition:transform .15s,box-shadow .15s;position:relative;user-select:none;}
  .fc:hover{transform:translateY(-2px);box-shadow:0 8px 32px rgba(26,26,46,.13);}
  .fc-img{width:120px;height:120px;object-fit:cover;border-radius:12px;margin-bottom:14px;box-shadow:0 2px 8px rgba(0,0,0,.10);}
  .fc-hint{font-size:10px;color:var(--sage-light);text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px;}
  .fc-article{font-size:17px;color:var(--accent);font-family:'Lora',serif;font-style:italic;}
  .fc-word{font-family:'Lora',serif;font-size:32px;font-weight:600;color:var(--ink);line-height:1.2;}
  .fc-ru{font-size:18px;color:var(--ink-soft);margin-top:10px;}
  .fc-example{font-size:13px;color:var(--ink-soft);margin-top:8px;font-style:italic;border-top:1px solid var(--ivory-dark);padding-top:8px;max-width:340px;}
  .fc-tap{font-size:11px;color:#ccc;margin-top:18px;} .fc-lvl{position:absolute;top:13px;right:13px;font-size:11px;color:var(--sage-light);}
  .fc-folder{position:absolute;top:13px;left:13px;font-size:11px;color:var(--accent);background:var(--accent-pale);padding:2px 8px;border-radius:99px;}
  .ans-btns{display:flex;gap:10px;margin-top:2px;}
  .btn-knew{flex:1;padding:13px;background:var(--sage-pale);color:var(--sage);border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .15s;}
  .btn-knew:hover{background:#c4dccb;}
  .btn-forgot{flex:1;padding:13px;background:var(--red-pale);color:var(--red-soft);border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .15s;}
  .btn-forgot:hover{background:#fad5d2;}
  .empty{text-align:center;padding:40px 16px;color:var(--ink-soft);}
  .empty .emoji{font-size:44px;margin-bottom:14px;} .empty h3{font-size:18px;margin-bottom:6px;color:var(--ink);}
  .word-list{display:flex;flex-direction:column;gap:8px;}
  .word-item{background:white;border-radius:10px;padding:13px 14px;display:flex;align-items:center;gap:10px;box-shadow:0 1px 4px rgba(0,0,0,.06);}
  .wi-img{width:44px;height:44px;object-fit:cover;border-radius:8px;flex-shrink:0;}
  .wi-img-placeholder{width:44px;height:44px;border-radius:8px;background:var(--ivory-dark);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;}
  .wi-text{flex:1;} .wi-de{font-weight:600;font-size:15px;} .wi-article{color:var(--accent);font-style:italic;font-size:13px;margin-right:3px;}
  .wi-ru{font-size:13px;color:var(--ink-soft);margin-top:2px;}
  .wi-folder{font-size:10px;background:var(--accent-pale);color:var(--accent);padding:2px 7px;border-radius:99px;font-weight:600;white-space:nowrap;}
  .wi-badge{font-size:10px;padding:2px 7px;border-radius:99px;font-weight:600;text-transform:uppercase;}
  .badge-g{background:var(--sage-pale);color:var(--sage);} .badge-p{background:var(--accent-pale);color:var(--accent);}
  .btn-del{background:none;border:none;cursor:pointer;color:#ccc;font-size:15px;padding:3px 5px;border-radius:6px;transition:color .15s,background .15s;}
  .btn-del:hover{color:var(--red-soft);background:var(--red-pale);}
  .add-form{background:white;border-radius:var(--radius);padding:22px;box-shadow:var(--shadow);margin-bottom:18px;}
  .add-form h3{font-size:16px;margin-bottom:14px;}
  .form-row{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;}
  .form-row input,.add-form input,.add-form select,.add-form textarea{flex:1;padding:9px 12px;border:1.5px solid var(--ivory-dark);border-radius:8px;font-size:13px;color:var(--ink);background:var(--ivory);outline:none;font-family:inherit;transition:border-color .15s;min-width:80px;}
  .form-row input:focus,.add-form input:focus,.add-form select:focus,.add-form textarea:focus{border-color:var(--sage);background:white;}
  .in-sm{width:80px;flex:none !important;}
  .btn-add{padding:9px 18px;background:var(--sage);color:white;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .15s;white-space:nowrap;}
  .btn-add:hover{background:var(--ink);} .btn-add:disabled{opacity:.4;cursor:not-allowed;}
  .sec-label{font-size:11px;font-weight:600;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.5px;margin-bottom:9px;margin-top:2px;}
  .folder-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:20px;}
  .folder-card{background:white;border-radius:12px;padding:16px 14px;box-shadow:0 1px 4px rgba(0,0,0,.06);cursor:pointer;border:2px solid transparent;transition:all .15s;}
  .folder-card:hover{border-color:var(--sage-light);transform:translateY(-1px);} .folder-card.active{border-color:var(--sage);} .folder-card.all{border-color:var(--ivory-dark);}
  .folder-icon{font-size:22px;margin-bottom:6px;} .folder-name{font-size:14px;font-weight:600;color:var(--ink);} .folder-count{font-size:11px;color:var(--ink-soft);margin-top:2px;}
  .folder-actions{display:flex;gap:6px;align-items:center;margin-bottom:4px;}
  .btn-sm{padding:5px 12px;border:1.5px solid var(--ivory-dark);background:white;border-radius:7px;font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;color:var(--ink-soft);transition:all .15s;}
  .btn-sm:hover{border-color:var(--sage);color:var(--sage);} .btn-sm.danger:hover{border-color:var(--red-soft);color:var(--red-soft);}
  select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%238aaa96' stroke-width='1.5' fill='none'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:28px !important;}
  .filter-bar{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center;}
  .filter-bar select{flex:1;min-width:120px;max-width:200px;} .filter-bar input{flex:2;min-width:120px;}
  .loading{text-align:center;padding:60px 16px;color:var(--ink-soft);font-size:15px;}
  .spinner{display:inline-block;width:32px;height:32px;border:3px solid var(--ivory-dark);border-top-color:var(--sage);border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:16px;}
  @keyframes spin{to{transform:rotate(360deg);}}
  .img-upload-area{border:2px dashed var(--ivory-dark);border-radius:8px;padding:12px;text-align:center;cursor:pointer;transition:border-color .15s;background:var(--ivory);position:relative;}
  .img-upload-area:hover{border-color:var(--sage);}
  .img-upload-area input[type=file]{position:absolute;inset:0;opacity:0;cursor:pointer;}
  .img-preview{width:60px;height:60px;object-fit:cover;border-radius:8px;display:block;margin:0 auto 6px;}
  .img-upload-label{font-size:12px;color:var(--ink-soft);}
  .uploading-indicator{font-size:12px;color:var(--sage);margin-top:4px;}
`;

export default function App() {
  const [session, setSession] = useState(null);   // {uid, username, lang, isTeacher}
  const [tab, setTab] = useState("learn");
  const [loading, setLoading] = useState(true);

  // Single source of truth: Firebase Auth. Role comes from the verified claim.
  useEffect(() => {
    return onAuthStateChanged(auth, async (user) => {
      if (!user) { setSession(null); setLoading(false); return; }
      const [profile, tokenRes] = await Promise.all([
        dbGet(`users/${user.uid}`),
        getIdTokenResult(user),
      ]);
      setSession({
        uid: user.uid,
        username: profile?.username || "Nutzer",
        lang: profile?.lang || "RU",
        isTeacher: tokenRes.claims.teacher === true,
      });
      setTab("learn");
      setLoading(false);
    });
  }, []);

  function logout() { signOut(auth); }

  if (loading) return <><style>{css}</style><div className="app"><div className="loading"><div className="spinner" /><br />Lädt…</div></div></>;
  if (!session) return <><style>{css}</style><div className="app"><AuthScreen /></div></>;

  return (<><style>{css}</style><div className="app">
    <header className="header">
      <div className="brand"><h1>Wörterkarten</h1><span>Deutsch lernen</span></div>
      <button className="user-pill" onClick={logout}>
        <span className="dot" />
        {session.username}
        {session.isTeacher && <span className="teacher-badge">Lehrerin</span>}
      </button>
    </header>
    <nav className="nav">
      <button className={`nav-tab${tab === "learn" ? " active" : ""}`} onClick={() => setTab("learn")}>🃏 Lernen</button>
      <button className={`nav-tab${tab === "words" ? " active" : ""}`} onClick={() => setTab("words")}>📋 Wörter</button>
      <button className={`nav-tab${tab === "folders" ? " active" : ""}`} onClick={() => setTab("folders")}>📁 Ordner</button>
      {session.isTeacher && <button className={`nav-tab${tab === "manage" ? " active" : ""}`} onClick={() => setTab("manage")}>✏️ Verwalten</button>}
    </nav>
    {tab === "learn" && <LearnTab session={session} />}
    {tab === "words" && <WordsTab session={session} />}
    {tab === "folders" && <FoldersTab session={session} />}
    {/* Defense in depth: even if this renders, firestore.rules blocks non-teachers. */}
    {tab === "manage" && session.isTeacher && <ManageTab />}
  </div></>);
}

function AuthScreen() {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [lang, setLang] = useState("RU");
  const [teacherCode, setTeacherCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    setErr(""); setBusy(true);
    const u = username.trim();
    if (!u || !password) { setErr("Fehlende Angaben."); setBusy(false); return; }
    if (u.length > LIMIT.username) { setErr("Benutzername zu lang."); setBusy(false); return; }
    const email = emailForUsername(u);
    try {
      if (mode === "login") {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        if (password.length < LIMIT.password) { setErr(`Passwort mindestens ${LIMIT.password} Zeichen.`); setBusy(false); return; }
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        await dbSet(`users/${cred.user.uid}`, { username: u, lang, createdAt: serverTimestamp() });
        // Teacher role granted server-side after code verification (F5).
        if (teacherCode) {
          try {
            const token = await cred.user.getIdToken();
            await fetch("/api/claim-teacher", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ code: teacherCode }),
            });
            await cred.user.getIdToken(true); // refresh so the claim is live
          } catch { /* wrong code is not fatal to signup — stay a normal user */ }
        }
      }
    } catch {
      setErr(mode === "login" ? "Login fehlgeschlagen." : "Registrierung fehlgeschlagen (Name evtl. vergeben).");
    }
    setBusy(false);
  }

  return (
    <div className="auth-wrap">
      <h2>{mode === "login" ? "Willkommen zurück 👋" : "Konto erstellen 🌱"}</h2>
      <p>{mode === "login" ? "Melde dich mit deinem Konto an." : "Wähle einen Namen und ein Passwort."}</p>
      <div className="auth-box">
        <label>Benutzername</label>
        <input placeholder="z. B. Maria" value={username} maxLength={LIMIT.username} onChange={(e) => setUsername(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && handleSubmit()} />
        <label>Passwort</label>
        <input type="password" placeholder="••••••" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSubmit()} />
        {mode === "register" && <>
          <label>Deine Muttersprache</label>
          <select value={lang} onChange={(e) => setLang(e.target.value)}>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
          <label>Lehrerinnen-Code (optional)</label>
          <input placeholder="Nur für die Lehrerin" value={teacherCode} onChange={(e) => setTeacherCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSubmit()} />
        </>}
        {err && <p className="err">{err}</p>}
        <button className="btn-main" style={{ marginTop: 6 }} onClick={handleSubmit} disabled={!username.trim() || !password || busy}>
          {busy ? "Lädt…" : mode === "login" ? "Einloggen" : "Registrieren"}
        </button>
        <button className="auth-switch" onClick={() => { setMode((m) => (m === "login" ? "register" : "login")); setErr(""); }}>
          {mode === "login" ? "Noch kein Konto? Registrieren →" : "← Zurück zum Login"}
        </button>
      </div>
    </div>
  );
}

// All per-user paths built from the trusted uid (session.uid), never a name.
async function loadGlobalWords() { return await dbGetAll("global_words"); }
async function loadGlobalFolders() { return await dbGetAll("global_folders"); }
async function loadUserWords(uid) { return await dbGetAll(`users/${uid}/words`); }
async function loadUserFolders(uid) { return await dbGetAll(`users/${uid}/folders`); }
async function loadLangTranslations(lang) { return await dbGetAll(`global_translations/${lang}/words`); }
async function loadProgress(uid) { const d = await dbGet(`users/${uid}/meta/progress`); return d?.data || {}; }
async function saveProgress(uid, progress) { await dbSet(`users/${uid}/meta/progress`, { data: progress }); }

function ImageUpload({ value, onChange, small }) {
  const [uploading, setUploading] = useState(false);
  async function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try { onChange(await uploadImage(file)); }
    catch (err) { alert(err.message || "Upload fehlgeschlagen."); }
    setUploading(false);
  }
  return (
    <div className="img-upload-area" style={small ? { width: 80, padding: 8 } : {}}>
      <input type="file" accept="image/*" onChange={handleFile} />
      {value
        ? <img src={value} className="img-preview" style={small ? { width: 44, height: 44 } : {}} alt="" />
        : <div className="img-upload-label">{uploading ? "⏳" : "📷"}<br />{uploading ? "Lädt…" : small ? "Bild" : "Bild hochladen"}</div>}
    </div>
  );
}

function LearnTab({ session }) {
  const [revealed, setRevealed] = useState(false);
  const [idx, setIdx] = useState(0);
  const [direction, setDirection] = useState(() => localStorage.getItem("dw_dir") || "de2ru");
  const [filterFolder, setFilterFolder] = useState("all");
  const [allWords, setAllWords] = useState([]);
  const [folders, setFolders] = useState([]);
  const [progress, setProgress] = useState({});
  const [loading, setLoading] = useState(true);
  const [translatedIds, setTranslatedIds] = useState(() => new Set());

  useEffect(() => {
    (async () => {
      const [gw, uw, gf, uf, prog, ut] = await Promise.all([loadGlobalWords(), loadUserWords(session.uid), loadGlobalFolders(), loadUserFolders(session.uid), loadProgress(session.uid), loadLangTranslations(session.lang)]);
      // Overlay the shared per-language translation cache onto the global words,
      // so every learner of this language reuses the same saved translations
      // (one Anthropic call per word per language, not per student).
      const tmap = {};
      ut.forEach((t) => { tmap[t.id] = t; });
      const mergedGW = gw.map((w) => (tmap[w.id] ? { ...w, ru: tmap[w.id].ru, example: tmap[w.id].example || w.example } : w));
      setAllWords([...mergedGW, ...uw]);
      setTranslatedIds(new Set(Object.keys(tmap)));
      setFolders([...gf.map((f) => ({ ...f, source: "global" })), ...uf.map((f) => ({ ...f, source: "personal" }))]);
      setProgress(prog); setLoading(false);
    })();
  }, []);

  const setDir = (d) => { setDirection(d); localStorage.setItem("dw_dir", d); setRevealed(false); setIdx(0); };
  const filteredWords = filterFolder === "all" ? allWords : allWords.filter((w) => w.folderId === filterFolder);
  const dueCards = filteredWords.filter((w) => isDue(progress[w.id]));
  const total = filteredWords.length;
  const learned = filteredWords.filter((w) => (progress[w.id]?.level || 0) >= 3).length;
  const card = dueCards[idx % Math.max(dueCards.length, 1)] || null;

  // Feature: shared per-language auto-translation of global words. When a global
  // card isn't translated for this language yet, call the authenticated,
  // rate-limited /api/translate proxy with the wordId. The SERVER checks/writes a
  // shared cache at global_translations/{lang}/words/{wordId} (Admin SDK), so the
  // first student of a language pays the tokens and everyone else gets a cache
  // hit. The client never writes the cache (firestore.rules) — no poisoning.
  async function ensureTranslation(c) {
    if (!c || c.source !== "global" || translatedIds.has(c.id)) return;
    setTranslatedIds((s) => new Set(s).add(c.id)); // mark first so we call the API at most once per card
    try {
      const token = await idToken();
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ wordId: c.id, word: c.de, article: c.article, lang: session.lang }),
      });
      if (!res.ok) throw new Error("translate failed");
      const parsed = await res.json();
      if (parsed.translation) {
        const trans = { ru: clip(parsed.translation, LIMIT.ru), example: clip(parsed.example || c.example || "", LIMIT.example) };
        setAllWords((prev) => prev.map((w) => (w.id === c.id ? { ...w, ...trans } : w)));
      }
    } catch {
      setTranslatedIds((s) => { const n = new Set(s); n.delete(c.id); return n; }); // allow a retry on failure
    }
  }

  useEffect(() => { if (card) ensureTranslation(card); }, [card?.id]);

  async function answer(knew) {
    if (!card) return;
    const p = progress[card.id] || { level: 0 };
    const newProg = { ...progress, [card.id]: nextReview(p.level, knew) };
    setProgress(newProg);
    await saveProgress(session.uid, newProg);
    setRevealed(false);
    setIdx((i) => (i >= dueCards.length - 1 ? 0 : i + 1));
  }

  const langLabel = LANGUAGES.find((l) => l.code === session.lang)?.label?.split(" ")[0] || "Muttersprache";
  const front = card ? (direction === "de2ru" ? { hint: "Deutsch → ?", article: card.article, word: card.de, isDE: true } : { hint: `${langLabel} → ?`, word: card.ru || "…", isDE: false }) : null;
  const back = card ? (direction === "de2ru" ? { word: card.ru, isDE: false } : { article: card.article, word: card.de, isDE: true }) : null;
  const cardFolder = card ? folders.find((f) => f.id === card.folderId) : null;

  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  return (<>
    <div className="stats-bar">
      <div className="stat"><div className="stat-n">{total}</div><div className="stat-l">Gesamt</div></div>
      <div className="stat"><div className={`stat-n${dueCards.length > 0 ? " due" : ""}`}>{dueCards.length}</div><div className="stat-l">Zu lernen</div></div>
      <div className="stat"><div className="stat-n ok">{learned}</div><div className="stat-l">Gelernt</div></div>
    </div>
    {total > 0 && <div className="prog-wrap">
      <div className="prog-bar"><div className="prog-fill" style={{ width: `${Math.round(learned / total * 100)}%` }} /></div>
      <div className="prog-text">{Math.round(learned / total * 100)}% gemeistert</div>
    </div>}
    {folders.length > 0 && <div className="filter-bar">
      <select value={filterFolder} onChange={(e) => { setFilterFolder(e.target.value); setIdx(0); setRevealed(false); }}>
        <option value="all">📂 Alle Ordner</option>
        {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
      </select>
    </div>}
    {total > 0 && <div className="dir-toggle">
      <button className={`dir-btn${direction === "de2ru" ? " active" : ""}`} onClick={() => setDir("de2ru")}>Deutsch</button>
      <span style={{ color: "var(--sage-light)", padding: "0 2px" }}>⇄</span>
      <button className={`dir-btn${direction === "ru2de" ? " active" : ""}`} onClick={() => setDir("ru2de")}>{langLabel}</button>
    </div>}
    {!card ? (
      <div className="empty">
        <div className="emoji">{total === 0 ? "📭" : "🎉"}</div>
        <h3>{total === 0 ? "Noch keine Wörter" : "Alle Karten gelernt!"}</h3>
        <p style={{ fontSize: 14 }}>{total === 0 ? "Die Lehrerin fügt bald Wörter hinzu." : "Komm später wieder zurück."}</p>
      </div>
    ) : (<>
      <div className="fc-wrap">
        <div className="fc" onClick={() => !revealed && setRevealed(true)}>
          {cardFolder && <div className="fc-folder">{cardFolder.icon} {cardFolder.name}</div>}
          <div className="fc-lvl">{lvlEmoji(progress[card.id]?.level)}</div>
          {card.imageUrl && validImageUrl(card.imageUrl) && <img src={cldImg(card.imageUrl, 600)} className="fc-img" alt="" decoding="async" />}
          <div className="fc-hint">{front.hint}</div>
          {front.isDE && front.article && <div className="fc-article">{front.article}</div>}
          <div className="fc-word" style={front.isDE ? {} : { fontFamily: "'Inter',sans-serif", fontSize: 28 }}>{front.word}</div>
          {revealed ? (<>
            {back.isDE && back.article && <div className="fc-article" style={{ marginTop: 10 }}>{back.article}</div>}
            <div className={back.isDE ? "fc-word" : "fc-ru"} style={back.isDE ? { marginTop: 6, fontSize: 28 } : {}}>{back.word || <span style={{ color: "#ccc", fontSize: 14 }}>⏳ Wird übersetzt…</span>}</div>
            {card.example && <div className="fc-example">„{card.example}"</div>}
          </>) : <div className="fc-tap">Tippe, um {direction === "de2ru" ? "die Übersetzung" : "das deutsche Wort"} zu sehen</div>}
        </div>
      </div>
      {revealed && <div className="ans-btns">
        <button className="btn-forgot" onClick={() => answer(false)}>😬 Nochmal</button>
        <button className="btn-knew" onClick={() => answer(true)}>✓ Wusste ich</button>
      </div>}
    </>)}
  </>);
}

function WordsTab({ session }) {
  const [de, setDe] = useState(""); const [article, setArticle] = useState("");
  const [ru, setRu] = useState(""); const [example, setExample] = useState("");
  const [folderId, setFolderId] = useState(""); const [imageUrl, setImageUrl] = useState("");
  const [search, setSearch] = useState(""); const [filterFolder, setFilterFolder] = useState("all");
  const [allWords, setAllWords] = useState([]); const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [translating, setTranslating] = useState(false);

  useEffect(() => {
    (async () => {
      const [gw, uw, gf, uf] = await Promise.all([loadGlobalWords(), loadUserWords(session.uid), loadGlobalFolders(), loadUserFolders(session.uid)]);
      setAllWords([...gw, ...uw]);
      setFolders([...gf.map((f) => ({ ...f, source: "global" })), ...uf.map((f) => ({ ...f, source: "personal" }))]);
      setLoading(false);
    })();
  }, []);

  async function autoTranslate() {
    if (!de.trim()) return;
    setTranslating(true);
    try {
      // Authenticated, rate-limited proxy (F10); the Anthropic key stays server-side.
      const token = await idToken();
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ word: de.trim(), article: article.trim(), lang: session.lang }),
      });
      if (!res.ok) throw new Error("translate failed");
      const parsed = await res.json();
      if (parsed.translation) setRu(clip(parsed.translation, LIMIT.ru));
      if (parsed.example) setExample(clip(parsed.example, LIMIT.example));
    } catch {
      alert("Fehler beim Übersetzen. Bitte manuell eingeben.");
    }
    setTranslating(false);
  }

  async function addWord() {
    if (!de.trim() || !ru.trim()) return;
    if (imageUrl && !validImageUrl(imageUrl)) { alert("Ungültige Bild-URL."); return; }
    const id = `p_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const w = {
      de: clip(de.trim(), LIMIT.de), article: cleanArticle(article), ru: clip(ru.trim(), LIMIT.ru),
      example: clip(example.trim(), LIMIT.example), folderId: folderId || null, imageUrl: imageUrl || null,
      addedBy: session.uid, source: "personal",
    };
    try {
      await dbSet(`users/${session.uid}/words/${id}`, w);
      setAllWords((prev) => [...prev, { ...w, id }]);
      setDe(""); setArticle(""); setRu(""); setExample(""); setFolderId(""); setImageUrl("");
    } catch { alert("Speichern fehlgeschlagen."); }
  }

  async function deleteWord(word) {
    try {
      await deleteDoc(doc(db, `users/${session.uid}/words/${word.id}`));
      setAllWords((prev) => prev.filter((w) => w.id !== word.id));
    } catch { alert("Löschen fehlgeschlagen."); }
  }

  const visible = allWords.filter((w) => {
    const mf = filterFolder === "all" || w.folderId === filterFolder;
    const ms = !search || w.de.toLowerCase().includes(search.toLowerCase()) || w.ru.toLowerCase().includes(search.toLowerCase());
    return mf && ms;
  });
  const myFolders = folders.filter((f) => f.source === "personal");
  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  return (<>
    <div className="add-form">
      <h3>+ Eigenes Wort hinzufügen</h3>
      <div className="form-row">
        <input className="in-sm" placeholder="der/die/das" value={article} onChange={(e) => setArticle(e.target.value)} />
        <input placeholder="Deutsches Wort" value={de} maxLength={LIMIT.de} onChange={(e) => setDe(e.target.value)} />
        <button className="btn-add" onClick={autoTranslate} disabled={!de.trim() || translating} style={{ background: "var(--accent)", flexShrink: 0 }}>
          {translating ? "⏳" : "🤖"}
        </button>
      </div>
      <div className="form-row">
        <input placeholder="Übersetzung (Muttersprache)" value={ru} maxLength={LIMIT.ru} onChange={(e) => setRu(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addWord()} />
      </div>
      <div className="form-row">
        <input placeholder="Beispielsatz (optional)" value={example} maxLength={LIMIT.example} onChange={(e) => setExample(e.target.value)} />
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)} style={{ flex: "none", width: 160 }}>
          <option value="">📂 Kein Ordner</option>
          {myFolders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
        </select>
      </div>
      <div className="form-row" style={{ alignItems: "flex-end" }}>
        <ImageUpload value={imageUrl} onChange={setImageUrl} small />
        <button className="btn-add" onClick={addWord} disabled={!de.trim() || !ru.trim()} style={{ alignSelf: "flex-end" }}>+</button>
      </div>
    </div>
    <div className="filter-bar">
      <input placeholder="🔍 Suchen…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <select value={filterFolder} onChange={(e) => setFilterFolder(e.target.value)}>
        <option value="all">Alle Ordner</option>
        {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
      </select>
    </div>
    <div className="sec-label">Wörter ({visible.length})</div>
    <div className="word-list">
      {visible.length === 0 && <div className="empty" style={{ padding: 24 }}><p>Keine Wörter gefunden.</p></div>}
      {visible.map((w) => {
        const folder = folders.find((f) => f.id === w.folderId);
        const isOwn = w.source === "personal";  // personal words come only from this uid's subcollection
        return (
          <div className="word-item" key={w.id}>
            {w.imageUrl && validImageUrl(w.imageUrl) ? <img src={cldImg(w.imageUrl, 200)} className="wi-img" alt="" loading="lazy" decoding="async" /> : <div className="wi-img-placeholder">🔤</div>}
            <div className="wi-text">
              <div className="wi-de">{w.article && <span className="wi-article">{w.article}</span>}{w.de}</div>
              <div className="wi-ru">{w.ru}{w.example && <span style={{ fontStyle: "italic", color: "#aaa" }}> — {w.example}</span>}</div>
            </div>
            {folder && <span className="wi-folder">{folder.icon} {folder.name}</span>}
            <span className={`wi-badge ${w.source === "global" ? "badge-g" : "badge-p"}`}>{w.source === "global" ? "Kurs" : "Ich"}</span>
            {isOwn && <button className="btn-del" onClick={() => deleteWord(w)}>✕</button>}
          </div>
        );
      })}
    </div>
  </>);
}

function FoldersTab({ session }) {
  const [name, setName] = useState(""); const [icon, setIcon] = useState("📁");
  const [selected, setSelected] = useState(null);
  const [allWords, setAllWords] = useState([]); const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const icons = ["📁", "⭐", "🔤", "🏠", "🍎", "🚗", "🌍", "💼", "📚", "🎭", "🌿", "🔢"];

  useEffect(() => {
    (async () => {
      const [gw, uw, gf, uf] = await Promise.all([loadGlobalWords(), loadUserWords(session.uid), loadGlobalFolders(), loadUserFolders(session.uid)]);
      setAllWords([...gw, ...uw]);
      setFolders([...gf.map((f) => ({ ...f, source: "global" })), ...uf.map((f) => ({ ...f, source: "personal" }))]);
      setLoading(false);
    })();
  }, []);

  async function addFolder() {
    if (!name.trim()) return;
    const id = `pf_${Date.now()}`;
    const f = { name: clip(name.trim(), LIMIT.folder), icon, source: "personal" };
    try { await dbSet(`users/${session.uid}/folders/${id}`, f); setFolders((prev) => [...prev, { ...f, id }]); setName(""); setIcon("📁"); }
    catch { alert("Speichern fehlgeschlagen."); }
  }
  async function deleteFolder(fid) {
    try {
      await deleteDoc(doc(db, `users/${session.uid}/folders/${fid}`));
      setFolders((prev) => prev.filter((f) => f.id !== fid));
      if (selected === fid) setSelected(null);
    } catch { alert("Löschen fehlgeschlagen."); }
  }
  const wordsInFolder = (fid) => allWords.filter((w) => w.folderId === fid);
  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  return (<>
    <div className="add-form">
      <h3>+ Eigenen Ordner erstellen</h3>
      <div className="form-row">
        <select value={icon} onChange={(e) => setIcon(e.target.value)} style={{ flex: "none", width: 80 }}>
          {icons.map((ic) => <option key={ic} value={ic}>{ic}</option>)}
        </select>
        <input placeholder="Ordnername, z. B. Lektion 3" value={name} maxLength={LIMIT.folder} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addFolder()} />
        <button className="btn-add" onClick={addFolder} disabled={!name.trim()}>Erstellen</button>
      </div>
    </div>
    <div className="sec-label">Ordner</div>
    <div className="folder-grid">
      <div className={`folder-card all${selected === null ? " active" : ""}`} onClick={() => setSelected(null)}>
        <div className="folder-icon">📂</div>
        <div className="folder-name">Alle Wörter</div>
        <div className="folder-count">{allWords.length} Wörter</div>
      </div>
      {folders.map((f) => (
        <div key={f.id} className={`folder-card${selected === f.id ? " active" : ""}`} onClick={() => setSelected((s) => (s === f.id ? null : f.id))}>
          <div className="folder-icon">{f.icon}</div>
          <div className="folder-name">{f.name}</div>
          <div className="folder-count">{wordsInFolder(f.id).length} Wörter · {f.source === "global" ? "Kurs" : "Mein"}</div>
        </div>
      ))}
    </div>
    {selected && (() => {
      const folder = folders.find((f) => f.id === selected);
      const words = wordsInFolder(selected);
      const isOwn = folder?.source === "personal";
      return (<>
        <div className="folder-actions">
          <span style={{ fontWeight: 600, fontSize: 15 }}>{folder?.icon} {folder?.name}</span>
          {isOwn && <button className="btn-sm danger" onClick={() => deleteFolder(selected)}>Löschen</button>}
        </div>
        <div className="word-list" style={{ marginTop: 10 }}>
          {words.length === 0 && <div className="empty" style={{ padding: 20 }}><p>Noch keine Wörter in diesem Ordner.</p></div>}
          {words.map((w) => (
            <div className="word-item" key={w.id}>
              {w.imageUrl && validImageUrl(w.imageUrl) ? <img src={cldImg(w.imageUrl, 200)} className="wi-img" alt="" loading="lazy" decoding="async" /> : <div className="wi-img-placeholder">🔤</div>}
              <div className="wi-text">
                <div className="wi-de">{w.article && <span className="wi-article">{w.article}</span>}{w.de}</div>
                <div className="wi-ru">{w.ru}</div>
              </div>
              <span className={`wi-badge ${w.source === "global" ? "badge-g" : "badge-p"}`}>{w.source === "global" ? "Kurs" : "Ich"}</span>
            </div>
          ))}
        </div>
      </>);
    })()}
  </>);
}

function ManageTab() {
  // Rendered only for teachers; firestore.rules independently enforces the role.
  const [de, setDe] = useState(""); const [article, setArticle] = useState("");
  const [ru, setRu] = useState(""); const [example, setExample] = useState("");
  const [folderId, setFolderId] = useState(""); const [imageUrl, setImageUrl] = useState("");
  const [bulk, setBulk] = useState(""); const [msg, setMsg] = useState("");
  const [folderName, setFolderName] = useState(""); const [folderIcon, setFolderIcon] = useState("📁");
  const [words, setWords] = useState([]); const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const icons = ["📁", "⭐", "🔤", "🏠", "🍎", "🚗", "🌍", "💼", "📚", "🎭", "🌿", "🔢"];

  useEffect(() => {
    (async () => {
      const [gw, gf] = await Promise.all([loadGlobalWords(), loadGlobalFolders()]);
      setWords(gw); setFolders(gf); setLoading(false);
    })();
  }, []);

  function flash(m) { setMsg(m); setTimeout(() => setMsg(""), 2500); }

  async function addWord() {
    if (!de.trim()) return; // translation optional for global words — students auto-translate to their own language
    if (imageUrl && !validImageUrl(imageUrl)) { flash("⚠ Ungültige Bild-URL."); return; }
    const id = `g_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const w = { de: clip(de.trim(), LIMIT.de), article: cleanArticle(article), ru: clip(ru.trim(), LIMIT.ru), example: clip(example.trim(), LIMIT.example), folderId: folderId || null, imageUrl: imageUrl || null, addedBy: "Lehrerin", source: "global" };
    try { await dbSet(`global_words/${id}`, w); setWords((prev) => [...prev, { ...w, id }]); setDe(""); setArticle(""); setRu(""); setExample(""); setImageUrl(""); flash("✓ Wort hinzugefügt"); }
    catch { flash("⚠ Keine Berechtigung."); }
  }

  async function bulkAdd() {
    const lines = bulk.split("\n").map((l) => l.trim()).filter(Boolean);
    const newW = [];
    for (const line of lines) {
      const parts = line.split(/[–\-—|]/).map((s) => s.trim());
      if (!parts[0]) continue; // translation optional — a bare German word is allowed (auto-translated later)
      let de_ = parts[0], art_ = "", ru_ = parts[1] || "", ex_ = parts[2] || "";
      const m = de_.match(/^(der|die|das|ein|eine)\s+(.+)$/i);
      if (m) { art_ = m[1]; de_ = m[2]; }
      newW.push({ de: clip(de_, LIMIT.de), article: cleanArticle(art_), ru: clip(ru_, LIMIT.ru), example: clip(ex_, LIMIT.example), folderId: folderId || null, imageUrl: null, addedBy: "Lehrerin", source: "global" });
    }
    if (!newW.length) { flash("⚠ Format: Wort – Übersetzung"); return; }
    try {
      for (const w of newW) {
        const id = `g_${Date.now()}_${Math.random().toString(36).slice(2)}_${newW.indexOf(w)}`;
        await dbSet(`global_words/${id}`, w);
        setWords((prev) => [...prev, { ...w, id }]);
      }
      setBulk(""); flash(`✓ ${newW.length} Wörter hinzugefügt`);
    } catch { flash("⚠ Keine Berechtigung."); }
  }

  async function addFolder() {
    if (!folderName.trim()) return;
    const id = `gf_${Date.now()}`;
    const f = { name: clip(folderName.trim(), LIMIT.folder), icon: folderIcon, source: "global" };
    try { await dbSet(`global_folders/${id}`, f); setFolders((prev) => [...prev, { ...f, id }]); setFolderName(""); setFolderIcon("📁"); flash("✓ Ordner erstellt"); }
    catch { flash("⚠ Keine Berechtigung."); }
  }

  async function deleteWord(id) { try { await deleteDoc(doc(db, `global_words/${id}`)); setWords((prev) => prev.filter((w) => w.id !== id)); } catch { flash("⚠ Keine Berechtigung."); } }
  async function deleteFolder(id) { try { await deleteDoc(doc(db, `global_folders/${id}`)); setFolders((prev) => prev.filter((f) => f.id !== id)); } catch { flash("⚠ Keine Berechtigung."); } }

  if (loading) return <div className="loading"><div className="spinner" /><br />Lädt…</div>;

  return (<>
    <div className="add-form">
      <h3>📁 Kurs-Ordner erstellen</h3>
      <div className="form-row">
        <select value={folderIcon} onChange={(e) => setFolderIcon(e.target.value)} style={{ flex: "none", width: 80 }}>
          {icons.map((ic) => <option key={ic} value={ic}>{ic}</option>)}
        </select>
        <input placeholder="Ordnername, z. B. Lektion 1" value={folderName} maxLength={LIMIT.folder} onChange={(e) => setFolderName(e.target.value)} />
        <button className="btn-add" onClick={addFolder} disabled={!folderName.trim()}>Erstellen</button>
      </div>
      {folders.length > 0 && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        {folders.map((f) => <span key={f.id} style={{ background: "var(--sage-pale)", color: "var(--sage)", padding: "3px 10px", borderRadius: 99, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
          {f.icon} {f.name}
          <button style={{ background: "none", border: "none", cursor: "pointer", color: "#aaa", fontSize: 12, padding: 0 }} onClick={() => deleteFolder(f.id)}>✕</button>
        </span>)}
      </div>}
    </div>

    <div className="add-form">
      <h3>Einzelnes Wort hinzufügen</h3>
      <div className="form-row">
        <input className="in-sm" placeholder="der/die/das" value={article} onChange={(e) => setArticle(e.target.value)} />
        <input placeholder="Deutsches Wort" value={de} maxLength={LIMIT.de} onChange={(e) => setDe(e.target.value)} />
        <input placeholder="Übersetzung (optional — Schüler übersetzen selbst)" value={ru} maxLength={LIMIT.ru} onChange={(e) => setRu(e.target.value)} />
      </div>
      <div className="form-row">
        <input placeholder="Beispielsatz (optional)" value={example} maxLength={LIMIT.example} onChange={(e) => setExample(e.target.value)} />
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)} style={{ flex: "none", width: 160 }}>
          <option value="">📂 Kein Ordner</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
        </select>
      </div>
      <div className="form-row" style={{ alignItems: "flex-end" }}>
        <ImageUpload value={imageUrl} onChange={setImageUrl} small />
        <button className="btn-add" onClick={addWord} disabled={!de.trim()} style={{ alignSelf: "flex-end" }}>+</button>
      </div>
      {msg && <p className="ok">{msg}</p>}
    </div>

    <div className="add-form">
      <h3>Mehrere Wörter auf einmal</h3>
      <p style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 10 }}>Format: <code>der Hund – собака</code> oder <code>arbeiten – работать – Ich arbeite gern.</code></p>
      <div className="form-row" style={{ marginBottom: 10 }}>
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          <option value="">📂 Kein Ordner</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
        </select>
      </div>
      <textarea value={bulk} onChange={(e) => setBulk(e.target.value)} rows={5}
        placeholder={"der Hund – собака\ndie Katze – кошка\narbeiten – работать"}
        style={{ width: "100%", padding: "9px 12px", border: "1.5px solid var(--ivory-dark)", borderRadius: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical", background: "var(--ivory)", outline: "none", marginBottom: 10 }} />
      <button className="btn-add" onClick={bulkAdd} disabled={!bulk.trim()}>Alle hinzufügen</button>
    </div>

    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
      <div className="sec-label" style={{ margin: 0 }}>Kurswörter ({words.length})</div>
    </div>
    <div className="word-list">
      {words.length === 0 && <div className="empty" style={{ padding: 20 }}><p>Noch keine Kurswörter.</p></div>}
      {words.map((w) => {
        const folder = folders.find((f) => f.id === w.folderId);
        return (
          <div className="word-item" key={w.id}>
            {w.imageUrl && validImageUrl(w.imageUrl) ? <img src={cldImg(w.imageUrl, 200)} className="wi-img" alt="" loading="lazy" decoding="async" /> : <div className="wi-img-placeholder">🔤</div>}
            <div className="wi-text">
              <div className="wi-de">{w.article && <span className="wi-article">{w.article}</span>}{w.de}</div>
              <div className="wi-ru">{w.ru}{w.example && <span style={{ fontStyle: "italic", color: "#aaa" }}> — {w.example}</span>}</div>
            </div>
            {folder && <span className="wi-folder">{folder.icon} {folder.name}</span>}
            <button className="btn-del" onClick={() => deleteWord(w.id)}>✕</button>
          </div>
        );
      })}
    </div>
  </>);
}
