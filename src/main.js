import { FirebaseStore, LocalStore, LOCS, onWriteError } from "./store.js";
import { lookupProduct } from "./lookup.js";
import { Scanner, beep, unlockAudio } from "./scanner.js";

const LOC_NAME = { keller: "Keller", aussen: "Außenlager" };

const cfg = window.VK_CONFIG || {};
const demo = !cfg.firebase?.apiKey;
const store = demo ? new LocalStore() : new FirebaseStore(cfg.firebase);

const ui = loadUi();
const state = {
  items: [],
  loaded: false,
  pending: false,
  online: navigator.onLine,
  view: "alle",
  query: "",
  scanLoc: ui.scanLoc || "keller",
  scanDir: "in",
};

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");
const words = s => norm(s).split(/[^a-z0-9]+/).filter(w => w.length > 1);
const total = it => it.keller + it.aussen;
const byId = id => state.items.find(it => it.id === id);
const byEan = ean => state.items.find(it => it.eans.includes(ean));

function loadUi() { try { return JSON.parse(localStorage.getItem("vk-ui") || "{}"); } catch { return {}; } }
function saveUi() { try { localStorage.setItem("vk-ui", JSON.stringify({ scanLoc: state.scanLoc })); } catch {} }

// Items whose names share most words with `name`: used to stop duplicates.
function similar(name, exceptId) {
  const a = new Set(words(name));
  if (!a.size) return [];
  return state.items
    .filter(it => it.id !== exceptId)
    .map(it => {
      const b = new Set(words(it.name));
      let shared = 0; for (const w of a) if (b.has(w)) shared++;
      const n = norm(it.name), q = norm(name).trim();
      const score = Math.max(shared / Math.min(a.size, b.size || 1), q.length > 2 && n.includes(q) ? 0.9 : 0);
      return { it, score };
    })
    .filter(x => x.score >= 0.6)
    .sort((x, y) => y.score - x.score)
    .slice(0, 3)
    .map(x => x.it);
}

function whereHtml(it, skip) {
  const parts = LOCS.filter(l => l !== skip && it[l] > 0)
    .map(l => `<span class="where ${l}"><i></i><b>${it[l]}×</b> ${LOC_NAME[l]}</span>`);
  return parts.join("");
}

let toastTimer;
function toast(msg, undo) {
  clearTimeout(toastTimer);
  const el = $("#toast");
  el.innerHTML = `<div class="toast" role="status"><span>${esc(msg)}</span>${undo ? `<button>Rückgängig</button>` : ""}</div>`;
  if (undo) el.querySelector("button").onclick = () => { undo(); el.innerHTML = ""; };
  toastTimer = setTimeout(() => (el.innerHTML = ""), 4500);
}
// Plain-language reason for a Firebase error, with the code for troubleshooting.
function errText(e, what) {
  const code = String(e?.code || "").replace(/^firestore\//, "");
  const why = {
    "permission-denied": "Keine Berechtigung. Bitte die Firestore-Regeln prüfen (E-Mail kleingeschrieben, veröffentlicht?).",
    "not-found": "Die Datenbank wurde nicht gefunden. Wurde unter Firestore eine Datenbank erstellt?",
    "failed-precondition": "Die Datenbank ist noch nicht bereit. Wurde unter Firestore eine Datenbank erstellt?",
    "unauthenticated": "Nicht angemeldet. Bitte ab- und wieder anmelden.",
    "unavailable": "Keine Verbindung zur Datenbank.",
  }[code] || "Bitte nochmal versuchen.";
  return `${what} ${why}${code ? ` (${code})` : ""}`;
}
onWriteError(e => toast(errText(e, "Speichern hat nicht geklappt.")));

// ---------- sheets ----------
function openSheet(html, onClose) {
  const host = $("#sheet");
  host.innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const bg = host.firstElementChild;
  bg.addEventListener("click", e => { if (e.target === bg) closeSheet(); });
  host._onClose = onClose;
  return bg.firstElementChild;
}
function closeSheet() {
  const host = $("#sheet");
  if (!host.innerHTML) return;
  host.innerHTML = "";
  const cb = host._onClose; host._onClose = null;
  cb && cb();
}

function stepperHtml(key, n) {
  return `<div class="stepper" data-key="${key}">
    <button type="button" data-d="-1" aria-label="Eins weniger" ${n ? "" : "disabled"}>−</button>
    <input inputmode="numeric" pattern="[0-9]*" class="${n ? "" : "zero"}" value="${n}" aria-label="Anzahl">
    <button type="button" class="plus" data-d="1" aria-label="Eins mehr">+</button></div>`;
}

// New item: from the + button, an empty search, or an unknown barcode.
function newItemSheet({ name = "", ean = null, loc = state.scanLoc, n = 1, lookingUp = false, onDone } = {}) {
  const counts = { keller: 0, aussen: 0 }; counts[loc] = n;
  const s = openSheet(`
    <h2>${ean ? "Neuer Artikel" : "Artikel anlegen"}</h2>
    ${ean ? `<div class="hint" id="ni-hint">${lookingUp ? `<span class="spinner"></span>&nbsp; Suche Produktnamen …` : "Diesen Barcode kennt eure Vorratskammer noch nicht."}</div>` : ""}
    <div class="field"><label for="ni-name">Name</label>
      <input class="text" id="ni-name" value="${esc(name)}" placeholder="z. B. Passierte Tomaten 500 g" autocomplete="off" enterkeyhint="done"></div>
    <div class="suggest" id="ni-sim"></div>
    <div class="field"><span class="label">Wie viele?</span>
      ${LOCS.map(l => `<div class="locline"><span class="locname"><i style="background:var(--${l})"></i>${LOC_NAME[l]}</span>${stepperHtml("ni-" + l, counts[l])}</div>`).join("")}
    </div>
    ${ean ? `<div class="hint">Barcode ${esc(ean)} wird gemerkt. Beim nächsten Scan wird der Artikel sofort erkannt.</div>` : ""}
    <div class="btnrow"><button class="btn ghost" id="ni-cancel">Abbrechen</button><button class="btn primary" id="ni-save">Speichern</button></div>
  `, () => onDone && onDone(null));

  const nameEl = $("#ni-name", s);
  const showSimilar = () => {
    const sim = similar(nameEl.value);
    $("#ni-sim", s).innerHTML = sim.length ? `<span class="label">Schon vorhanden?</span>` + sim.map(it =>
      `<button type="button" data-id="${it.id}"><span>${esc(it.name)}</span><span>${ean ? "Das ist es" : "Öffnen"}</span></button>`).join("") : "";
  };
  nameEl.addEventListener("input", showSimilar);
  showSimilar();
  $("#ni-sim", s).addEventListener("click", e => {
    const b = e.target.closest("[data-id]"); if (!b) return;
    const it = byId(b.dataset.id);
    const done = onDone; onDone = null;
    closeSheet();
    if (ean) {
      // link this barcode to the existing item and count it there
      store.update(it.id, { eans: [...new Set([...it.eans, ean])] });
      done && done(it.id, true);
    } else {
      itemSheet(it.id);
    }
  });
  wireSteppers(s, (key, n) => { counts[key.slice(3)] = n; return n; }, key => counts[key.slice(3)]);
  $("#ni-cancel", s).onclick = closeSheet;
  $("#ni-save", s).onclick = async () => {
    const nm = nameEl.value.trim();
    if (!nm) { nameEl.focus(); nameEl.placeholder = "Bitte einen Namen eintragen"; return; }
    const id = await store.add({ name: nm, eans: ean ? [ean] : [], keller: counts.keller, aussen: counts.aussen, home: loc });
    const done = onDone; onDone = null;
    closeSheet();
    toast(`${nm} angelegt`);
    done && done(id, false);
  };
  if (!ean) setTimeout(() => nameEl.focus(), 60);
  return {
    setName(v) {
      const h = $("#ni-hint", s);
      if (h) h.textContent = v ? "Name aus der Produktdatenbank, bitte kurz prüfen." : "Nicht in der Produktdatenbank. Bitte Namen eintippen.";
      if (v && !nameEl.value) { nameEl.value = v; showSimilar(); }
      if (!v) nameEl.focus();
    },
  };
}

// Steppers inside a sheet. get(key) -> n, set(key, n) applies the change.
function wireSteppers(root, set, get) {
  const paint = (st, n) => {
    const inp = st.querySelector("input");
    inp.value = n; inp.classList.toggle("zero", !n);
    st.querySelector("[data-d='-1']").disabled = !n;
  };
  root.querySelectorAll(".stepper").forEach(st => {
    const key = st.dataset.key;
    st.addEventListener("click", e => {
      const b = e.target.closest("[data-d]"); if (!b) return;
      const n = Math.max(0, get(key) + Number(b.dataset.d));
      paint(st, set(key, n, Number(b.dataset.d)));
    });
    const inp = st.querySelector("input");
    inp.addEventListener("focus", () => inp.select());
    inp.addEventListener("change", () => paint(st, set(key, Math.max(0, Math.min(999, parseInt(inp.value) || 0)))));
  });
}

// Details of one item: counts in both places, rename, barcodes, delete.
function itemSheet(id) {
  const it = byId(id); if (!it) return;
  const s = openSheet(`
    <div class="field"><label for="it-name">Name</label><input class="text" id="it-name" value="${esc(it.name)}" autocomplete="off" enterkeyhint="done"></div>
    ${LOCS.map(l => `<div class="locline"><span class="locname"><i style="background:var(--${l})"></i>${LOC_NAME[l]}</span>${stepperHtml("it-" + l, it[l])}</div>`).join("")}
    <div class="field"><span class="label">Barcodes</span>
      <div class="chips">${it.eans.length ? it.eans.map(e => `<span class="chip">${esc(e)}</span>`).join("") : `<span class="hint">Noch keiner. Scanne den Artikel und wähle ihn bei „Schon vorhanden?“ aus.</span>`}</div></div>
    <button class="btn primary" id="it-done">Fertig</button>
    <button class="linkbtn danger" id="it-del">Artikel löschen</button>
  `);
  const nameEl = $("#it-name", s);
  const saveName = () => { const v = nameEl.value.trim(); const cur = byId(id); if (v && cur && v !== cur.name) store.update(id, { name: v }); };
  nameEl.addEventListener("change", saveName);
  wireSteppers(s, (key, n, d) => {
    const loc = key.slice(3), cur = byId(id);
    if (!cur) return n;
    if (n !== cur[loc]) store.bump(id, loc, n - cur[loc]);
    cur[loc] = n; // optimistic until the snapshot arrives
    return n;
  }, key => byId(id)?.[key.slice(3)] ?? 0);
  $("#it-done", s).onclick = () => { saveName(); closeSheet(); };
  $("#it-del", s).onclick = () => {
    const cur = byId(id);
    const c = openSheet(`<h2>${esc(cur.name)} löschen?</h2><div class="hint">Der Artikel verschwindet auf beiden Handys, aus Keller und Außenlager.</div>
      <div class="btnrow"><button class="btn ghost" id="d-no">Behalten</button><button class="btn danger" id="d-yes">Löschen</button></div>`);
    $("#d-no", c).onclick = () => itemSheet(id);
    $("#d-yes", c).onclick = () => { store.remove(id); closeSheet(); toast(`${cur.name} gelöscht`); };
  };
}

// ---------- main screen ----------
function renderShell() {
  $("#app").innerHTML = `
    <div class="wrap">
      <header>
        <div class="brand"><h1>Vorratskammer</h1>
          <button class="status" id="status" aria-label="Status und Abmelden"><span class="dot" id="dot"></span><span id="stxt"></span></button></div>
        ${demo ? `<div class="demo">Demo-Modus: Die Daten bleiben nur auf diesem Gerät, bis die Datenbank verbunden ist.</div>` : ""}
        <div class="search">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input id="q" type="search" placeholder="Haben wir noch …?" autocomplete="off" autocorrect="off" enterkeyhint="search" aria-label="Vorrat durchsuchen">
          <button class="iconbtn" id="qclear" hidden aria-label="Suche leeren">✕</button>
        </div>
        <div class="tabs" role="group" aria-label="Lagerort">
          <button data-view="alle">Alle<span class="n" id="n-alle"></span></button>
          <button data-view="keller">Keller<span class="n" id="n-keller"></span></button>
          <button data-view="aussen">Außenlager<span class="n" id="n-aussen"></span></button>
        </div>
      </header>
      <ul class="list" id="list"></ul>
      <div id="empty"></div>
    </div>
    <div class="bar"><div class="in">
      <button class="btn primary" id="scan">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8M10 8v8M13 8v8M17 8v8"/></svg>
        Scannen</button>
      <button class="btn ghost" id="add">＋ Neu</button>
    </div></div>
    <div id="scanhost"></div>`;

  $("#q").addEventListener("input", e => { state.query = e.target.value; renderList(); });
  $("#qclear").onclick = () => { state.query = ""; $("#q").value = ""; renderList(); $("#q").focus(); };
  document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => {
    state.view = b.dataset.view;
    if (state.view !== "alle") { state.scanLoc = state.view; saveUi(); }
    renderList(); window.scrollTo({ top: 0 });
  });
  $("#add").onclick = () => newItemSheet({ name: state.query, loc: state.view !== "alle" ? state.view : state.scanLoc });
  $("#scan").onclick = () => { unlockAudio(); openScanner(); };
  $("#status").onclick = statusSheet;

  const list = $("#list");
  list.addEventListener("click", e => {
    const row = e.target.closest("[data-id]"); if (!row) return;
    const id = row.dataset.id;
    const b = e.target.closest("[data-d]");
    if (b) {
      const it = byId(id), loc = state.view, d = Number(b.dataset.d);
      if (d < 0 && !it[loc]) return;
      store.bump(id, loc, d);
      it[loc] = Math.max(0, it[loc] + d); renderList();
      return;
    }
    if (e.target.closest(".txt")) itemSheet(id);
  });
  list.addEventListener("focusin", e => { if (e.target.matches(".stepper input")) e.target.select(); });
  list.addEventListener("change", e => {
    if (!e.target.matches(".stepper input")) return;
    const id = e.target.closest("[data-id]").dataset.id;
    const n = Math.max(0, Math.min(999, parseInt(e.target.value) || 0));
    const it = byId(id);
    if (n !== it[state.view]) store.bump(id, state.view, n - it[state.view]);
    it[state.view] = n; renderList();
  });
  $("#empty").addEventListener("click", e => {
    if (e.target.closest("#add-q")) newItemSheet({ name: state.query, loc: state.view !== "alle" ? state.view : state.scanLoc });
  });
  window.addEventListener("online", () => { state.online = true; renderStatus(); });
  window.addEventListener("offline", () => { state.online = false; renderStatus(); });
}

function renderStatus() {
  const dot = $("#dot"), t = $("#stxt"); if (!dot) return;
  dot.className = "dot";
  if (demo) { dot.classList.add("sync"); t.textContent = "Demo"; }
  else if (!state.online) { dot.classList.add("off"); t.textContent = "Offline, wird später synchronisiert"; }
  else if (state.pending) { dot.classList.add("sync"); t.textContent = "Synchronisiere …"; }
  else t.textContent = "Aktuell";
}

function statusSheet() {
  const s = openSheet(`<h2>Vorratskammer</h2>
    <div class="hint">${demo ? "Demo-Modus ohne gemeinsame Datenbank." : `Angemeldet als ${esc(store.user?.email || "")}. Änderungen ohne Empfang werden gespeichert und automatisch übertragen, sobald das Handy wieder online ist.`}</div>
    <button class="btn ghost" id="st-close">Schließen</button>
    ${demo ? "" : `<button class="linkbtn danger" id="st-out">Abmelden</button>`}`);
  $("#st-close", s).onclick = closeSheet;
  if (!demo) $("#st-out", s).onclick = () => { closeSheet(); store.signOut(); };
}

function visibleItems() {
  const q = norm(state.query).trim();
  let list = state.items;
  // A place shows what is there now, plus what used to be there (so you can count it back up).
  if (state.view !== "alle") list = list.filter(it => it[state.view] > 0 || it.locs.includes(state.view));
  if (q) {
    const qs = q.split(/\s+/);
    list = list.filter(it => { const n = norm(it.name); return qs.every(w => n.includes(w)) || it.eans.includes(q); });
  }
  const key = it => (state.view === "alle" ? total(it) : it[state.view]) > 0 ? 0 : 1;
  return [...list].sort((a, b) => key(a) - key(b) || a.name.localeCompare(b.name, "de"));
}

function renderList() {
  document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", b.dataset.view === state.view));
  $("#n-alle").textContent = state.items.length || "";
  for (const l of LOCS) $("#n-" + l).textContent = state.items.filter(it => it[l] > 0 || it.locs.includes(l)).length || "";
  $("#qclear").hidden = !state.query;

  const list = visibleItems();
  $("#list").innerHTML = list.map(it => {
    if (state.view === "alle") {
      const t = total(it);
      return `<li class="item" data-id="${it.id}">
        <button class="txt"><span class="name">${esc(it.name)}</span><span class="sub">${whereHtml(it) || `<span>Nichts mehr da</span>`}</span></button>
        <div class="total ${t ? "" : "out"}">${t || "leer"}</div></li>`;
    }
    const n = it[state.view], others = whereHtml(it, state.view);
    return `<li class="item" data-id="${it.id}">
      <button class="txt"><span class="name">${esc(it.name)}</span>${others || !n ? `<span class="sub">${n ? "" : "<span>Hier leer</span>"}${others ? `<span>noch ${others}</span>` : ""}</span>` : ""}</button>
      ${stepperHtml("row", n)}</li>`;
  }).join("");

  let empty = "";
  if (state.loadError) empty = `<div class="empty"><strong>Da stimmt etwas nicht.</strong><span>${esc(state.loadError)}</span></div>`;
  else if (!state.loaded) empty = `<div class="empty"><span class="spinner"></span><span>Lade euren Vorrat …</span></div>`;
  else if (!list.length && state.query) {
    empty = `<div class="empty"><strong>„${esc(state.query)}“ haben wir ${state.view === "alle" ? "nicht" : "nicht im " + LOC_NAME[state.view]}.</strong>
      <span>Also ab auf die Einkaufsliste. Oder doch da? Dann leg es an.</span>
      <button class="btn ghost small" id="add-q">„${esc(state.query)}“ anlegen</button></div>`;
  } else if (!list.length) {
    empty = `<div class="empty"><strong>${state.view === "alle" ? "Noch nichts erfasst." : "Im " + LOC_NAME[state.view] + " ist noch nichts erfasst."}</strong>
      <span>Tippe auf „Scannen“ und halte die Kamera auf einen Barcode. Oder lege einen Artikel mit „Neu“ von Hand an.</span></div>`;
  }
  $("#empty").innerHTML = empty;
}

// ---------- scanner ----------
let scanner = null;
let lastResult = null;

function openScanner() {
  const host = $("#scanhost");
  host.innerHTML = `<div class="scanner" role="dialog" aria-label="Barcode scannen">
    <video muted playsinline></video>
    <div class="top">
      <div class="row">
        <div class="seg dir" id="sc-dir"><button data-v="in">＋ Rein</button><button data-v="out">− Raus</button></div>
        <button class="close" id="sc-close" aria-label="Scanner schließen">✕</button>
      </div>
      <div class="seg" id="sc-loc">${LOCS.map(l => `<button data-v="${l}">${LOC_NAME[l]}</button>`).join("")}</div>
    </div>
    <div class="aim"><div id="sc-aim"></div></div>
    <div class="msg" id="sc-msg"><span class="spinner"></span>&nbsp; Kamera startet …</div>
    <div class="card" id="sc-card"><div class="hint">Halte den Barcode in den Rahmen. Gezählt wird automatisch.</div></div>
  </div>`;
  document.body.style.overflow = "hidden";
  document.body.classList.add("scanning");
  paintScanControls();
  $("#sc-dir").onclick = e => { const b = e.target.closest("[data-v]"); if (!b) return; state.scanDir = b.dataset.v; paintScanControls(); };
  $("#sc-loc").onclick = e => { const b = e.target.closest("[data-v]"); if (!b) return; state.scanLoc = b.dataset.v; saveUi(); paintScanControls(); };
  $("#sc-close").onclick = closeScanner;

  scanner = new Scanner($("video", host), onScan);
  scanner.start().then(() => { $("#sc-msg").hidden = true; }).catch(err => {
    console.error(err);
    const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    $("#sc-msg").innerHTML = denied
      ? "Die App darf die Kamera nicht benutzen.<br>Erlaube den Zugriff unter Einstellungen → Safari → Kamera, und öffne den Scanner dann erneut."
      : "Die Kamera ließ sich nicht starten. Schließe den Scanner und versuch es nochmal.";
  });
}

function closeScanner() {
  if (scanner) scanner.stop();
  scanner = null; lastResult = null;
  $("#scanhost").innerHTML = "";
  document.body.style.overflow = "";
  document.body.classList.remove("scanning");
  renderList();
}

function paintScanControls() {
  document.querySelectorAll("#sc-dir [data-v]").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === state.scanDir));
  document.querySelectorAll("#sc-loc [data-v]").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === state.scanLoc));
}

function flashAim() {
  const a = $("#sc-aim"); if (!a) return;
  a.classList.add("hit"); setTimeout(() => a.classList.remove("hit"), 500);
}

async function onScan(code) {
  if (!scanner) return;
  flashAim();
  const it = byEan(code);
  if (it) { beep(true); countScan(it.id); return; }

  // Unknown barcode: pause, look it up, ask for a name.
  beep(true);
  scanner.paused = true;
  const sheet = newItemSheet({
    ean: code, loc: state.scanLoc, n: state.scanDir === "in" ? 1 : 0, lookingUp: true,
    onDone: (id, linked) => {
      if (!scanner) return;
      scanner.paused = false;
      if (id && linked) countScan(id);
      else if (id) setTimeout(() => showResult(id, null), 300);
    },
  });
  const name = await lookupProduct(code);
  sheet.setName(name);
}

// Count a known item according to the Rein/Raus and place settings.
function countScan(id) {
  const it = byId(id); if (!it) return;
  const loc = state.scanLoc, d = state.scanDir === "in" ? 1 : -1;
  if (d < 0 && it[loc] === 0) {
    const other = LOCS.find(l => l !== loc && it[l] > 0);
    beep(false);
    showResult(id, null, other
      ? `Im ${LOC_NAME[loc]} ist laut App keins mehr, im ${LOC_NAME[other]} noch ${it[other]}.`
      : `Laut App ist nirgends mehr ${esc(it.name)} da.`, other);
    return;
  }
  store.bump(id, loc, d);
  it[loc] = Math.max(0, it[loc] + d);
  showResult(id, { loc, d });
}

// The card at the bottom of the scanner: what just happened, with +/- to correct.
function showResult(id, change, warning, other) {
  const it = byId(id); const card = $("#sc-card"); if (!it || !card) return;
  lastResult = { id, change };
  const loc = change?.loc || state.scanLoc;
  card.innerHTML = `
    <div class="head"><div style="min-width:0"><div class="name">${esc(it.name)}</div>
      <div class="hint">${LOC_NAME[loc]}${change ? ` · <span class="delta ${change.d < 0 ? "neg" : ""}">${change.d > 0 ? "+1 rein" : "−1 raus"}</span>` : ""}</div></div>
      <div class="big" aria-label="Jetzt im ${LOC_NAME[loc]}">${it[loc]}</div></div>
    ${warning ? `<div class="warnbox">${warning}</div>` : ""}
    <div class="btnrow">
      ${other ? `<button class="btn ghost small" id="sc-other">Aus ${LOC_NAME[other]} nehmen</button>`
              : `<div class="stepper" style="justify-self:start">${`<button type="button" data-d="-1" aria-label="Eins weniger" ${it[loc] ? "" : "disabled"}>−</button><button type="button" class="plus" data-d="1" aria-label="Eins mehr">+</button>`}</div>`}
      ${change ? `<button class="btn ghost small" id="sc-undo">Rückgängig</button>` : `<span></span>`}
    </div>`;
  card.querySelectorAll("[data-d]").forEach(b => b.onclick = () => {
    const d = Number(b.dataset.d), cur = byId(id);
    if (d < 0 && !cur[loc]) return;
    store.bump(id, loc, d); cur[loc] = Math.max(0, cur[loc] + d);
    showResult(id, change, null);
  });
  const undo = $("#sc-undo", card);
  if (undo) undo.onclick = () => {
    const cur = byId(id);
    store.bump(id, change.loc, -change.d); cur[change.loc] = Math.max(0, cur[change.loc] - change.d);
    scanner && scanner.forget();
    card.innerHTML = `<div class="hint">Rückgängig gemacht: ${esc(cur.name)} steht wieder bei ${cur[change.loc]}.</div>`;
  };
  const o = $("#sc-other", card);
  if (o) o.onclick = () => {
    const cur = byId(id);
    store.bump(id, other, -1); cur[other] = Math.max(0, cur[other] - 1);
    showResult(id, { loc: other, d: -1 });
  };
}

// ---------- login ----------
function renderLogin(error) {
  $("#app").innerHTML = `<form class="login" id="login">
    <h1>Vorratskammer</h1>
    <div class="hint">Meldet euch einmal mit eurem gemeinsamen Login an. Danach bleibt die App angemeldet.</div>
    <div class="field"><label for="em">E-Mail</label><input class="text" id="em" type="email" autocomplete="username" required></div>
    <div class="field"><label for="pw">Passwort</label><input class="text" id="pw" type="password" autocomplete="current-password" required></div>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <button class="btn primary" id="go">Anmelden</button>
  </form>`;
  $("#login").onsubmit = async e => {
    e.preventDefault();
    const go = $("#go"); go.disabled = true; go.innerHTML = `<span class="spinner"></span>`;
    try { await store.signIn($("#em").value.trim(), $("#pw").value); }
    catch (err) {
      const code = err?.code || "";
      renderLogin(code.includes("network") ? "Keine Verbindung. Für die erste Anmeldung braucht das Handy Internet."
        : "E-Mail oder Passwort stimmt nicht.");
    }
  };
}

// ---------- start ----------
let unsubItems = null;
function startMain() {
  renderShell(); renderStatus(); renderList();
  unsubItems = store.subscribe((items, meta) => {
    if (!items) {
      state.loadError = errText(meta.error, "Der Vorrat konnte nicht geladen werden.");
      renderList();
      return;
    }
    state.loadError = null;
    state.items = items; state.loaded = true; state.pending = !!meta.pending;
    renderStatus();
    // Don't redraw the list under a finger that is typing a number.
    if (!document.activeElement?.matches?.("#list input")) renderList();
  });
}

store.onAuth(user => {
  if (unsubItems) { unsubItems(); unsubItems = null; }
  if (user) startMain(); else renderLogin();
});

if ("serviceWorker" in navigator && !demo && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

document.body.insertAdjacentHTML("beforeend", `<div id="sheet"></div><div id="toast"></div>`);
