// Two interchangeable stores with the same interface:
//   subscribe(cb)   cb(items, {pending}) on every change
//   add(data)       -> id
//   update(id, patch)
//   bump(id, loc, delta)   atomic +/- on a location count
//   remove(id)
// FirebaseStore keeps the shared stock in Firestore (works offline, syncs later).
// LocalStore is the demo mode used when no Firebase config is set.

import { initializeApp } from "firebase/app";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from "firebase/auth";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc,
  increment, arrayUnion, serverTimestamp,
} from "firebase/firestore";

export const LOCS = ["keller", "aussen"];

function normalize(id, d) {
  return {
    id,
    name: String(d.name || "Ohne Namen"),
    eans: Array.isArray(d.eans) ? d.eans : [],
    keller: Math.max(0, Number(d.keller) || 0),
    aussen: Math.max(0, Number(d.aussen) || 0),
    locs: Array.isArray(d.locs) ? d.locs : [],
    cat: d.cat || null,
    // how the item is counted: "count" (whole items), "pieces" (packs of `size`), "fill" (bottles)
    pack: d.pack && ["count", "pieces", "fill"].includes(d.pack.mode) ? { mode: d.pack.mode, size: Number(d.pack.size) || 0 } : { mode: "count", size: 0 },
    // one opened pack: {loc, left} with left = pieces, or a fill level 0.25..1
    open: d.open && LOCS.includes(d.open.loc) && d.open.left > 0 ? { loc: d.open.loc, left: Number(d.open.left) } : null,
  };
}

export class FirebaseStore {
  constructor(config) {
    this.app = initializeApp(config);
    this.auth = getAuth(this.app);
    this.db = initializeFirestore(this.app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
    this.col = collection(this.db, "items");
    this.unsub = null;
    this.listeners = new Set();
  }
  onAuth(cb) { return onAuthStateChanged(this.auth, cb); }
  signIn(email, pw) { return signInWithEmailAndPassword(this.auth, email, pw); }
  signOut() { this.stop(); return signOut(this.auth); }
  get user() { return this.auth.currentUser; }

  subscribe(cb) {
    this.listeners.add(cb);
    if (!this.unsub) {
      this.unsub = onSnapshot(this.col, { includeMetadataChanges: true }, snap => {
        const items = snap.docs.map(d => normalize(d.id, d.data()));
        const meta = { pending: snap.metadata.hasPendingWrites, fromCache: snap.metadata.fromCache };
        for (const l of this.listeners) l(items, meta);
      }, err => {
        for (const l of this.listeners) l(null, { error: err });
      });
    }
    return () => this.listeners.delete(cb);
  }
  stop() { if (this.unsub) { this.unsub(); this.unsub = null; } }

  // Writes resolve once they are in the local cache; Firestore syncs them when online.
  async add(data) {
    const ref = doc(this.col);
    setDoc(ref, {
      name: data.name, eans: data.eans || [], locs: initialLocs(data),
      cat: data.cat || null, pack: data.pack || { mode: "count", size: 0 }, open: null,
      keller: data.keller || 0, aussen: data.aussen || 0,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }).catch(reportWriteError);
    return ref.id;
  }
  update(id, patch) {
    updateDoc(doc(this.col, id), { ...patch, updatedAt: serverTimestamp() }).catch(reportWriteError);
  }
  bump(id, loc, delta) {
    updateDoc(doc(this.col, id), { [loc]: increment(delta), locs: arrayUnion(loc), updatedAt: serverTimestamp() }).catch(reportWriteError);
  }
  remove(id) { deleteDoc(doc(this.col, id)).catch(reportWriteError); }
}


// Which places an item belongs to: where it has stock, or the place it was created in.
function initialLocs(data) {
  const l = LOCS.filter(k => (data[k] || 0) > 0);
  return l.length ? l : [data.home || "keller"];
}

let writeErrorHandler = () => {};
export function onWriteError(fn) { writeErrorHandler = fn; }
function reportWriteError(e) { console.error(e); writeErrorHandler(e); }

export class LocalStore {
  constructor() {
    this.items = new Map();
    this.listeners = new Set();
    try {
      for (const it of JSON.parse(localStorage.getItem("vk-demo") || "[]")) this.items.set(it.id, normalize(it.id, it));
    } catch {}
    if (!this.items.size) this.seed();
  }
  seed() {
    const ex = [
      ["Passierte Tomaten 500 g", 4, 0, "konserven"], ["Spaghetti 500 g", 2, 3, "nudeln"],
      ["Rotwein Primitivo 0,75 l", 0, 6, "alkohol", { mode: "fill" }, { loc: "aussen", left: 0.5 }],
      ["Kokosmilch 400 ml", 0, 0, "konserven"],
      ["Abenstaler Quelle Mineralwasser naturell 0,7 l", 3, 1, "getraenke"],
      ["Kinder Country 9 Riegel", 2, 0, "suesses", { mode: "pieces", size: 9 }, { loc: "keller", left: 5 }],
      ["Spülmaschinen-Tabs", 1, 0, null],
    ];
    ex.forEach(([name, keller, aussen, cat, pack, open], i) => this.items.set("demo" + i, normalize("demo" + i, {
      name, eans: i === 4 ? ["4020655033006"] : [], keller, aussen, locs: initialLocs({ keller, aussen }), cat, pack, open,
    })));
  }
  onAuth(cb) { setTimeout(() => cb({ email: "demo" }), 0); return () => {}; }
  signOut() {}
  emit() {
    try { localStorage.setItem("vk-demo", JSON.stringify([...this.items.values()])); } catch {}
    const list = [...this.items.values()].map(it => ({ ...it }));
    for (const l of this.listeners) l(list, { pending: false });
  }
  subscribe(cb) { this.listeners.add(cb); setTimeout(() => this.emit(), 0); return () => this.listeners.delete(cb); }
  async add(data) {
    const id = "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.items.set(id, normalize(id, { ...data, locs: initialLocs(data) })); this.emit(); return id;
  }
  update(id, patch) { const it = this.items.get(id); if (!it) return; Object.assign(it, JSON.parse(JSON.stringify(patch))); this.emit(); }
  bump(id, loc, delta) {
    const it = this.items.get(id); if (!it) return;
    it[loc] = Math.max(0, it[loc] + delta);
    if (!it.locs.includes(loc)) it.locs.push(loc);
    this.emit();
  }
  remove(id) { this.items.delete(id); this.emit(); }
}
