import { useState, useEffect, useRef } from "react";
import { JoinClass } from "./JoinClass";
import { ChangePassword } from "./ChangePassword";

export function UserMenu({ session, onLogout, studentView, onToggleStudentView, onOpenAdmin }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDocClick); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div className="user-menu" ref={ref}>
      <button className="user-pill" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <span className="dot" />
        {session.username}
        {session.isTeacher && <span className="teacher-badge">Lehrerin</span>}
        <span className="user-caret" style={{ transform: open ? "rotate(180deg)" : "none" }}>▾</span>
      </button>
      {open && (
        <div className="user-menu-dropdown" role="menu">
          <div className="user-menu-head">
            <div className="user-menu-name">{session.username}</div>
            <div className="user-menu-sub">{session.isTeacher ? "Lehrerin" : "Angemeldet"}</div>
          </div>
          {!session.isTeacher && <JoinClass session={session} />}
          {session.isTeacher && (
            <div className="menu-toggle" role="menuitemcheckbox" aria-checked={studentView} onClick={onToggleStudentView}>
              <span>Schüler-Ansicht</span>
              <span className={`switch${studentView ? " on" : ""}`}><span className="switch-knob" /></span>
            </div>
          )}
          <ChangePassword session={session} />
          {session.isAdmin && (
            <button className="user-menu-item neutral" role="menuitem" onClick={() => { setOpen(false); onOpenAdmin?.(); }}>
              Administration
            </button>
          )}
          <button className="user-menu-item" role="menuitem" onClick={() => { setOpen(false); onLogout(); }}>
            ↪ Abmelden
          </button>
        </div>
      )}
    </div>
  );
}
