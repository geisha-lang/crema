import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const wasmPath = path.join(rootDir, "build", "studio.wasm");

function makeEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(type, ev = {}) {
      for (const fn of listeners.get(type) || []) {
        fn({ preventDefault() {}, ...ev });
      }
    },
  };
}

const fillRectCalls = [];
const fillTextCalls = [];
let fakeNowMs = 1000;

const ctx2d = {
  font: "400 14px sans-serif",
  textAlign: "left",
  fillStyle: "#000",
  strokeStyle: "#000",
  lineWidth: 1,
  shadowColor: "transparent",
  shadowBlur: 0,
  shadowOffsetX: 0,
  shadowOffsetY: 0,
  lineCap: "butt",
  lineJoin: "miter",
  globalAlpha: 1,
  save() {},
  restore() {},
  scale() {},
  translate() {},
  rotate() {},
  beginPath() {},
  closePath() {},
  rect() {},
  roundRect() {},
  arc() {},
  ellipse() {},
  moveTo() {},
  lineTo() {},
  clip() {},
  fill() {},
  stroke() {},
  setLineDash() {},
  createLinearGradient() {
    return { addColorStop() {} };
  },
  measureText(txt) {
    return { width: String(txt).length * 8 };
  },
  fillRect(x, y, w, h) {
    fillRectCalls.push({ x, y, w, h, fillStyle: this.fillStyle });
  },
  fillText(txt, x, y) {
    fillTextCalls.push({ txt, x, y, fillStyle: this.fillStyle });
  },
};

const docTarget = makeEventTarget();
const winTarget = makeEventTarget();

const canvas = {
  ...makeEventTarget(),
  width: 0,
  height: 0,
  clientWidth: 960,
  clientHeight: 640,
  style: { width: "", height: "", cursor: "default" },
  getContext() {
    return ctx2d;
  },
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 960, height: 640 };
  },
};

const imeInput = {
  ...makeEventTarget(),
  value: "",
  selectionStart: 0,
  selectionEnd: 0,
  selectionDirection: "none",
  style: {
    left: "-9999px",
    top: "0px",
    width: "1px",
    height: "1px",
    paddingLeft: "0px",
    paddingRight: "0px",
    pointerEvents: "none",
  },
  setSelectionRange(s, e) {
    this.selectionStart = s;
    this.selectionEnd = e;
    this.selectionDirection = "forward";
  },
  focus() {
    globalThis.document.activeElement = this;
  },
  blur() {
    if (globalThis.document.activeElement === this) {
      globalThis.document.activeElement = null;
      this.dispatchEvent("blur");
    }
  },
};

globalThis.performance = {
  now: () => fakeNowMs,
};
globalThis.window = {
  ...winTarget,
  innerWidth: 960,
  innerHeight: 640,
  devicePixelRatio: 1,
};
globalThis.document = {
  ...docTarget,
  hidden: false,
  activeElement: null,
};
let rafCallback = null;
globalThis.requestAnimationFrame = (cb) => {
  rafCallback = cb;
  return 1;
};
globalThis.fetch = async () => ({
  arrayBuffer: async () => fs.readFileSync(wasmPath).buffer,
});
globalThis.Image = class {};

const { mountCremaApp } = await import(path.join(rootDir, "host", "web", "crema.js"));

let capturedEnv = null;
let fakeNextClickFocus = null;
let idleStepOverride = false;
const origInstantiate = WebAssembly.instantiate;
WebAssembly.instantiate = async (bytes, imports) => {
  const res = await origInstantiate(bytes, imports);
  const rawExports = res.instance.exports;
  const wrappedExports = {};
  for (const key of Object.keys(rawExports)) {
    wrappedExports[key] = rawExports[key];
  }
  const origClick = rawExports.crema_pointer_click;
  const origStep = rawExports.crema_step_frame;
  wrappedExports.crema_pointer_click = (x, y) => {
    if (fakeNextClickFocus) {
      const fn = fakeNextClickFocus;
      fakeNextClickFocus = null;
      fn(x, y);
      return;
    }
    return origClick(x, y);
  };
  wrappedExports.crema_step_frame = (dt, w, h) => {
    if (idleStepOverride) return 0;
    return origStep(dt, w, h);
  };
  capturedEnv = { imports: imports.env, exports: wrappedExports };
  return { instance: { exports: wrappedExports }, module: res.module };
};

let helperCtx = null;
await mountCremaApp({
  canvas,
  imeInput,
  wasmUrl: "studio.wasm",
  width: 960,
  height: 640,
  beforeInit(info) {
    helperCtx = info;
  },
});

const strPtr = (s) => helperCtx.writeStr(s);
const idPtr = strPtr("note-input");
const valPtr = strPtr("HelloWorld");

function emitImeFrame(idStr, valStr, padX = 8) {
  const mem = capturedEnv.exports.memory;
  const wordsPtr = capturedEnv.exports.gs_wasm_alloc(8 + 10 * 8) >>> 0;
  const strsPtr = capturedEnv.exports.gs_wasm_alloc(8 + 3 * 4) >>> 0;
  const s0 = strPtr(idStr);
  const s1 = strPtr(valStr);
  const s2 = strPtr("placeholder");
  new Uint32Array(mem.buffer, strsPtr + 8, 3).set([s0, s1, s2]);
  const i32 = new Int32Array(mem.buffer, wordsPtr + 8, 20);
  const f64 = new Float64Array(mem.buffer, wordsPtr + 8, 10);
  i32[0] = 14; // OP_IME_INPUT
  i32[1] = 0;
  i32[2] = 1;
  i32[3] = 2;
  f64[2] = 100; f64[3] = 500; f64[4] = 200; f64[5] = 32;
  f64[6] = padX;
  f64[7] = 14;
  i32[16] = 500; i32[17] = 0xff111111 | 0;
  i32[18] = 0xff888888 | 0; i32[19] = 0xff2563eb | 0;
  capturedEnv.imports.crema_host_present(wordsPtr, 10, strsPtr, 3);
}

// 1. Initial focus via pointerdown -> pointerup: real padX=8, caret at index 3, AND selectionchange before rAF must NOT hide imeInput
fakeNextClickFocus = () => {
  capturedEnv.imports.crema_host_focus_ime(idPtr, valPtr, 100, 500, 200, 32, 8);
};
canvas.dispatchEvent("pointerdown", { button: 0, clientX: 132, clientY: 515 });
canvas.dispatchEvent("pointerup", { button: 0, clientX: 132, clientY: 515 });
assert.equal(imeInput.style.paddingLeft, "8px", "crema_host_focus_ime must use real padX=8");
assert.equal(imeInput.selectionStart, 3, "initial pointerup tap at x=132 must place caret at index 3");
assert.equal(imeInput.selectionEnd, 3);

// P1 #1: selectionchange before next rAF (while lastDrawSnap still has OP_IME_CLEAR) must NOT hide imeInput
globalThis.document.dispatchEvent("selectionchange");
assert.equal(imeInput.style.left, "100px", "selectionchange before rAF must not hide imeInput");
assert.equal(imeInput.style.pointerEvents, "auto");

// P1 #1: typing 'X' before rAF must clear pendingFocusClick so OP_IME_INPUT does not revert caret from 4 to 3
imeInput.value = "HelXloWorld";
imeInput.setSelectionRange(4, 4);
imeInput.dispatchEvent("input");
emitImeFrame("note-input", "HelXloWorld", 8);
assert.equal(imeInput.selectionStart, 4, "typing before rAF must not be overwritten by pendingFocusClick");

// 2. Click inside already-focused imeInput with existing selection (P2 #6b)
imeInput.setSelectionRange(0, 11);
imeInput.dispatchEvent("pointerdown", { clientX: 132, clientY: 515 });
imeInput.dispatchEvent("mouseup", { detail: 1, clientX: 132, clientY: 515 });
assert.equal(imeInput.selectionStart, 3, "clicking inside existing selection must snap caret to index 3");
assert.equal(imeInput.selectionEnd, 3);

// 3. Selection highlight rendering when selectionStart !== selectionEnd
fillRectCalls.length = 0;
imeInput.setSelectionRange(2, 6);
globalThis.document.dispatchEvent("selectionchange");
const selRect = fillRectCalls.find((r) => r.fillStyle === "rgba(59, 130, 246, 0.28)");
assert.ok(selRect, "selectionchange with selectionStart !== selectionEnd must draw selection highlight rect");
assert.equal(selRect.x, 100 + 8 + 2 * 8, "selection highlight x must start at selStart");
assert.equal(selRect.w, 4 * 8, "selection highlight width must span selEnd - selStart");

// 4. Composing Escape must NOT blur; non-composing Escape DOES blur (P1 #2)
imeInput.dispatchEvent("compositionstart");
imeInput.dispatchEvent("keydown", { key: "Escape", isComposing: true, keyCode: 229 });
assert.equal(globalThis.document.activeElement, imeInput, "Escape during composition must not blur imeInput");
imeInput.dispatchEvent("compositionend");

// 5. Model-side clear (e.g. Enter submit clearing smDraft="") syncs imeInput.value while focused (P1 #2)
emitImeFrame("note-input", "", 8);
assert.equal(imeInput.value, "", "model-side clear while focused must sync imeInput.value to empty");
assert.equal(imeInput.selectionStart, 0);

// 6. Idle-tick caret blink in rAF loop & DPR resize repaint (P1 #3)
emitImeFrame("note-input", "BlinkTest", 8);
idleStepOverride = true;
// Move time into blink-off phase (now - lastCaretActivityMs >= 480 and floor(now/530) % 2 === 1)
fakeNowMs += 1060;
fillTextCalls.length = 0;
rafCallback(fakeNowMs);
assert.ok(fillTextCalls.length > 0, "rAF idle frame must repaint when caret blink state flips");

fillTextCalls.length = 0;
globalThis.window.devicePixelRatio = 2;
globalThis.window.dispatchEvent("resize");
assert.equal(canvas.width, 1920, "DPR resize must update canvas backing width");
assert.ok(fillTextCalls.length > 0, "DPR resize on idle frame must repaint cached DrawList");
idleStepOverride = false;

// 7. Clean blur via Escape & crema_host_blur_ime
imeInput.dispatchEvent("keydown", { key: "Escape", isComposing: false, keyCode: 27 });
assert.equal(globalThis.document.activeElement, null, "non-composing Escape must blur imeInput");
assert.equal(imeInput.style.left, "-9999px", "blur must hide imeInput offscreen");
assert.equal(imeInput.style.pointerEvents, "none", "blur must disable pointerEvents");
assert.equal(imeInput.selectionStart, 0, "blur must reset selectionStart");
assert.equal(imeInput.selectionEnd, 0, "blur must reset selectionEnd");

// 8. ScrollX click positioning on long text
capturedEnv.imports.crema_host_focus_ime(idPtr, strPtr("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), 100, 500, 200, 32, 8);
emitImeFrame("note-input", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 8);
imeInput.setSelectionRange(36, 36);
globalThis.document.dispatchEvent("selectionchange");
imeInput.dispatchEvent("pointerdown", { clientX: 120, clientY: 515 });
imeInput.dispatchEvent("mouseup", { detail: 1, clientX: 120, clientY: 515 });
assert.equal(imeInput.selectionStart, 15, "click with scrollX > 0 must account for scrollX offset");
capturedEnv.imports.crema_host_blur_ime();
assert.equal(globalThis.document.activeElement, null);

console.log("  [PASS] crema.js IME: real padX, initial-focus/composing/model-sync, blink/DPR repaint & clean blur");
