import { useState, useEffect } from "react";
import { onAuthStateChanged, signOut, getIdTokenResult } from "firebase/auth";
import { auth } from "./lib/firebase";
import { dbGet } from "./data/db";
import { clearDataCache } from "./data/cache";
import "./styles/app.css";
import { UserMenu } from "./components/UserMenu";
import { AuthScreen } from "./components/AuthScreen";
import { LearnTab } from "./components/tabs/LearnTab";
import { WordsTab } from "./components/tabs/WordsTab";
import { FoldersTab } from "./components/tabs/FoldersTab";
import { ManageTab } from "./components/tabs/ManageTab";
import { KurseTab } from "./components/tabs/KurseTab";
import { StudentsTab } from "./components/tabs/StudentsTab";
import { AdminTab } from "./components/tabs/AdminTab";

const TAB_KEY = "dw_tab";
function tabAllowed(t, { isTeacher, isAdmin, studentView }) {
  const learner = !isTeacher || studentView;
  if (t === "learn" || t === "words" || t === "folders") return learner;
  if (t === "manage" || t === "kurse") return isTeacher;
  if (t === "admin") return isAdmin;
  return false;
}

export default function App() {
  const [session, setSession] = useState(null);
  const [tab, setTab] = useState("learn");
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [studentView, setStudentView] = useState(() => localStorage.getItem("dw_studentview") === "1");

  useEffect(() => {
    return onAuthStateChanged(auth, async (user) => {
      if (!user) { clearDataCache(); setSession(null); setLoading(false); return; }
      const [profile, tokenRes] = await Promise.all([
        dbGet(`users/${user.uid}`),
        getIdTokenResult(user),
      ]);
      const isTeacher = tokenRes.claims.teacher === true || tokenRes.claims.admin === true;
      const isAdmin = tokenRes.claims.admin === true;
      setSession({
        uid: user.uid,
        username: profile?.username || "Nutzer",
        lang: profile?.lang || "RU",
        isTeacher,
        isAdmin,
      });
      const saved = localStorage.getItem(TAB_KEY);
      const sv = localStorage.getItem("dw_studentview") === "1";
      const fallback = isTeacher ? "manage" : "learn";
      setTab(saved && tabAllowed(saved, { isTeacher, isAdmin, studentView: sv }) ? saved : fallback);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!loading && session) localStorage.setItem(TAB_KEY, tab);
  }, [tab, loading, session]);

  function logout() { localStorage.removeItem(TAB_KEY); signOut(auth); }
  function toggleStudentView() {
    const nv = !studentView;
    localStorage.setItem("dw_studentview", nv ? "1" : "0");
    setStudentView(nv);
    if (!nv && (tab === "learn" || tab === "words" || tab === "folders")) setTab("manage");
  }

  if (loading) return <div className="app"><div className="loading"><div className="spinner" /><br />Lädt…</div></div>;
  if (!session || registering) return <div className="app"><AuthScreen setRegistering={setRegistering} /></div>;

  const learnerTabs = !session.isTeacher || studentView;

  return (<div className="app">
    <header className="header">
      <div className="brand"><h1>Wörterkarten</h1><span>Deutsch lernen</span></div>
      <UserMenu session={session} onLogout={logout} studentView={studentView} onToggleStudentView={toggleStudentView} />
    </header>
    <nav className="nav">
      {learnerTabs && <button className={`nav-tab${tab === "learn" ? " active" : ""}`} onClick={() => setTab("learn")}>🃏 Lernen</button>}
      {learnerTabs && <button className={`nav-tab${tab === "words" ? " active" : ""}`} onClick={() => setTab("words")}>📋 Wörter</button>}
      {learnerTabs && <button className={`nav-tab${tab === "folders" ? " active" : ""}`} onClick={() => setTab("folders")}>📁 Ordner</button>}
      {session.isTeacher && <button className={`nav-tab${tab === "manage" ? " active" : ""}`} onClick={() => setTab("manage")}>✏️ Verwalten</button>}
      {session.isTeacher && <button className={`nav-tab${tab === "kurse" ? " active" : ""}`} onClick={() => setTab("kurse")}>👥 Kurse</button>}
      {session.isAdmin && <button className={`nav-tab${tab === "admin" ? " active" : ""}`} onClick={() => setTab("admin")}>🔐 Administration</button>}
    </nav>
    {tab === "learn" && learnerTabs && <LearnTab session={session} />}
    {tab === "words" && learnerTabs && <WordsTab session={session} />}
    {tab === "folders" && learnerTabs && <FoldersTab session={session} />}
    {tab === "manage" && session.isTeacher && <ManageTab session={session} />}
    {tab === "kurse" && session.isTeacher && <KurseTab session={session} />}
    {tab === "admin" && session.isAdmin && <><AdminTab /><StudentsTab session={session} /></>}
  </div>);
}
