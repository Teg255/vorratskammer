// Live barcode scanning with the phone camera.
// Uses the native BarcodeDetector where it exists, otherwise a WebAssembly
// port of ZXing (iPhone Safari has no native one). The .wasm file ships with the app.

import { BarcodeDetector as Ponyfill, prepareZXingModule } from "barcode-detector/ponyfill";

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
let detector = null;

async function getDetector() {
  if (detector) return detector;
  const Native = window.BarcodeDetector;
  if (Native) {
    try {
      const supported = await Native.getSupportedFormats();
      if (FORMATS.every(f => supported.includes(f))) return (detector = new Native({ formats: FORMATS }));
    } catch {}
  }
  prepareZXingModule({
    overrides: { locateFile: (path, prefix) => path.endsWith(".wasm") ? new URL("assets/" + path, document.baseURI).href : prefix + path },
  });
  return (detector = new Ponyfill({ formats: FORMATS }));
}

export class Scanner {
  constructor(video, onCode) {
    this.video = video;
    this.onCode = onCode;
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.stream = null;
    this.running = false;
    this.paused = false;
    this.last = { code: null, at: 0 };
  }

  async start() {
    const det = await getDetector();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute("playsinline", "");
    this.video.muted = true;
    await this.video.play();
    this.running = true;
    this.loop(det);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
  }

  // Only look at the middle band of the picture: faster, and avoids reading a
  // second product lying next to the one you aim at.
  frame() {
    const v = this.video, w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) return null;
    const cw = Math.round(w * 0.8), ch = Math.round(h * 0.5);
    this.canvas.width = cw; this.canvas.height = ch;
    this.ctx.drawImage(v, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, cw, ch);
    return this.canvas;
  }

  async loop(det) {
    if (!this.running) return;
    if (!this.paused && this.video.readyState >= 2) {
      try {
        const f = this.frame();
        const codes = f ? await det.detect(f) : [];
        const code = codes[0]?.rawValue;
        const now = Date.now();
        // The same code is ignored for 2.5 s so one scan counts once.
        if (code && !(code === this.last.code && now - this.last.at < 2500)) {
          this.last = { code, at: now };
          this.onCode(code);
        } else if (code) {
          this.last.at = now;
        }
      } catch { /* a bad frame: just try the next one */ }
    }
    this.timer = setTimeout(() => this.loop(det), 120);
  }

  // Allow the same code to count again right away (after "Nochmal").
  forget() { this.last = { code: null, at: 0 }; }
}

// Short confirmation beep. The AudioContext must be created from a tap on iPhone.
let audio = null;
export function unlockAudio() {
  try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch {}
}
export function beep(ok = true) {
  if (!audio) return;
  try {
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = ok ? 1320 : 440;
    g.gain.setValueAtTime(0.0001, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + (ok ? 0.12 : 0.3));
    o.connect(g).connect(audio.destination);
    o.start(); o.stop(audio.currentTime + 0.32);
  } catch {}
}
