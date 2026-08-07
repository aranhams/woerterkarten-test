import { useEffect, useRef } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../lib/firebase";
import { requestPronunciation } from "../lib/api";
import { pronState } from "../lib/pron";

const attempted = new Set();
const LISTEN_MS = 60_000;

export function usePronunciation(word, session, onPron) {
  const cb = useRef(onPron);
  cb.current = onPron;

  const id = word ? word.id : null;
  const de = word ? word.de : null;
  const scope = word && word.source === "global" ? "global" : "personal";
  const state = word ? pronState(word) : "ready";
  const mayTrigger = scope === "global" ? !!session.isTeacher : true;

  useEffect(() => {
    if (!id || state === "ready") return;

    const path = scope === "global" ? `global_words/${id}` : `users/${session.uid}/words/${id}`;
    let live = true;
    const unsub = onSnapshot(
      doc(db, path),
      (snap) => {
        if (!live || !snap.exists()) return;
        const pron = snap.data().pron;
        if (pron) cb.current(id, pron);
      },
      () => {},
    );
    const timer = setTimeout(() => { live = false; unsub(); }, LISTEN_MS);

    const key = `${id}:${de}`;
    if (mayTrigger && !attempted.has(key)) {
      attempted.add(key);
      requestPronunciation(id, scope).catch(() => attempted.delete(key));
    }

    return () => { live = false; clearTimeout(timer); unsub(); };
  }, [id, de, state, scope, mayTrigger, session.uid]);
}

export function forgetPronAttempt(wordId, de) {
  attempted.delete(`${wordId}:${de}`);
}
