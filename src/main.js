import { FirebaseStore, LocalStore, LOCS, onWriteError } from "./store.js";
import { lookupProduct } from "./lookup.js";
import { Scanner, beep, unlockAudio } from "./scanner.js";
import { GROUPS, CATS, CAT, suggestCategory, suggestPack } from "./categories.js";

const LOC_NAME = { keller: "Keller", aussen: "Außenlager" };
const LOC_SHORT = { keller: "Keller", aussen: "Außen" };

const cfg = window.VK_CONFIG || {};
const demo = !cfg.firebase?.apiKey;
const store = demo ? new LocalStore() : new FirebaseStore(cfg.firebase);

const ui = loadUi();
const state = {
  items: [],
  boxes: [],     // Kisten
  boxItems: [],  // articles in Kisten: just a name and a number
  box: null,     // the Kiste opened in the Kisten tab
  loaded: false,
  pending: false,
  online: navigator.onLine,
  view: "alle",
  query: "",
  scanLoc: ui.scanLoc || "keller",
  scanDir: "in",
  collapsed: new Set(ui.collapsed || []),
  hideEmpty: ui.hideEmpty !== false,
  showFill: ui.showFill !== false,
};

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");
const words = s => norm(s).split(/[^a-z0-9]+/).filter(w => w.length > 1);
const total = it => it.keller + it.aussen;
const openedIn = (it, loc) => it.opened.filter(o => o.loc === loc);
// Whole units at a place (or everywhere): closed ones plus opened ones.
const units = (it, loc) => loc ? it[loc] + openedIn(it, loc).length : total(it) + it.opened.length;
const inStock = (it, loc) => units(it, loc) > 0;
const byId = id => state.items.find(it => it.id === id);
const byEan = ean => state.items.find(it => it.eans.includes(ean));
const isPieces = it => it.pack.mode === "pieces" && it.pack.size > 1;
const isFill = it => it.pack.mode === "fill";
const boxById = id => state.boxes.find(b => b.id === id);
const boxItemById = id => state.boxItems.find(it => it.id === id);
const itemsIn = boxId => state.boxItems.filter(it => it.box === boxId);
const byName = (a, b) => a.name.localeCompare(b.name, "de");

function loadUi() { try { return JSON.parse(localStorage.getItem("vk-ui") || "{}"); } catch { return {}; } }
function saveUi() {
  try { localStorage.setItem("vk-ui", JSON.stringify({ scanLoc: state.scanLoc, collapsed: [...state.collapsed], hideEmpty: state.hideEmpty, showFill: state.showFill })); } catch {}
}

// Items whose names share most words with `name`: used to stop duplicates.
function similar(name, exceptId, pool = state.items) {
  const a = new Set(words(name));
  if (!a.size) return [];
  return pool
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

// Opened bottles are never "voll": unopened ones are the full ones.
const FILL_STEPS = [0.25, 0.5, 0.75];
const FRAC = { 0.25: "¼", 0.5: "½", 0.75: "¾" };
function fillShort(v) { return v >= 1 ? "voll" : FRAC[v] || "¼"; }
// 3.5 -> "3½", 0.25 -> "¼"
function amount(x) {
  const q = Math.round(x * 4) / 4, w = Math.floor(q), f = FRAC[q - w] || "";
  return (w || !f ? String(w) : "") + f;
}
function packNoun(it, n) {
  if (isPieces(it)) return n === 1 ? "Packung" : "Packungen";
  if (isFill(it)) return n === 1 ? "Flasche" : "Flaschen";
  return "";
}
const unitNoun = (it, n) => packNoun(it, n) || "Stück";

// Small badges for the opened packs or bottles at a place, emptiest first.
// "davon 4× voll ¼ ½" for a place with opened ones; empty when all are closed.
function davonHtml(it, loc) {
  const pills = pillsHtml(it, loc);
  if (!pills) return "";
  const closed = it[loc] ? `<span class="pill full">${it[loc]}× ${isFill(it) ? "voll" : "zu"}</span>` : "";
  return `<span class="where">davon ${closed}${pills}</span>`;
}
// Same levels are grouped: "voll ×2".
function pillsHtml(it, loc) {
  const groups = new Map();
  for (const o of openedIn(it, loc).sort((a, b) => a.left - b.left)) {
    const t = isFill(it) ? fillShort(o.left) : `${o.left} St.`;
    groups.set(t, (groups.get(t) || 0) + 1);
  }
  return [...groups].map(([t, n]) => `<span class="pill">${t}${n > 1 ? ` ×${n}` : ""}</span>`).join("");
}
function whereHtml(it) {
  return LOCS.filter(l => inStock(it, l)).map(l =>
    `<span class="where ${l}"><i></i>${LOC_SHORT[l]} <b>${units(it, l)}</b>${state.showFill ? pillsHtml(it, l) : ""}</span>`).join("");
}
function bottleHtml(v) {
  return `<span class="bottle" aria-hidden="true"><span style="height:${Math.round(v * 100)}%"></span></span>`;
}
function fillSegHtml(i, v) {
  return `<div class="seg fillseg" data-i="${i}">${FILL_STEPS.map(f => `<button type="button" data-v="${f}" aria-pressed="${v === f}">${fillShort(f)}</button>`).join("")}<button type="button" data-v="0" class="leer">leer</button></div>`;
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

// ---------- stock changes (optimistic, then stored) ----------
function bump(it, loc, d) {
  if (d < 0 && it[loc] + d < 0) d = -it[loc];
  if (!d) return;
  store.bump(it.id, loc, d);
  it[loc] += d;
}
function setOpened(it, opened) {
  it.opened = opened;
  store.update(it.id, { opened, open: null });
}
// Change what is left in opened pack i; 0 means it is empty and gone.
function setLeft(it, i, left) {
  const next = it.opened.map(o => ({ ...o }));
  if (!next[i]) return;
  if (left > 0) next[i].left = left; else next.splice(i, 1);
  setOpened(it, next);
}
// Take a closed pack or bottle and open it.
function openPack(it, loc) {
  if (it[loc] <= 0) return false;
  bump(it, loc, -1);
  setOpened(it, [...it.opened, { loc, left: isPieces(it) ? it.pack.size : 0.75 }]);
  return true;
}
// One piece out: from the emptiest opened pack at that place, or open a new one.
function takePiece(it, loc) {
  let i = -1;
  it.opened.forEach((o, k) => { if (o.loc === loc && (i < 0 || o.left < it.opened[i].left)) i = k; });
  if (i < 0) {
    if (!openPack(it, loc)) return false;
    i = it.opened.length - 1;
  }
  setLeft(it, i, it.opened[i].left - 1);
  return true;
}
function bumpBoxItem(it, d) {
  if (d < 0 && it.n + d < 0) d = -it.n;
  if (!d) return;
  store.count(it.id, d);
  it.n += d;
}
const snapshot = it => ({ keller: it.keller, aussen: it.aussen, opened: it.opened.map(o => ({ ...o })) });
function restore(it, snap) {
  for (const l of LOCS) bump(it, l, snap[l] - it[l]);
  setOpened(it, snap.opened.map(o => ({ ...o })));
}

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

function catSelectHtml(id, selected) {
  const opt = c => `<option value="${c.id}" ${c.id === selected ? "selected" : ""}>${esc(c.name)}</option>`;
  return `<select class="text select" id="${id}">
      <option value="" ${selected ? "" : "selected"}>Ohne Rubrik</option>
      ${GROUPS.map(g => `<optgroup label="${g.name}">${CATS.filter(c => c.g === g.id).map(opt).join("")}</optgroup>`).join("")}
    </select>`;
}

function packFieldHtml(prefix, pack) {
  return `<div class="field"><span class="label">Wie wird gezählt?</span>
    <div class="seg" id="${prefix}-mode">
      <button type="button" data-m="count" aria-pressed="${pack.mode === "count"}">Stück</button>
      <button type="button" data-m="pieces" aria-pressed="${pack.mode === "pieces"}">Packung mit Inhalt</button>
      <button type="button" data-m="fill" aria-pressed="${pack.mode === "fill"}">Füllstand</button>
    </div>
    <div class="packsize" id="${prefix}-sizewrap" ${pack.mode === "pieces" ? "" : "hidden"}>
      <label for="${prefix}-size">Stück pro Packung</label>
      <input class="text small" id="${prefix}-size" inputmode="numeric" pattern="[0-9]*" value="${pack.size || ""}" placeholder="z. B. 8">
    </div>
    <div class="hint" id="${prefix}-modehint">${packHint(pack.mode)}</div>
  </div>`;
}
function packHint(mode) {
  return {
    count: "Jedes Teil zählt einzeln, z. B. Dosen oder Wasserflaschen.",
    pieces: "Eine Packung enthält mehrere Stück, z. B. Riegel. Beim Rausnehmen zählst du einzelne Stück.",
    fill: "Für Flaschen, aus denen man nach und nach etwas nimmt. Angebrochene bekommen einen Füllstand.",
  }[mode];
}
function wirePackField(root, prefix, pack, onChange) {
  $(`#${prefix}-mode`, root).addEventListener("click", e => {
    const b = e.target.closest("[data-m]"); if (!b) return;
    pack.mode = b.dataset.m;
    root.querySelectorAll(`#${prefix}-mode [data-m]`).forEach(x => x.setAttribute("aria-pressed", x === b));
    $(`#${prefix}-sizewrap`, root).hidden = pack.mode !== "pieces";
    $(`#${prefix}-modehint`, root).textContent = packHint(pack.mode);
    if (pack.mode === "pieces") $(`#${prefix}-size`, root).focus();
    onChange && onChange();
  });
  $(`#${prefix}-size`, root).addEventListener("change", e => {
    pack.size = Math.max(0, Math.min(999, parseInt(e.target.value) || 0));
    onChange && onChange();
  });
}

// New item: from the + button, an empty search, or an unknown barcode.
function newItemSheet({ name = "", ean = null, loc = state.scanLoc, n = 1, lookingUp = false, onDone } = {}) {
  const counts = { keller: 0, aussen: 0 }; counts[loc] = n;
  const pack = { size: 0, ...suggestPack(name) };
  let hit = null, catTouched = false;
  const s = openSheet(`
    <h2>${ean ? "Neuer Artikel" : "Artikel anlegen"}</h2>
    ${ean ? `<div class="hint" id="ni-hint">${lookingUp ? `<span class="spinner"></span>&nbsp; Suche Produktnamen …` : "Diesen Barcode kennt eure Vorratskammer noch nicht."}</div>` : ""}
    <div class="field"><label for="ni-name">Name</label>
      <input class="text" id="ni-name" value="${esc(name)}" placeholder="z. B. Passierte Tomaten 500 g" autocomplete="off" enterkeyhint="done"></div>
    <div class="suggest" id="ni-sim"></div>
    <div class="field"><label for="ni-cat">Rubrik <span class="tag" id="ni-cattag" hidden>Vorschlag</span></label>${catSelectHtml("ni-cat", null)}</div>
    <div class="field"><span class="label">Wie viele?</span>
      ${LOCS.map(l => `<div class="locline"><span class="locname"><i style="background:var(--${l})"></i>${LOC_NAME[l]}</span>${stepperHtml("ni-" + l, counts[l])}</div>`).join("")}
    </div>
    <details class="more"><summary>Packung mit Inhalt oder Füllstand?</summary>${packFieldHtml("ni", pack)}</details>
    ${ean ? `<div class="hint">Barcode ${esc(ean)} wird gemerkt. Beim nächsten Scan wird der Artikel sofort erkannt.</div>` : ""}
    <div class="btnrow"><button class="btn ghost" id="ni-cancel">Abbrechen</button><button class="btn primary" id="ni-save">Speichern</button></div>
    ${ean ? `<div class="autosave" id="ni-auto" hidden></div>` : ""}
  `, () => onDone && onDone(null));

  const nameEl = $("#ni-name", s), catEl = $("#ni-cat", s);
  const suggest = () => {
    if (catTouched) return;
    const c = nameEl.value.trim() ? suggestCategory(nameEl.value, hit || {}, state.items) : null;
    catEl.value = c || "";
    $("#ni-cattag", s).hidden = !c;
  };
  catEl.addEventListener("change", () => { catTouched = true; $("#ni-cattag", s).hidden = true; });
  const showSimilar = () => {
    const sim = similar(nameEl.value);
    $("#ni-sim", s).innerHTML = sim.length ? `<span class="label">Schon vorhanden?</span>` + sim.map(it =>
      `<button type="button" data-id="${it.id}"><span>${esc(it.name)}</span><span>${ean ? "Das ist es" : "Öffnen"}</span></button>`).join("") : "";
  };
  nameEl.addEventListener("input", () => { showSimilar(); suggest(); });
  showSimilar(); suggest();
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
  wireSteppers(s, (key, v) => { counts[key.slice(3)] = v; return v; }, key => counts[key.slice(3)]);
  wirePackField(s, "ni", pack);
  $("#ni-cancel", s).onclick = closeSheet;

  // From a scan: save on its own after a few seconds unless someone touches the form.
  let autoTimer = null, autoLeft = 0;
  const stopAuto = () => { clearInterval(autoTimer); autoTimer = null; const a = $("#ni-auto", s); if (a) a.hidden = true; };
  const startAuto = () => {
    if (!ean || !nameEl.value.trim()) return;
    stopAuto(); autoLeft = 30;
    const a = $("#ni-auto", s);
    const tick = () => {
      if (!s.isConnected) return stopAuto();
      if (autoLeft <= 0) { stopAuto(); save(); return; }
      a.hidden = false;
      a.textContent = `Wird in ${autoLeft} s automatisch gespeichert. Antippen zum Ändern.`;
      autoLeft--;
    };
    tick(); autoTimer = setInterval(tick, 1000);
  };
  for (const ev of ["pointerdown", "keydown", "input"]) s.addEventListener(ev, e => { if (e.isTrusted && ev !== "keydown") stopAuto(); });
  nameEl.addEventListener("keydown", stopAuto);

  const save = async () => {
    const nm = nameEl.value.trim();
    if (!nm) { nameEl.focus(); nameEl.placeholder = "Bitte einen Namen eintragen"; return false; }
    stopAuto();
    const id = await store.add({
      name: nm, eans: ean ? [ean] : [], keller: counts.keller, aussen: counts.aussen, home: loc,
      cat: catEl.value || null, pack: { mode: pack.mode, size: pack.mode === "pieces" ? pack.size : 0 },
    });
    const done = onDone; onDone = null;
    closeSheet();
    toast(`${nm} angelegt`);
    done && done(id, false, quiet);
    return true;
  };
  let quiet = false;
  $("#ni-save", s).onclick = () => save();
  if (!ean) setTimeout(() => nameEl.focus(), 60);
  return {
    setProduct(h) {
      hit = h;
      const hint = $("#ni-hint", s);
      if (hint) hint.textContent = h ? "Name aus der Produktdatenbank, bitte kurz prüfen." : "Nicht in der Produktdatenbank. Bitte Namen eintippen.";
      if (h && !nameEl.value) {
        nameEl.value = h.name; showSimilar();
        Object.assign(pack, suggestPack(h.name));
      }
      suggest();
      if (!h) nameEl.focus(); else startAuto();
    },
    ean,
    // Same barcode scanned again: one more.
    addOne() {
      const st = $(`.stepper[data-key="ni-${loc}"] .plus`, s);
      if (st) st.click();
      if (autoTimer) startAuto();
    },
    // Another barcode scanned: this one is fine as it is.
    saveQuiet() { quiet = true; return save(); },
  };
}

// Steppers inside a sheet. get(key) -> n, set(key, n) applies the change.
function wireSteppers(root, set, get) {
  const paint = (st, n) => {
    const inp = st.querySelector("input");
    inp.value = n; inp.classList.toggle("zero", !n);
    st.querySelector("[data-d='-1']").disabled = !n;
  };
  root.querySelectorAll(".stepper[data-key]").forEach(st => {
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

// What is there, everywhere or at one place.
function summaryText(it, loc) {
  const n = units(it, loc);
  const opened = loc ? openedIn(it, loc) : it.opened;
  const closed = loc ? it[loc] : total(it);
  if (!n) return loc ? `Im ${LOC_NAME[loc]} gerade nichts da.` : "Gerade nichts da.";
  const pre = loc ? `Im ${LOC_NAME[loc]}: ` : "";
  if (isFill(it)) {
    const sum = closed + opened.reduce((a, o) => a + o.left, 0);
    return pre + (opened.length ? `${n} ${unitNoun(it, n)}, zusammen etwa ${amount(sum)} volle` : `${n} volle ${unitNoun(it, n)}`);
  }
  if (isPieces(it)) {
    const pcs = closed * it.pack.size + opened.reduce((a, o) => a + o.left, 0);
    return pre + `${pcs} Stück in ${n} ${unitNoun(it, n)}`;
  }
  return pre + `${n} Stück`;
}

// Details of one item: stock per place with every opened bottle or pack, then settings.
// With `focus` (opened from a place's tab) that place comes first and the other
// place is only a small hint that can be tapped to switch over.
function itemSheet(id, keepScroll, focus = null) {
  const it = byId(id); if (!it) return;
  const prev = $("#sheet .sheet");
  const prevScroll = keepScroll ? prev?.scrollTop : 0;
  const moreOpen = keepScroll && !!$("details.more", prev || document)?.open;
  const canOpen = isFill(it) || isPieces(it);
  const closedLabel = isFill(it) ? "davon voll" : isPieces(it) ? "davon geschlossen" : "Anzahl";
  const locCard = l => {
    const rows = it.opened.map((o, i) => o.loc !== l ? "" : isFill(it)
      ? `<div class="orow">${bottleHtml(o.left)}${fillSegHtml(i, o.left)}</div>`
      : `<div class="orow"><span class="olabel">Angebrochen, noch Stück</span>${stepperHtml("op-" + i, o.left)}</div>`).join("");
    return `<section class="loccard">
      <div class="lochead"><span class="locname"><i style="background:var(--${l})"></i>${LOC_NAME[l]}</span>${canOpen ? `<span class="locbig">${units(it, l)}<small>${unitNoun(it, units(it, l))}</small></span>` : ""}</div>
      <div class="locline"><span>${closedLabel}</span>${stepperHtml("it-" + l, it[l])}</div>
      ${rows ? `<div class="olist"><span class="olabel">davon angebrochen</span>${rows}</div>` : ""}
      ${canOpen && it[l] > 0 ? `<button type="button" class="linkbtn" data-open="${l}">${isFill(it) ? "Eine Flasche anbrechen" : "Eine Packung anbrechen"}</button>` : ""}
    </section>`;
  };
  const otherHint = l => {
    const n = units(it, l);
    return `<button type="button" class="otherloc ${n ? "" : "no"}" data-goto="${l}">
      <i style="background:var(--${l})"></i><span>${LOC_NAME[l]} im Bestand: <b>${n ? "Ja" : "Nein"}</b>${n ? `, ${n} ${unitNoun(it, n)}` : ""}</span><span class="chev" aria-hidden="true">›</span></button>`;
  };
  const s = openSheet(`
    <div><h2 id="it-title">${esc(it.name)}</h2><div class="hint sumline">${esc(summaryText(it, focus))}</div></div>
    ${focus ? locCard(focus) + LOCS.filter(l => l !== focus).map(otherHint).join("") : LOCS.map(locCard).join("")}
    <details class="more" ${moreOpen ? "open" : ""}><summary>Name, Rubrik und Zählweise ändern</summary>
      <div class="morebody">
        <div class="field"><label for="it-name">Name</label><input class="text" id="it-name" value="${esc(it.name)}" autocomplete="off" enterkeyhint="done"></div>
        <div class="field"><label for="it-cat">Rubrik</label>${catSelectHtml("it-cat", it.cat)}</div>
        ${packFieldHtml("it", { ...it.pack })}
        <div class="field"><span class="label">Barcodes</span>
          <div class="chips">${it.eans.length ? it.eans.map(e => `<span class="chip">${esc(e)}</span>`).join("") : `<span class="hint">Noch keiner. Scanne den Artikel und wähle ihn bei „Schon vorhanden?“ aus.</span>`}</div></div>
        <button class="linkbtn danger" id="it-del">Artikel löschen</button>
      </div>
    </details>
    <button class="btn primary" id="it-done">Fertig</button>
  `);
  if (prevScroll) s.scrollTop = prevScroll;
  const nameEl = $("#it-name", s);
  const saveName = () => {
    const v = nameEl.value.trim(), cur = byId(id);
    if (v && cur && v !== cur.name) { store.update(id, { name: v }); cur.name = v; $("#it-title", s).textContent = v; renderList(); }
  };
  nameEl.addEventListener("change", saveName);
  const redraw = () => { saveName(); itemSheet(id, true, focus); renderList(); };

  wireSteppers(s, (key, n) => {
    const cur = byId(id); if (!cur) return n;
    if (key.startsWith("op-")) setLeft(cur, Number(key.slice(3)), Math.min(n, cur.pack.size || n));
    else bump(cur, key.slice(3), n - cur[key.slice(3)]);
    redraw();
    return n;
  }, key => {
    const cur = byId(id); if (!cur) return 0;
    return key.startsWith("op-") ? cur.opened[Number(key.slice(3))]?.left ?? 0 : cur[key.slice(3)];
  });
  s.addEventListener("click", e => {
    const go = e.target.closest("[data-goto]");
    if (go) {
      // switch the list behind to that place too
      saveName();
      state.view = state.scanLoc = go.dataset.goto; saveUi(); renderList();
      itemSheet(id, false, go.dataset.goto);
      return;
    }
    const ob = e.target.closest("[data-open]");
    if (ob) { openPack(byId(id), ob.dataset.open); redraw(); return; }
    const fb = e.target.closest(".fillseg [data-v]");
    if (fb) { setLeft(byId(id), Number(fb.closest(".fillseg").dataset.i), Number(fb.dataset.v)); redraw(); }
  });

  $("#it-cat", s).addEventListener("change", e => { const cur = byId(id); cur.cat = e.target.value || null; store.update(id, { cat: cur.cat }); renderList(); });
  const pack = { ...it.pack };
  wirePackField(s, "it", pack, () => {
    const cur = byId(id);
    const next = { mode: pack.mode, size: pack.mode === "pieces" ? pack.size : 0 };
    const changedKind = next.mode !== cur.pack.mode;
    cur.pack = next;
    store.update(id, { pack: next });
    if (changedKind && cur.opened.length) {
      // Opened ones count as whole ones again, so nothing gets lost.
      for (const l of LOCS) bump(cur, l, openedIn(cur, l).length);
      setOpened(cur, []);
    }
    if (changedKind || next.mode === "pieces") redraw();
  });

  $("#it-done", s).onclick = () => { saveName(); closeSheet(); };
  $("#it-del", s).onclick = () => {
    const cur = byId(id);
    const c = openSheet(`<h2>${esc(cur.name)} löschen?</h2><div class="hint">Der Artikel verschwindet auf beiden Handys, aus Keller und Außenlager.</div>
      <div class="btnrow"><button class="btn ghost" id="d-no">Behalten</button><button class="btn danger" id="d-yes">Löschen</button></div>`);
    $("#d-no", c).onclick = () => itemSheet(id, false, focus);
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
          <button data-view="aussen">Außen<span class="long">lager</span><span class="n" id="n-aussen"></span></button>
          <button data-view="kisten">Kisten<span class="n" id="n-kisten"></span></button>
        </div>
        <div class="viewopts">
          <button class="toggle" id="fill"><span class="sw" aria-hidden="true"></span>Füllstandsanzeige</button>
          <button class="toggle" id="hide"><span class="sw" aria-hidden="true"></span>Leere ausblenden</button></div>
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
    state.box = null;
    if (LOCS.includes(state.view)) { state.scanLoc = state.view; saveUi(); }
    renderList(); window.scrollTo({ top: 0 });
  });
  $("#add").onclick = () => addHere(state.query);
  $("#scan").onclick = () => { unlockAudio(); openScanner(); };
  $("#status").onclick = statusSheet;
  $("#hide").onclick = () => { state.hideEmpty = !state.hideEmpty; saveUi(); renderList(); };
  $("#fill").onclick = () => { state.showFill = !state.showFill; saveUi(); renderList(); };

  const list = $("#list");
  list.addEventListener("click", e => {
    const head = e.target.closest("[data-cat]");
    if (head) {
      const c = head.dataset.cat;
      state.collapsed.has(c) ? state.collapsed.delete(c) : state.collapsed.add(c);
      saveUi(); renderList();
      return;
    }
    if (e.target.closest("[data-back]")) { state.box = null; renderList(); window.scrollTo({ top: 0 }); return; }
    if (e.target.closest("[data-boxedit]")) { boxSheet(state.box); return; }
    const boxRow = e.target.closest("[data-box]");
    if (boxRow) { openBox(boxRow.dataset.box); return; }
    const ph = e.target.closest("[data-photo]");
    if (ph) { const it = boxItemById(ph.dataset.photo); if (it?.photo) showPhoto(it.photo, it.name); return; }
    const brow = e.target.closest("[data-bid]");
    if (brow) {
      const it = boxItemById(brow.dataset.bid); if (!it) return;
      const b = e.target.closest("[data-d]");
      if (b) { bumpBoxItem(it, Number(b.dataset.d)); renderList(); return; }
      if (!e.target.closest(".txt")) return;
      if (state.view === "kisten" && state.box) boxItemSheet(it.id);
      else openBox(it.box);
      return;
    }
    const row = e.target.closest("[data-id]"); if (!row) return;
    const id = row.dataset.id;
    const b = e.target.closest("[data-d]");
    if (b) {
      const it = byId(id), d = Number(b.dataset.d);
      bump(it, state.view, d); renderList();
      return;
    }
    if (e.target.closest(".txt")) itemSheet(id, false, state.view === "alle" ? null : state.view);
  });
  list.addEventListener("focusin", e => { if (e.target.matches(".stepper input")) e.target.select(); });
  list.addEventListener("change", e => {
    if (!e.target.matches(".stepper input")) return;
    const n0 = Math.max(0, Math.min(999, parseInt(e.target.value) || 0));
    const brow = e.target.closest("[data-bid]");
    if (brow) { const it = boxItemById(brow.dataset.bid); if (it) bumpBoxItem(it, n0 - it.n); renderList(); return; }
    const id = e.target.closest("[data-id]").dataset.id;
    const n = Math.max(0, Math.min(999, parseInt(e.target.value) || 0));
    const it = byId(id);
    bump(it, state.view, n - units(it, state.view)); renderList();
  });
  $("#empty").addEventListener("click", e => {
    if (e.target.closest("#add-q")) addHere(state.query);
    if (e.target.closest("#add-box")) newBoxSheet();
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

// Items for the current tab and search. `hidden` counts the empty ones left out.
function visibleItems() {
  const q = norm(state.query).trim();
  const loc = state.view === "alle" ? null : state.view;
  let list = state.items, hidden = 0;
  // A place shows what is there now, plus what used to be there (so you can count it back up).
  if (loc) list = list.filter(it => inStock(it, loc) || it.locs.includes(loc));
  if (q) {
    const qs = q.split(/\s+/);
    list = list.filter(it => { const n = norm(it.name); return qs.every(w => n.includes(w)) || it.eans.includes(q); });
  } else if (state.hideEmpty) {
    const before = list.length;
    list = list.filter(it => inStock(it, loc));
    hidden = before - list.length;
  }
  const key = it => inStock(it, loc) ? 0 : 1;
  return { list: [...list].sort((a, b) => key(a) - key(b) || a.name.localeCompare(b.name, "de")), hidden };
}

function rowHtml(it) {
  const loc = state.view === "alle" ? null : state.view;
  const cls = inStock(it, loc) ? "item" : "item none";
  if (!loc) {
    const n = units(it), where = whereHtml(it);
    return `<li class="${cls}" data-id="${it.id}">
      <button class="txt"><span class="name">${esc(it.name)}</span>${where ? `<span class="sub">${where}</span>` : ""}</button>
      <div class="total ${n ? "" : "out"}">${n || "leer"}</div></li>`;
  }
  // The number is all units here; + and − change the full / closed ones.
  const davon = state.showFill ? davonHtml(it, loc) : "";
  return `<li class="${cls}" data-id="${it.id}">
    <button class="txt"><span class="name">${esc(it.name)}</span>${davon ? `<span class="sub">${davon}</span>` : ""}</button>
    ${stepperHtml("", units(it, loc))}</li>`;
}

function renderList() {
  document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", b.dataset.view === state.view));
  const boxHave = state.boxItems.filter(it => it.n > 0).length;
  $("#n-alle").textContent = (state.items.filter(it => inStock(it)).length + boxHave) || "";
  for (const l of LOCS) $("#n-" + l).textContent = state.items.filter(it => inStock(it, l)).length || "";
  $("#n-kisten").textContent = boxHave || "";
  $("#qclear").hidden = !state.query;
  $("#hide").setAttribute("aria-pressed", state.hideEmpty);
  $("#fill").setAttribute("aria-pressed", state.showFill);
  $("#fill").hidden = state.view === "kisten";
  $("#add").textContent = state.view === "kisten" && !state.box ? "＋ Kiste" : "＋ Neu";
  if (state.view === "kisten") return renderKisten();

  const { list, hidden } = visibleItems();
  // Group by Rubrik: Ohne Rubrik first (so it gets sorted), then Food, then Non-Food.
  const byCat = new Map();
  for (const it of list) {
    const c = it.cat && CAT[it.cat] ? it.cat : "";
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(it);
  }
  const searching = !!state.query.trim();
  const section = (key, title) => {
    const rows = byCat.get(key); if (!rows) return "";
    const closed = !searching && state.collapsed.has(key || "none");
    const have = rows.filter(it => inStock(it, state.view === "alle" ? null : state.view)).length;
    return `<li class="cathead"><button data-cat="${key || "none"}" aria-expanded="${!closed}">
        <span>${esc(title)}</span><span class="cnt">${have || ""}</span><span class="chev" aria-hidden="true">›</span></button></li>
      ${closed ? "" : rows.map(rowHtml).join("")}`;
  };
  let html = section("", "Ohne Rubrik");
  for (const g of GROUPS) {
    const cats = CATS.filter(c => c.g === g.id && byCat.has(c.id));
    if (!cats.length) continue;
    html += `<li class="grouphead">${g.name}</li>` + cats.map(c => section(c.id, c.name)).join("");
  }
  // "Alle" also shows what is in the Kisten, so a search finds it there too.
  const inBoxes = state.view === "alle" ? visibleBoxItems(state.boxItems) : [];
  if (inBoxes.length) {
    const closed = !searching && state.collapsed.has("kisten");
    html += `<li class="grouphead">Kisten</li><li class="cathead"><button data-cat="kisten" aria-expanded="${!closed}">
        <span>In Kisten</span><span class="cnt">${inBoxes.filter(it => it.n > 0).length || ""}</span><span class="chev" aria-hidden="true">›</span></button></li>
      ${closed ? "" : inBoxes.map(it => boxItemRowHtml(it, true)).join("")}`;
  }
  $("#list").innerHTML = html;
  const shown = list.length + inBoxes.length;

  let empty = "";
  if (state.loadError) empty = `<div class="empty"><strong>Da stimmt etwas nicht.</strong><span>${esc(state.loadError)}</span></div>`;
  else if (!state.loaded) empty = `<div class="empty"><span class="spinner"></span><span>Lade euren Vorrat …</span></div>`;
  else if (!shown && state.query) {
    empty = `<div class="empty"><strong>„${esc(state.query)}“ haben wir ${state.view === "alle" ? "nicht" : "nicht im " + LOC_NAME[state.view]}.</strong>
      <span>Also ab auf die Einkaufsliste. Oder doch da? Dann leg es an.</span>
      <button class="btn ghost small" id="add-q">„${esc(state.query)}“ anlegen</button></div>`;
  } else if (!shown && hidden) {
    empty = `<div class="empty"><strong>${state.view === "alle" ? "Gerade ist nichts da." : "Im " + LOC_NAME[state.view] + " ist gerade nichts."}</strong><span>Leere Artikel sind ausgeblendet.</span></div>`;
  } else if (!shown) {
    empty = `<div class="empty"><strong>${state.view === "alle" ? "Noch nichts erfasst." : "Im " + LOC_NAME[state.view] + " ist noch nichts erfasst."}</strong>
      <span>Tippe auf „Scannen“ und halte die Kamera auf einen Barcode. Oder lege einen Artikel mit „Neu“ von Hand an.</span></div>`;
  }
  $("#empty").innerHTML = empty;
}

// ---------- Kisten ----------
// Kisten are boxes you name yourself. What is in them is just counted, no packs or fill levels.
function addHere(name = "") {
  if (state.view === "kisten") return state.box ? newBoxItemSheet({ name, box: state.box }) : newBoxSheet();
  newItemSheet({ name, loc: state.view !== "alle" ? state.view : state.scanLoc });
}
function openBox(id) {
  if (!boxById(id)) return;
  state.view = "kisten"; state.box = id; state.query = "";
  const q = $("#q"); if (q) q.value = "";
  renderList(); window.scrollTo({ top: 0 });
}

// Search and "Leere ausblenden" for articles in Kisten. A search also matches the Kiste's name.
function visibleBoxItems(pool) {
  const q = norm(state.query).trim();
  let list = pool;
  if (q) {
    const qs = q.split(/\s+/);
    list = list.filter(it => { const n = norm(it.name + " " + (boxById(it.box)?.name || "")); return qs.every(w => n.includes(w)); });
  } else if (state.hideEmpty) list = list.filter(it => it.n > 0);
  return [...list].sort((a, b) => (b.n > 0) - (a.n > 0) || byName(a, b));
}

// `overview`: shown outside its Kiste, so with the Kiste's name and without + and −.
function thumbHtml(it) {
  return it.photo ? `<button type="button" class="thumb" data-photo="${it.id}" aria-label="Foto ansehen"><img src="${it.photo}" alt=""></button>` : "";
}
function boxItemRowHtml(it, overview) {
  const cls = (it.n > 0 ? "item" : "item none") + (it.photo ? " withphoto" : "");
  if (overview) {
    const b = boxById(it.box);
    return `<li class="${cls}" data-bid="${it.id}">${thumbHtml(it)}
      <button class="txt"><span class="name">${esc(it.name)}</span><span class="sub"><span class="where kiste"><i></i>Kiste ${esc(b?.name || "?")}</span></span></button>
      <div class="total ${it.n ? "" : "out"}">${it.n || "leer"}</div></li>`;
  }
  return `<li class="${cls}" data-bid="${it.id}">${thumbHtml(it)}
    <button class="txt"><span class="name">${esc(it.name)}</span></button>
    ${stepperHtml("", it.n)}</li>`;
}

function renderKisten() {
  if (state.box && !boxById(state.box)) state.box = null;
  const box = state.box && boxById(state.box);
  const searching = !!state.query.trim();
  let html = "", empty = "";
  if (searching) {
    // Search across all Kisten.
    const rows = visibleBoxItems(state.boxItems);
    html = rows.map(it => boxItemRowHtml(it, true)).join("");
    if (!rows.length) empty = `<div class="empty"><strong>„${esc(state.query)}“ ist in keiner Kiste.</strong>
      ${box ? `<button class="btn ghost small" id="add-q">„${esc(state.query)}“ in ${esc(box.name)} anlegen</button>` : ""}</div>`;
  } else if (box) {
    const all = itemsIn(box.id), rows = visibleBoxItems(all);
    html = `<li class="boxhead"><button class="back" data-back>‹ Alle Kisten</button>
        <div class="boxtitle"><h2>${esc(box.name)}</h2><button class="linkbtn" data-boxedit>Umbenennen</button></div></li>`
      + rows.map(it => boxItemRowHtml(it, false)).join("");
    if (!all.length) empty = `<div class="empty"><strong>Die Kiste ist noch leer.</strong><span>Tippe auf „Neu“, um einzutragen, was drin ist.</span></div>`;
    else if (!rows.length) empty = `<div class="empty"><strong>In dieser Kiste ist gerade nichts.</strong><span>Leere Artikel sind ausgeblendet.</span></div>`;
  } else {
    html = [...state.boxes].sort(byName).map(b => {
      const its = itemsIn(b.id), have = its.filter(it => it.n > 0).length;
      return `<li class="item boxrow" data-box="${b.id}">
        <button class="txt"><span class="name">${esc(b.name)}</span>
          <span class="sub">${its.length ? `${have} von ${its.length} Artikeln da` : "noch leer"}</span></button>
        <span class="chev" aria-hidden="true">›</span></li>`;
    }).join("");
    if (!state.loaded) empty = `<div class="empty"><span class="spinner"></span><span>Lade euren Vorrat …</span></div>`;
    else if (!state.boxes.length) empty = `<div class="empty"><strong>Noch keine Kisten.</strong>
      <span>Leg eine Kiste an, z. B. „Weihnachtsdeko“ oder „Werkzeug“, und trag dann ein, was drin ist.</span>
      <button class="btn ghost small" id="add-box">＋ Kiste anlegen</button></div>`;
  }
  $("#list").innerHTML = html;
  $("#empty").innerHTML = empty;
}

function newBoxSheet() {
  const s = openSheet(`<h2>Neue Kiste</h2>
    <div class="field"><label for="nb-name">Name der Kiste</label>
      <input class="text" id="nb-name" placeholder="z. B. Weihnachtsdeko" autocomplete="off" enterkeyhint="done"></div>
    <div class="btnrow"><button class="btn ghost" id="nb-cancel">Abbrechen</button><button class="btn primary" id="nb-save">Anlegen</button></div>`);
  const nameEl = $("#nb-name", s);
  const save = () => {
    const nm = nameEl.value.trim();
    if (!nm) { nameEl.focus(); nameEl.placeholder = "Bitte einen Namen eintragen"; return; }
    const id = store.put({ kind: "box", name: nm });
    // show it right away, before the database answers
    if (!boxById(id)) state.boxes.push({ id, kind: "box", name: nm, box: null, n: 0, eans: [] });
    closeSheet();
    toast(`Kiste ${nm} angelegt`);
    openBox(id);
  };
  $("#nb-cancel", s).onclick = closeSheet;
  $("#nb-save", s).onclick = save;
  nameEl.addEventListener("keydown", e => { if (e.key === "Enter") save(); });
  setTimeout(() => nameEl.focus(), 60);
}

// Rename or delete a Kiste.
function boxSheet(id) {
  const b = boxById(id); if (!b) return;
  const n = itemsIn(id).length;
  const s = openSheet(`<h2>Kiste ${esc(b.name)}</h2>
    <div class="field"><label for="bx-name">Name der Kiste</label>
      <input class="text" id="bx-name" value="${esc(b.name)}" autocomplete="off" enterkeyhint="done"></div>
    <button class="btn primary" id="bx-done">Fertig</button>
    <button class="linkbtn danger" id="bx-del">Kiste löschen</button>`);
  const nameEl = $("#bx-name", s);
  const saveName = () => {
    const v = nameEl.value.trim(), cur = boxById(id);
    if (v && cur && v !== cur.name) { store.update(id, { name: v }); cur.name = v; renderList(); }
  };
  nameEl.addEventListener("keydown", e => { if (e.key === "Enter") { saveName(); closeSheet(); } });
  $("#bx-done", s).onclick = () => { saveName(); closeSheet(); };
  $("#bx-del", s).onclick = () => {
    const c = openSheet(`<h2>Kiste ${esc(b.name)} löschen?</h2>
      <div class="hint">${n ? `Die ${n === 1 ? "ein Artikel" : n + " Artikel"} darin ${n === 1 ? "wird" : "werden"} mitgelöscht, auf beiden Handys.` : "Die Kiste ist leer."}</div>
      <div class="btnrow"><button class="btn ghost" id="d-no">Behalten</button><button class="btn danger" id="d-yes">Löschen</button></div>`);
    $("#d-no", c).onclick = () => boxSheet(id);
    $("#d-yes", c).onclick = () => {
      for (const it of itemsIn(id)) store.remove(it.id);
      store.remove(id);
      state.boxItems = state.boxItems.filter(it => it.box !== id);
      state.boxes = state.boxes.filter(x => x.id !== id);
      state.box = null;
      closeSheet(); renderList();
      toast(`Kiste ${b.name} gelöscht`);
    };
  };
}

function boxSelectHtml(id, selected) {
  return `<select class="text select" id="${id}">${[...state.boxes].sort(byName).map(b =>
    `<option value="${b.id}" ${b.id === selected ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select>`;
}

// ---------- photos ----------
// A photo is shrunk to a small JPEG (about 30 to 80 KB) and kept right in the article,
// so it syncs to both phones without any extra setup.
const PHOTO_MAX = 800;
async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
    let side = PHOTO_MAX, q = 0.7, out = "";
    for (let tries = 0; tries < 4; tries++) {
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      out = c.toDataURL("image/jpeg", q);
      if (out.length < 250000) break;
      side *= 0.75; q -= 0.1;
    }
    return out;
  } finally { URL.revokeObjectURL(url); }
}

// Photo picker inside a sheet. On the iPhone the file field offers "Foto aufnehmen" and the library.
// `big`: the item's own sheet, with a larger picture.
function photoField(host, get, set, title, big = false) {
  const paint = () => {
    const p = get();
    host.innerHTML = p
      ? `<div class="photofield ${big ? "big" : ""}"><button type="button" class="photo" data-act="view" aria-label="Foto vergrößern"><img src="${p}" alt=""></button>
          <div class="photoacts"><label class="linkbtn">Anderes Foto<input type="file" accept="image/*" hidden></label>
          <button type="button" class="linkbtn danger" data-act="del">Foto entfernen</button></div></div>`
      : `<label class="btn ghost small photoadd"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>
          Foto machen oder auswählen<input type="file" accept="image/*" hidden></label>`;
  };
  host.addEventListener("change", async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    host.innerHTML = `<div class="hint"><span class="spinner"></span>&nbsp; Foto wird vorbereitet …</div>`;
    try { set(await shrinkPhoto(f)); }
    catch (err) { console.error(err); toast("Das Foto ließ sich nicht öffnen. Bitte ein anderes versuchen."); }
    paint();
  });
  host.addEventListener("click", e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    if (b.dataset.act === "view") showPhoto(get(), title());
    if (b.dataset.act === "del") { set(null); paint(); }
  });
  paint();
}

// Full-screen photo. Tap to zoom in, drag to look around, ✕ or tap again to zoom out.
function showPhoto(src, name) {
  if (!src) return;
  const host = $("#lightbox");
  host.innerHTML = `<div class="lightbox" role="dialog" aria-label="Foto">
    <div class="lbtop"><span>${esc(name || "")}</span><button type="button" class="close" aria-label="Schließen">✕</button></div>
    <div class="lbimg"><img src="${src}" alt="${esc(name || "Foto")}"></div>
    <div class="lbhint">Antippen zum Vergrößern</div></div>`;
  const box = $(".lbimg", host), img = $("img", box);
  $(".close", host).onclick = () => (host.innerHTML = "");
  img.onclick = e => {
    const zoomed = box.classList.toggle("zoom");
    $(".lbhint", host).textContent = zoomed ? "Ziehen zum Verschieben, antippen zum Verkleinern" : "Antippen zum Vergrößern";
    if (zoomed) {
      // keep the tapped spot under the finger
      const r = img.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      requestAnimationFrame(() => {
        box.scrollLeft = fx * box.scrollWidth - box.clientWidth / 2;
        box.scrollTop = fy * box.scrollHeight - box.clientHeight / 2;
      });
    }
  };
}

function newBoxItemSheet({ name = "", box }) {
  let n = 1, photo = null;
  const s = openSheet(`<h2>In die Kiste</h2>
    <div class="field"><label for="nbi-name">Was ist drin?</label>
      <input class="text" id="nbi-name" value="${esc(name)}" placeholder="z. B. Lichterkette" autocomplete="off" enterkeyhint="done"></div>
    <div class="suggest" id="nbi-sim"></div>
    <div class="field"><label for="nbi-box">Kiste</label>${boxSelectHtml("nbi-box", box)}</div>
    <div class="locline"><span class="locname">Wie viele?</span>${stepperHtml("nbi-n", n)}</div>
    <div class="field"><span class="label">Foto</span><div id="nbi-photo"></div></div>
    <div class="btnrow"><button class="btn ghost" id="nbi-cancel">Abbrechen</button><button class="btn primary" id="nbi-save">Speichern</button></div>`);
  const nameEl = $("#nbi-name", s), boxEl = $("#nbi-box", s);
  const showSimilar = () => {
    const sim = similar(nameEl.value, null, itemsIn(boxEl.value));
    $("#nbi-sim", s).innerHTML = sim.length ? `<span class="label">Schon in der Kiste?</span>` + sim.map(it =>
      `<button type="button" data-id="${it.id}"><span>${esc(it.name)}</span><span>Öffnen</span></button>`).join("") : "";
  };
  nameEl.addEventListener("input", showSimilar);
  boxEl.addEventListener("change", showSimilar);
  showSimilar();
  $("#nbi-sim", s).addEventListener("click", e => {
    const b = e.target.closest("[data-id]"); if (b) boxItemSheet(b.dataset.id);
  });
  wireSteppers(s, (key, v) => (n = v), () => n);
  photoField($("#nbi-photo", s), () => photo, p => { photo = p; }, () => nameEl.value.trim());
  const save = () => {
    const nm = nameEl.value.trim();
    if (!nm) { nameEl.focus(); nameEl.placeholder = "Bitte einen Namen eintragen"; return; }
    const id = store.put({ kind: "boxitem", name: nm, box: boxEl.value, n, photo });
    if (!boxItemById(id)) state.boxItems.push({ id, kind: "boxitem", name: nm, box: boxEl.value, n, eans: [], photo });
    closeSheet();
    toast(`${nm} eingetragen`);
    openBox(boxEl.value);
  };
  $("#nbi-cancel", s).onclick = closeSheet;
  $("#nbi-save", s).onclick = save;
  nameEl.addEventListener("keydown", e => { if (e.key === "Enter") nameEl.blur(); });
  setTimeout(() => nameEl.focus(), 60);
}

// One article in a Kiste: number, name, which Kiste, delete.
function boxItemSheet(id) {
  const it = boxItemById(id); if (!it) return;
  const s = openSheet(`<h2 id="bi-title">${esc(it.name)}</h2>
    <div id="bi-photo"></div>
    <div class="locline"><span class="locname">Anzahl</span>${stepperHtml("bi-n", it.n)}</div>
    <div class="field"><label for="bi-name">Name</label><input class="text" id="bi-name" value="${esc(it.name)}" autocomplete="off" enterkeyhint="done"></div>
    <div class="field"><label for="bi-box">In Kiste</label>${boxSelectHtml("bi-box", it.box)}</div>
    <button class="btn primary" id="bi-done">Fertig</button>
    <button class="linkbtn danger" id="bi-del">Artikel löschen</button>`);
  const nameEl = $("#bi-name", s);
  const saveName = () => {
    const v = nameEl.value.trim(), cur = boxItemById(id);
    if (v && cur && v !== cur.name) { store.update(id, { name: v }); cur.name = v; $("#bi-title", s).textContent = v; renderList(); }
  };
  nameEl.addEventListener("change", saveName);
  photoField($("#bi-photo", s), () => boxItemById(id)?.photo, p => {
    const cur = boxItemById(id); if (!cur) return;
    cur.photo = p; store.update(id, { photo: p }); renderList();
  }, () => boxItemById(id)?.name, true);
  wireSteppers(s, (key, v) => { const cur = boxItemById(id); if (cur) { bumpBoxItem(cur, v - cur.n); renderList(); } return v; },
    () => boxItemById(id)?.n ?? 0);
  $("#bi-box", s).addEventListener("change", e => {
    const cur = boxItemById(id); if (!cur) return;
    cur.box = e.target.value; store.update(id, { box: cur.box });
    toast(`${cur.name} liegt jetzt in ${boxById(cur.box)?.name || "der Kiste"}`);
    renderList();
  });
  $("#bi-done", s).onclick = () => { saveName(); closeSheet(); };
  $("#bi-del", s).onclick = () => {
    const cur = boxItemById(id);
    const c = openSheet(`<h2>${esc(cur.name)} löschen?</h2>
      <div class="btnrow"><button class="btn ghost" id="d-no">Behalten</button><button class="btn danger" id="d-yes">Löschen</button></div>`);
    $("#d-no", c).onclick = () => boxItemSheet(id);
    $("#d-yes", c).onclick = () => {
      store.remove(id); state.boxItems = state.boxItems.filter(x => x.id !== id);
      closeSheet(); renderList(); toast(`${cur.name} gelöscht`);
    };
  };
}

// ---------- scanner ----------
let scanner = null;
let pendingNew = null; // the new-item form a scan opened, while it is open

// `hand`: opened by a Bluetooth hand scanner, so no camera is needed.
function openScanner({ hand = false } = {}) {
  const host = $("#scanhost");
  host.innerHTML = `<div class="scanner ${hand ? "hand" : ""}" role="dialog" aria-label="Barcode scannen">
    ${hand ? "" : `<video muted playsinline></video>`}
    <div class="top">
      <div class="row">
        <div class="seg dir" id="sc-dir"><button data-v="in">＋ Rein</button><button data-v="out">− Raus</button></div>
        <button class="close" id="sc-close" aria-label="Scanner schließen">✕</button>
      </div>
      <div class="seg" id="sc-loc">${LOCS.map(l => `<button data-v="${l}">${LOC_NAME[l]}</button>`).join("")}</div>
    </div>
    ${hand ? `<div class="handmsg"><strong>Handscanner bereit</strong><span>Scanne einfach los. Rein/Raus und das Lager wählst du oben oder mit den Steuer-Barcodes.</span></div>`
      : `<div class="aim"><div id="sc-aim"></div></div>
    <div class="msg" id="sc-msg"><span class="spinner"></span>&nbsp; Kamera startet …</div>`}
    <div class="card" id="sc-card"><div class="hint">${hand ? "Jeder Scan wird sofort gezählt." : "Halte den Barcode in den Rahmen. Gezählt wird automatisch."}</div></div>
  </div>`;
  document.body.style.overflow = "hidden";
  document.body.classList.add("scanning");
  paintScanControls();
  $("#sc-dir").onclick = e => { const b = e.target.closest("[data-v]"); if (!b) return; state.scanDir = b.dataset.v; paintScanControls(); };
  $("#sc-loc").onclick = e => { const b = e.target.closest("[data-v]"); if (!b) return; state.scanLoc = b.dataset.v; saveUi(); paintScanControls(); };
  $("#sc-close").onclick = closeScanner;

  if (hand) {
    scanner = { hand: true, paused: false, stop() {}, forget() {} };
    return;
  }
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
  scanner = null;
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
    onDone: (id, linked, quiet) => {
      if (pendingNew === sheet) pendingNew = null;
      if (!scanner) return;
      scanner.paused = false;
      if (id && linked) countScan(id);
      else if (id && !quiet) setTimeout(() => showResult(id, { text: "Neu angelegt" }), 300);
    },
  });
  pendingNew = sheet;
  sheet.setProduct(await lookupProduct(code));
}

// ---------- hand scanner ----------
// A Bluetooth barcode scanner acts like a keyboard: it types the code very fast and
// presses Enter. Such bursts are caught anywhere in the app (outside text fields).
const CONTROL = {
  VKREIN: ["dir", "in", "Ab jetzt: Rein"], VKRAUS: ["dir", "out", "Ab jetzt: Raus"],
  VKKELLER: ["loc", "keller", "Ab jetzt: Keller"], VKAUSSEN: ["loc", "aussen", "Ab jetzt: Außenlager"],
};
let kbBuf = "", kbLast = 0, kbTimer = null;
document.addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest && e.target.closest("input, textarea, select")) return;
  const now = performance.now();
  if (now - kbLast > 100) kbBuf = "";
  kbLast = now;
  clearTimeout(kbTimer);
  if (e.key === "Enter" || e.key === "Tab") {
    if (kbBuf.length >= 4) { e.preventDefault(); handCode(kbBuf); }
    kbBuf = "";
    return;
  }
  if (e.key.length !== 1) return;
  kbBuf += e.key;
  if (kbBuf.length > 1) e.preventDefault();
  // Scanners set to send no Enter: a pause ends the code.
  kbTimer = setTimeout(() => { if (kbBuf.length >= 8) handCode(kbBuf); kbBuf = ""; }, 150);
});

function handCode(raw) {
  if (!$("#list")) return; // not logged in yet
  const code = raw.trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!code) return;
  unlockAudio();
  if ($("#sheet").innerHTML && !(scanner && scanner.paused)) closeSheet();
  if (!scanner) openScanner({ hand: true });
  const ctl = CONTROL[code];
  if (ctl) {
    if (ctl[0] === "dir") state.scanDir = ctl[1]; else { state.scanLoc = ctl[1]; saveUi(); }
    paintScanControls();
    beep(true);
    const card = $("#sc-card");
    if (card) card.innerHTML = `<div class="head"><div class="name">${ctl[2]}</div></div>`;
    return;
  }
  if (scanner.paused) {
    // The new-item form is open: the same code counts one more, another code saves it first.
    const f = pendingNew;
    if (!f) { beep(false); return; }
    if (f.ean === code) { if (state.scanDir === "in") f.addOne(); beep(true); return; }
    f.saveQuiet().then(ok => { if (ok) onScan(code); else beep(false); });
    return;
  }
  onScan(code);
}

// Count a known item according to the Rein/Raus and place settings.
function countScan(id) {
  const it = byId(id); if (!it) return;
  const loc = state.scanLoc, snap = snapshot(it);

  if (state.scanDir === "in") {
    bump(it, loc, 1);
    return showResult(id, { loc, text: `+1 ${unitNoun(it, 1)} rein`, snap });
  }

  // Raus. Where is something to take? Prefer the chosen place.
  const from = inStock(it, loc) ? loc : LOCS.find(l => inStock(it, l));
  if (!from) {
    beep(false);
    return showResult(id, { warning: `Laut App ist nirgends mehr ${esc(it.name)} da.` });
  }
  const note = from !== loc ? `Im ${LOC_NAME[loc]} war laut App nichts mehr, genommen aus dem ${LOC_NAME[from]}.` : null;

  if (isPieces(it)) {
    takePiece(it, from);
    return showResult(id, { loc: from, text: "1 Stück raus", snap, note, wholeOption: true });
  }
  if (isFill(it)) {
    // Pouring from a bottle: show the opened ones to set how full they are now.
    // With none opened there yet, open one.
    let text = "";
    if (!openedIn(it, from).length) { openPack(it, from); text = "Flasche angebrochen"; }
    return showResult(id, { loc: from, text, snap, note, fillPicker: true, wholeOption: true });
  }
  bump(it, from, -1);
  showResult(id, { loc: from, text: "−1 raus", neg: true, snap, note });
}

// The card at the bottom of the scanner: what just happened, with ways to correct it.
function showResult(id, opts = {}) {
  let { loc, text, neg, snap, note, warning, fillPicker, wholeOption } = opts;
  const it = byId(id); const card = $("#sc-card"); if (!it || !card) return;
  loc = loc || state.scanLoc;
  const opened = it.opened.map((o, i) => ({ o, i })).filter(x => x.o.loc === loc);
  const pills = pillsHtml(it, loc);
  const canWhole = wholeOption && snap && snap.keller + snap.aussen > 0;
  card.innerHTML = `
    <div class="head"><div style="min-width:0"><div class="name">${esc(it.name)}</div>
      <div class="hint">${LOC_NAME[loc]}${text ? ` · <span class="delta ${neg || /raus|angebrochen|weg/.test(text) ? "neg" : ""}">${esc(text)}</span>` : ""}</div>
      ${pills && !fillPicker ? `<div class="hint">${davonHtml(it, loc)}</div>` : ""}</div>
      <div class="big" aria-label="${unitNoun(it, 2)} im ${LOC_NAME[loc]}">${units(it, loc)}${it.pack.mode !== "count" ? `<small>${unitNoun(it, units(it, loc))}</small>` : ""}</div></div>
    ${note ? `<div class="warnbox">${note}</div>` : ""}
    ${warning ? `<div class="warnbox">${warning}</div>` : ""}
    ${fillPicker && opened.length ? `<div class="olist"><div class="hint">Wie voll ${opened.length > 1 ? "sind die angebrochenen" : "ist sie"} jetzt?</div>
      ${opened.map(({ o, i }) => `<div class="orow">${bottleHtml(o.left)}${fillSegHtml(i, o.left)}</div>`).join("")}</div>` : ""}
    ${fillPicker && it[loc] > 0 ? `<button type="button" class="linkbtn" id="sc-new">Noch eine Flasche anbrechen</button>` : ""}
    <div class="btnrow">
      ${canWhole ? `<button class="btn ghost small" id="sc-whole">Ganze ${packNoun(it, 1)} raus</button>`
        : wholeOption ? `<span></span>`
        : `<div class="stepper" style="justify-self:start"><button type="button" data-d="-1" aria-label="Eins weniger" ${it[loc] ? "" : "disabled"}>−</button><button type="button" class="plus" data-d="1" aria-label="Eins mehr">+</button></div>`}
      ${snap ? `<button class="btn ghost small" id="sc-undo">Rückgängig</button>` : `<span></span>`}
    </div>`;
  card.querySelectorAll(".stepper [data-d]").forEach(b => b.onclick = () => {
    const cur = byId(id); bump(cur, loc, Number(b.dataset.d));
    showResult(id, { loc, text, neg, snap });
  });
  card.onclick = e => {
    const fb = e.target.closest(".fillseg [data-v]");
    if (fb) {
      const v = Number(fb.dataset.v);
      setLeft(byId(id), Number(fb.closest(".fillseg").dataset.i), v);
      return showResult(id, { ...opts, loc, text: v ? `jetzt ${fillShort(v)}` : "leere Flasche weg" });
    }
    if (e.target.closest("#sc-new")) {
      openPack(byId(id), loc);
      showResult(id, { ...opts, loc, text: "Flasche angebrochen" });
    }
  };
  const whole = $("#sc-whole", card);
  if (whole) whole.onclick = () => {
    // Undo the piece / opening, take a whole closed pack instead.
    const cur = byId(id);
    restore(cur, snap);
    const from = cur[loc] > 0 ? loc : LOCS.find(l => cur[l] > 0);
    if (!from) return showResult(id, { warning: `Keine volle ${packNoun(cur, 1)} mehr da.`, snap });
    bump(cur, from, -1);
    showResult(id, { loc: from, text: `ganze ${packNoun(cur, 1)} raus`, neg: true, snap });
  };
  const undo = $("#sc-undo", card);
  if (undo) undo.onclick = () => {
    const cur = byId(id);
    restore(cur, snap);
    scanner && scanner.forget();
    card.innerHTML = `<div class="hint">Rückgängig gemacht: ${esc(cur.name)}.</div>`;
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

// Older versions let an opened bottle be "voll". Count those as unopened ones again.
const settling = new Set();
function settleFull(items) {
  for (const it of items) {
    if (!isFill(it) || !it.opened.some(o => o.left >= 1) || settling.has(it.id)) continue;
    settling.add(it.id);
    store.settleFull(it.id).catch(e => console.error(e)).finally(() => settling.delete(it.id));
  }
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
    state.items = items.filter(it => it.kind === "item");
    state.boxes = items.filter(it => it.kind === "box");
    state.boxItems = items.filter(it => it.kind === "boxitem");
    state.loaded = true; state.pending = !!meta.pending;
    settleFull(state.items);
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

document.body.insertAdjacentHTML("beforeend", `<div id="sheet"></div><div id="lightbox"></div><div id="toast"></div>`);
