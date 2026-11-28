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

globalThis.window = {
  ...winTarget,
  devicePixelRatio: 1,
};
globalThis.document = {
  ...docTarget,
  hidden: false,
  activeElement: null,
};
globalThis.requestAnimationFrame = () => 1;
globalThis.fetch = async () => ({
  arrayBuffer: async () => fs.readFileSync(wasmPath).buffer,
});
globalThis.Image = class {};

const { mountCremaApp } = await import(path.join(rootDir, "host", "web", "crema.js"));

let capturedEnv = null;
const origInstantiate = WebAssembly.instantiate;
WebAssembly.instantiate = async (bytes, imports) => {
  const res = await origInstantiate(bytes, imports);
  capturedEnv = { imports: imports.env, exports: res.instance.exports };
  return res;
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

// 1. Test crema_host_focus_ime with real padX = 8 and click-to-position caret in middle
const strPtr = (s) => helperCtx.writeStr(s);
const idPtr = strPtr("note-input");
const valPtr = strPtr("HelloWorld");

// Click at x = 100 (box x=100, padX=8) + 8 (padX) + 3 * 8 (3 chars) = 132 -> should land at index 3
canvas.dispatchEvent("pointerdown", { button: 0, clientX: 132, clientY: 515 });
// Simulate pointerup calling crema_host_focus_ime by invoking focus_ime during a tap
// First test direct focus_ime with padX=8:
capturedEnv.imports.crema_host_focus_ime(idPtr, valPtr, 100, 500, 200, 32, 8);
assert.equal(imeInput.style.paddingLeft, "8px", "crema_host_focus_ime must use real padX=8, not hardcoded 10");
assert.equal(imeInput.style.pointerEvents, "auto");
assert.equal(globalThis.document.activeElement, imeInput);

// 2. Test click inside focused imeInput positions caret at clicked character (not end)
// Emit OP_IME_INPUT into a synthetic DrawList via crema_host_present?
// Even simpler: trigger mouseup at clientX = 100 + 8 + 4 * 8 = 140 after setting lastImeRender via studio input click,
// OR test directly on studio's actual ElTextInput!
// Let's find studio's note-input by clicking around or testing OP_IME_INPUT directly via a 10-word DrawList:
const mem = capturedEnv.exports.memory;
const wordsPtr = capturedEnv.exports.gs_wasm_alloc(8 + 10 * 8) >>> 0;
const strsPtr = capturedEnv.exports.gs_wasm_alloc(8 + 3 * 4) >>> 0;
const s0 = strPtr("note-input");
const s1 = strPtr("HelloWorld");
const s2 = strPtr("placeholder");
new Uint32Array(mem.buffer, strsPtr + 8, 3).set([s0, s1, s2]);
const i32 = new Int32Array(mem.buffer, wordsPtr + 8, 20);
const f64 = new Float64Array(mem.buffer, wordsPtr + 8, 10);
i32[0] = 14; // OP_IME_INPUT
i32[1] = 0;  // id idx
i32[2] = 1;  // val idx
i32[3] = 2;  // ph idx
f64[2] = 100; f64[3] = 500; f64[4] = 200; f64[5] = 32;
f64[6] = 8;   // padX = 8
f64[7] = 14;  // fontSize = 14
i32[16] = 500; i32[17] = 0xff111111 | 0;
i32[18] = 0xff888888 | 0; i32[19] = 0xff2563eb | 0;

capturedEnv.imports.crema_host_present(wordsPtr, 10, strsPtr, 3);

// Click at x = 100 + 8 + 3*8 = 132 (char 3) inside already-focused imeInput:
imeInput.setSelectionRange(10, 10);
imeInput.dispatchEvent("pointerdown", { clientX: 132, clientY: 515 });
imeInput.dispatchEvent("mouseup", { clientX: 132, clientY: 515 });
assert.equal(imeInput.selectionStart, 3, "clicking at 3rd char must position caret at index 3");
assert.equal(imeInput.selectionEnd, 3);

// 3. Test selection highlight rendering when selectionStart !== selectionEnd
fillRectCalls.length = 0;
imeInput.setSelectionRange(2, 6);
globalThis.document.dispatchEvent("selectionchange");
const selRect = fillRectCalls.find((r) => r.fillStyle === "rgba(59, 130, 246, 0.28)");
assert.ok(selRect, "selectionchange with selectionStart !== selectionEnd must draw selection highlight rect");
assert.equal(selRect.x, 100 + 8 + 2 * 8, "selection highlight x must start at selStart");
assert.equal(selRect.w, 4 * 8, "selection highlight width must span selEnd - selStart");

// 4. Test horizontal scrollX click positioning when text overflows box width
const longVal = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; // 36 * 8 = 288px > iw(184px)
imeInput.value = longVal;
imeInput.setSelectionRange(36, 36); // caret at end -> scrollX = 288 - (184 - 4) = 108px
globalThis.document.dispatchEvent("selectionchange");
// Click at x = 100 + 8 + 12 = 120 -> relX = 12 + 108 = 120 -> 120 / 8 = index 15
imeInput.setSelectionRange(36, 36);
imeInput.dispatchEvent("pointerdown", { clientX: 120, clientY: 515 });
imeInput.dispatchEvent("mouseup", { clientX: 120, clientY: 515 });
assert.equal(imeInput.selectionStart, 15, "click with scrollX > 0 must account for scrollX offset");

// 5. Test clean blur via crema_host_blur_ime
capturedEnv.imports.crema_host_blur_ime();
assert.equal(imeInput.style.left, "-9999px", "blur must hide imeInput offscreen");
assert.equal(imeInput.style.pointerEvents, "none", "blur must disable pointerEvents");
assert.equal(imeInput.selectionStart, 0, "blur must reset selectionStart");
assert.equal(imeInput.selectionEnd, 0, "blur must reset selectionEnd");
assert.equal(globalThis.document.activeElement, null, "blur must remove DOM focus");

console.log("  [PASS] crema.js IME: real padX, click-to-caret (with scrollX), selection highlight & clean blur");
