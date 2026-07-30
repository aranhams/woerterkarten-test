import { doc, getDoc, setDoc, getDocs, deleteDoc, collection } from "firebase/firestore";
import { db } from "../lib/firebase";

export async function dbGet(path) {
  try { const snap = await getDoc(doc(db, ...path.split("/"))); return snap.exists() ? snap.data() : null; }
  catch { return null; }
}

export async function dbSet(path, data) {
  await setDoc(doc(db, ...path.split("/")), data, { merge: true });
}

export async function dbGetAll(col) {
  try { const snap = await getDocs(collection(db, col)); return snap.docs.map((d) => ({ id: d.id, ...d.data() })); }
  catch { return []; }
}

export async function dbDelete(path) {
  await deleteDoc(doc(db, ...path.split("/")));
}
