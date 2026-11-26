// Kagura Web Host (`host/web/kagura.js`)
// Zero-dependency ES Module executing Kagura's 8-byte word-aligned binary `DrawList`
// directly out of WebAssembly linear memory onto HiDPI HTML5 Canvas2D, with WebAudio SFX,
// transparent `<input>` CJK IME proxy, and frame-boundary Mark-Sweep GC.

const SANS_FONT = '"PingFang SC", "Hiragino Sans GB", "Noto Sans SC", -apple-system, sans-serif';
const SERIF_FONT = '"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif';
const MONO_FONT = '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

function unpackCssColor(col) {
  const u = col >>> 0;
  if (u === 0) return "";
  const r = (u >>> 24) & 255;
  const g = (u >>> 16) & 255;
  const b = (u >>> 8) & 255;
  const a = u & 255;
  if (a === 255) return `rgb(${r},${g},${b})`;
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
}

function createPaperPattern(ctx) {
  const tile = document.createElement("canvas");
  tile.width = 192;
  tile.height = 192;
  const tctx = tile.getContext("2d");
  if (!tctx) return null;
  let seed = 1337;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  for (let i = 0; i < 600; i++) {
    const x = rand() * 192, y = rand() * 192;
    tctx.fillStyle = rand() > 0.45 ? "rgba(62,50,36,0.026)" : "rgba(255,252,244,0.048)";
    tctx.fillRect(x, y, 1 + rand() * 2, 1);
  }
  tctx.strokeStyle = "rgba(88,72,52,0.02)";
  tctx.lineWidth = 0.7;
  for (let i = 0; i < 38; i++) {
    const x = rand() * 192, y = rand() * 192, len = 10 + rand() * 22;
    tctx.beginPath();
    tctx.moveTo(x, y);
    tctx.lineTo(x + len, y + (rand() - 0.5) * 3);
    tctx.stroke();
  }
  return ctx.createPattern(tile, "repeat");
}

export async function mountKaguraApp(options = {}) {
  const canvas = options.canvas || document.getElementById("kagura-canvas");
  const imeInput = options.imeInput || document.getElementById("kagura-ime");
  const wasmUrl = options.wasmUrl || "./app.wasm";
  const assetsPrefix = options.assetsPrefix || "";
  const ctx = canvas.getContext("2d", { alpha: false });
  const paperPattern = createPaperPattern(ctx);
  const utf8Dec = new TextDecoder("utf-8");
  const utf8Enc = new TextEncoder();

  let cssW = Math.max(320, canvas.clientWidth || window.innerWidth);
  let cssH = Math.max(220, canvas.clientHeight || window.innerHeight);
  let dpr = Math.min(2.0, window.devicePixelRatio || 1);

  function syncCanvasSize() {
    cssW = Math.max(320, canvas.clientWidth || window.innerWidth);
    cssH = Math.max(220, canvas.clientHeight || window.innerHeight);
    dpr = Math.min(2.0, window.devicePixelRatio || 1);
    const pw = Math.round(cssW * dpr);
    const ph = Math.round(cssH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
  }
  window.addEventListener("resize", syncCanvasSize);
  syncCanvasSize();

  // Cached image pool for OP_IMAGE
  const imageCache = new Map();
  function getImage(key) {
    let img = imageCache.get(key);
    if (!img) {
      img = new Image();
      img.decoding = "async";
      img.src = key.startsWith("/") || key.startsWith("http") || key.startsWith("data:")
        ? key
        : `${assetsPrefix}${key}`;
      imageCache.set(key, img);
    }
    return img;
  }

  // Synthesized WebAudio SFX
  let audioCtx = null;
  function playSfx(kind) {
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      if (!audioCtx) audioCtx = new Ctor();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      if (kind === "parry") {
        osc.type = "triangle";
        osc.frequency.setValueAtTime(960, now);
        osc.frequency.exponentialRampToValueAtTime(420, now + 0.14);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc.start(now); osc.stop(now + 0.15);
      } else if (kind === "impact") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(175, now);
        osc.frequency.exponentialRampToValueAtTime(46, now + 0.13);
        gain.gain.setValueAtTime(0.20, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        osc.start(now); osc.stop(now + 0.14);
      } else {
        osc.type = "sine";
        osc.frequency.setValueAtTime(420, now);
        osc.frequency.exponentialRampToValueAtTime(220, now + 0.06);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
        osc.start(now); osc.stop(now + 0.06);
      }
    } catch (_) {}
  }

  let wasmExports = null;
  let callDepth = 0;
  let lastGcLive = 0;
  let activeImeId = "";
  let lastImeKey = "none";
  let frameCount = 0;
  let presentCount = 0;

  function readStr(ptr) {
    const p = ptr >>> 0;
    if (!p || !wasmExports) return "";
    const len = wasmExports.gs_wasm_str_len(p) >>> 0;
    if (!len) return "";
    return utf8Dec.decode(new Uint8Array(wasmExports.memory.buffer, p, len));
  }

  function writeStr(str) {
    const raw = utf8Enc.encode(String(str ?? ""));
    const ptr = wasmExports.gs_wasm_alloc(raw.length + 1) >>> 0;
    const view = new Uint8Array(wasmExports.memory.buffer, ptr, raw.length + 1);
    view.set(raw);
    view[raw.length] = 0;
    return ptr;
  }

  function invokeWasm(fn) {
    callDepth++;
    try {
      return fn();
    } finally {
      callDepth--;
      if (callDepth === 0 && wasmExports) {
        const live = wasmExports.gs_wasm_heap_live() >>> 0;
        if (live > lastGcLive + 524288) {
          wasmExports.gs_wasm_gc_collect();
          lastGcLive = wasmExports.gs_wasm_heap_live() >>> 0;
        }
      }
    }
  }

  function syncImeBox(info) {
    if (!imeInput) return;
    if (!info) {
      if (lastImeKey !== "none") {
        lastImeKey = "none";
        imeInput.style.left = "-9999px";
        imeInput.style.top = "0px";
        imeInput.style.width = "1px";
        imeInput.style.height = "1px";
        imeInput.style.pointerEvents = "none";
      }
      return;
    }
    const key = `${info.id}:${Math.round(info.x)},${Math.round(info.y)},${Math.round(info.w)},${Math.round(info.h)}`;
    if (key !== lastImeKey) {
      lastImeKey = key;
      imeInput.style.left = `${info.x}px`;
      imeInput.style.top = `${info.y}px`;
      imeInput.style.width = `${info.w}px`;
      imeInput.style.height = `${info.h}px`;
      imeInput.style.pointerEvents = "auto";
    }
    if (document.activeElement !== imeInput && imeInput.value !== info.val) {
      imeInput.value = info.val;
    }
  }

  function executeBinaryDrawList(wordsPtr, wordCount, strsPtr, strCount) {
    presentCount++;
    const buf = wasmExports.memory.buffer;
    const wBase = (wordsPtr >>> 0) + 8;
    const sBase = (strsPtr >>> 0) + 8;
    const i32 = new Int32Array(buf, wBase, wordCount * 2);
    const f64 = new Float64Array(buf, wBase, wordCount);
    const strPtrs = strCount > 0 ? new Uint32Array(buf, sBase, strCount) : null;
    const getStr = (idx) => (strPtrs && idx >= 0 && idx < strCount ? readStr(strPtrs[idx]) : "");

    let frameIme = null;
    ctx.save();
    ctx.scale(dpr, dpr);

    let w = 0;
    while (w < wordCount) {
      const op = i32[w * 2];
      const aux = i32[w * 2 + 1];
      switch (op) {
        case 1: { // OP_CLEAR_BG (3 words)
          const topCol = unpackCssColor(i32[(w + 1) * 2]);
          const midCol = unpackCssColor(i32[(w + 1) * 2 + 1]);
          const botCol = unpackCssColor(i32[(w + 2) * 2]);
          const grad = ctx.createLinearGradient(0, 0, 0, cssH);
          grad.addColorStop(0, topCol || "#f7f3e9");
          grad.addColorStop(0.55, midCol || topCol || "#efe8d9");
          grad.addColorStop(1, botCol || midCol || "#e6dcc8");
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, cssW, cssH);
          if ((aux & 2) !== 0 && paperPattern) {
            ctx.fillStyle = paperPattern;
            ctx.fillRect(0, 0, cssW, cssH);
          }
          if ((aux & 1) !== 0) {
            const vig = ctx.createRadialGradient(cssW * 0.5, cssH * 0.45, Math.min(cssW, cssH) * 0.25, cssW * 0.5, cssH * 0.5, Math.max(cssW, cssH) * 0.78);
            vig.addColorStop(0, "rgba(255,252,244,0.08)");
            vig.addColorStop(1, "rgba(20,16,12,0.08)");
            ctx.fillStyle = vig;
            ctx.fillRect(0, 0, cssW, cssH);
          }
          w += 3;
          break;
        }
        case 2: { // OP_RECT (11 words)
          const x = f64[w + 1], y = f64[w + 2], rw = f64[w + 3], rh = f64[w + 4], rad = f64[w + 5];
          const fillTop = i32[(w + 6) * 2], fillBot = i32[(w + 6) * 2 + 1];
          const bdCol = i32[(w + 7) * 2], shCol = i32[(w + 7) * 2 + 1];
          const lw = f64[w + 8], shY = f64[w + 9], shBlur = f64[w + 10];
          if (rw > 0 && rh > 0) {
            ctx.save();
            if (shCol !== 0 && shBlur > 0) {
              ctx.shadowColor = unpackCssColor(shCol);
              ctx.shadowBlur = shBlur;
              ctx.shadowOffsetX = 0;
              ctx.shadowOffsetY = shY;
            }
            ctx.beginPath();
            ctx.roundRect(x, y, rw, rh, rad);
            if (fillTop !== 0 || fillBot !== 0) {
              if (fillTop === fillBot || fillBot === 0) {
                ctx.fillStyle = unpackCssColor(fillTop || fillBot);
              } else {
                const g = ctx.createLinearGradient(x, y, x, y + rh);
                g.addColorStop(0, unpackCssColor(fillTop));
                g.addColorStop(1, unpackCssColor(fillBot));
                ctx.fillStyle = g;
              }
              ctx.fill();
            }
            ctx.shadowColor = "transparent";
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;
            if (bdCol !== 0 && lw > 0) {
              ctx.strokeStyle = unpackCssColor(bdCol);
              ctx.lineWidth = lw;
              ctx.stroke();
            }
            if ((aux & 1) !== 0 && rw > 10 && rh > 10) {
              ctx.strokeStyle = "rgba(156,114,44,0.28)";
              ctx.lineWidth = 0.75;
              ctx.beginPath();
              ctx.roundRect(x + 3.5, y + 3.5, rw - 7, rh - 7, Math.max(1, rad - 1));
              ctx.stroke();
            }
            ctx.restore();
          }
          w += 11;
          break;
        }
        case 3: { // OP_PROGRESS_BAR (10 words)
          const x = f64[w + 1], y = f64[w + 2], rw = f64[w + 3], rh = f64[w + 4], rad = f64[w + 5];
          const ratio = f64[w + 6], trail = f64[w + 7];
          const cStart = i32[(w + 8) * 2], cEnd = i32[(w + 8) * 2 + 1];
          const cTrail = i32[(w + 9) * 2], cTrack = i32[(w + 9) * 2 + 1];
          if (rw > 0 && rh > 0) {
            ctx.save();
            if (cTrack !== 0) {
              ctx.beginPath();
              ctx.roundRect(x, y, rw, rh, rad);
              ctx.fillStyle = unpackCssColor(cTrack);
              ctx.fill();
            }
            if (trail > ratio + 0.004 && cTrail !== 0) {
              ctx.beginPath();
              ctx.roundRect(x, y, rw * trail, rh, rad);
              ctx.fillStyle = unpackCssColor(cTrail);
              ctx.fill();
            }
            if (ratio > 0.003 && cStart !== 0) {
              const fw = Math.max(rh, rw * ratio);
              const g = ctx.createLinearGradient(x, y, x + fw, y);
              g.addColorStop(0, unpackCssColor(cStart));
              g.addColorStop(1, unpackCssColor(cEnd || cStart));
              ctx.beginPath();
              ctx.roundRect(x, y, fw, rh, rad);
              ctx.fillStyle = g;
              ctx.fill();
            }
            ctx.restore();
          }
          w += 10;
          break;
        }
        case 4: { // OP_ELLIPSE (7 words)
          const cx = f64[w + 1], cy = f64[w + 2], rx = f64[w + 3], ry = f64[w + 4];
          const fillCol = i32[(w + 5) * 2], strokeCol = i32[(w + 5) * 2 + 1];
          const lw = f64[w + 6];
          ctx.save();
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
          if (fillCol !== 0) { ctx.fillStyle = unpackCssColor(fillCol); ctx.fill(); }
          if (strokeCol !== 0 && lw > 0) { ctx.strokeStyle = unpackCssColor(strokeCol); ctx.lineWidth = lw; ctx.stroke(); }
          ctx.restore();
          w += 7;
          break;
        }
        case 5: { // OP_LINE (7 words)
          const x1 = f64[w + 1], y1 = f64[w + 2], x2 = f64[w + 3], y2 = f64[w + 4], lw = f64[w + 5];
          const col = i32[(w + 6) * 2];
          if (col !== 0 && lw > 0) {
            ctx.save();
            ctx.strokeStyle = unpackCssColor(col);
            ctx.lineWidth = lw;
            ctx.lineCap = "round";
            if ((aux & 1) !== 0) ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            ctx.restore();
          }
          w += 7;
          break;
        }
        case 6: { // OP_POLYGON (3 + 2*N words)
          const nPts = aux;
          const fillCol = i32[(w + 1) * 2], strokeCol = i32[(w + 1) * 2 + 1];
          const lw = f64[w + 2];
          if (nPts >= 2) {
            ctx.save();
            ctx.lineJoin = "round";
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(f64[w + 3], f64[w + 4]);
            for (let i = 1; i < nPts; i++) {
              ctx.lineTo(f64[w + 3 + i * 2], f64[w + 4 + i * 2]);
            }
            ctx.closePath();
            if (fillCol !== 0) { ctx.fillStyle = unpackCssColor(fillCol); ctx.fill(); }
            if (strokeCol !== 0 && lw > 0) { ctx.strokeStyle = unpackCssColor(strokeCol); ctx.lineWidth = lw; ctx.stroke(); }
            ctx.restore();
          }
          w += 3 + nPts * 2;
          break;
        }
        case 7: { // OP_RIBBON (3 + 3*N words) — single smooth tapered calligraphy/slash polygon
          const nPts = aux;
          const rawCol = i32[(w + 1) * 2] >>> 0;
          const baseAlpha = f64[w + 2];
          if (nPts >= 2 && rawCol !== 0) {
            const r = (rawCol >>> 24) & 255, g = (rawCol >>> 16) & 255, b = (rawCol >>> 8) & 255;
            const a0 = ((rawCol & 255) / 255) * baseAlpha;
            const lx = new Float64Array(nPts), ly = new Float64Array(nPts);
            const rx = new Float64Array(nPts), ry = new Float64Array(nPts);
            for (let i = 0; i < nPts; i++) {
              const prev = w + 3 + Math.max(0, i - 1) * 3;
              const curr = w + 3 + i * 3;
              const next = w + 3 + Math.min(nPts - 1, i + 1) * 3;
              let tx = f64[next] - f64[prev], ty = f64[next + 1] - f64[prev + 1];
              const len = Math.hypot(tx, ty) || 1;
              tx /= len; ty /= len;
              const nx = -ty, ny = tx;
              const taper = 0.18 + 0.82 * (i / (nPts - 1));
              const hw = Math.max(0.4, f64[curr + 2] * 0.5 * taper);
              lx[i] = f64[curr] + nx * hw; ly[i] = f64[curr + 1] + ny * hw;
              rx[i] = f64[curr] - nx * hw; ry[i] = f64[curr + 1] - ny * hw;
            }
            const pStart = w + 3, pEnd = w + 3 + (nPts - 1) * 3;
            ctx.save();
            const grad = ctx.createLinearGradient(f64[pStart], f64[pStart + 1], f64[pEnd], f64[pEnd + 1]);
            grad.addColorStop(0, `rgba(${r},${g},${b},${(a0 * 0.06).toFixed(3)})`);
            grad.addColorStop(0.55, `rgba(${r},${g},${b},${(a0 * 0.55).toFixed(3)})`);
            grad.addColorStop(1, `rgba(${r},${g},${b},${a0.toFixed(3)})`);
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(lx[0], ly[0]);
            for (let i = 1; i < nPts; i++) ctx.lineTo(lx[i], ly[i]);
            for (let i = nPts - 1; i >= 0; i--) ctx.lineTo(rx[i], ry[i]);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
          w += 3 + nPts * 3;
          break;
        }
        case 8: { // OP_TEXT (5 words)
          const txt = getStr(aux);
          const x = f64[w + 1], y = f64[w + 2], sz = f64[w + 3];
          const styleBits = i32[(w + 4) * 2], col = i32[(w + 4) * 2 + 1];
          const famCode = (styleBits >>> 16) & 255;
          const alignCode = (styleBits >>> 8) & 255;
          const weight = Math.max(100, Math.min(900, (styleBits & 255) * 100));
          const fam = famCode === 1 ? SERIF_FONT : famCode === 2 ? MONO_FONT : SANS_FONT;
          ctx.save();
          ctx.fillStyle = unpackCssColor(col);
          ctx.font = `${weight} ${sz}px ${fam}`;
          ctx.textAlign = alignCode === 1 ? "center" : alignCode === 2 ? "right" : "left";
          ctx.fillText(txt, x, y);
          ctx.restore();
          w += 5;
          break;
        }
        case 9: { // OP_IMAGE (7 words)
          const key = getStr(aux);
          const x = f64[w + 1], y = f64[w + 2], rw = f64[w + 3], rh = f64[w + 4], rad = f64[w + 5], al = f64[w + 6];
          const img = getImage(key);
          ctx.save();
          ctx.globalAlpha = al;
          ctx.beginPath();
          ctx.roundRect(x, y, rw, rh, rad);
          ctx.clip();
          if (img.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, x, y, rw, rh);
          } else {
            ctx.fillStyle = "#dfd5be";
            ctx.fillRect(x, y, rw, rh);
          }
          ctx.restore();
          w += 7;
          break;
        }
        case 10: { // OP_PUSH_CLIP (5 words)
          ctx.save();
          ctx.beginPath();
          ctx.rect(f64[w + 1], f64[w + 2], f64[w + 3], f64[w + 4]);
          ctx.clip();
          w += 5;
          break;
        }
        case 11: { // OP_POP_CLIP (1 word)
          ctx.restore();
          w += 1;
          break;
        }
        case 12: { // OP_PUSH_TRANSFORM (6 words)
          ctx.save();
          ctx.translate(f64[w + 1], f64[w + 2]);
          if (f64[w + 5] !== 0) ctx.rotate((f64[w + 5] * Math.PI) / 180);
          ctx.scale(f64[w + 3], f64[w + 4]);
          w += 6;
          break;
        }
        case 13: { // OP_POP_TRANSFORM (1 word)
          ctx.restore();
          w += 1;
          break;
        }
        case 14: { // OP_IME_INPUT (6 words)
          frameIme = {
            id: getStr(aux),
            val: getStr(i32[(w + 1) * 2]),
            x: f64[w + 2],
            y: f64[w + 3],
            w: f64[w + 4],
            h: f64[w + 5],
          };
          w += 6;
          break;
        }
        case 15: { // OP_IME_CLEAR (1 word)
          frameIme = null;
          w += 1;
          break;
        }
        default:
          w = wordCount;
          break;
      }
    }

    ctx.restore();
    syncImeBox(frameIme);
  }

  // Optional WebSocket network transport
  let ws = null;
  function connectNet(mode, user, token) {
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    const targetUrl = options.wsUrl || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const sock = new WebSocket(targetUrl);
    ws = sock;
    sock.addEventListener("open", () => {
      if (wasmExports.kagura_on_net_open) {
        invokeWasm(() => wasmExports.kagura_on_net_open(writeStr(mode), writeStr(user), writeStr(token)));
      }
    });
    sock.addEventListener("message", (ev) => {
      if (typeof ev.data === "string" && wasmExports.kagura_on_net_message) {
        invokeWasm(() => wasmExports.kagura_on_net_message(writeStr(ev.data)));
      }
    });
    sock.addEventListener("close", () => {
      if (ws === sock && wasmExports.kagura_on_net_close) {
        ws = null;
        invokeWasm(() => wasmExports.kagura_on_net_close());
      }
    });
  }

  const wasmBytes = await (await fetch(wasmUrl)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    env: {
      sin: Math.sin,
      cos: Math.cos,
      acos: Math.acos,
      atan2: Math.atan2,
      sqrt: Math.sqrt,
      exp: Math.exp,
      gs_log: (ptr, len) => {
        if (!wasmExports || !len) return;
        const msg = utf8Dec.decode(new Uint8Array(wasmExports.memory.buffer, ptr >>> 0, len >>> 0));
        if (msg.trim()) console.log("[kagura]", msg.trimEnd());
      },
      kagura_host_present: executeBinaryDrawList,
      kagura_host_set_cursor: (curPtr) => { canvas.style.cursor = readStr(curPtr) || "default"; },
      kagura_host_focus_ime: (idPtr, valPtr, x, y, w, h) => {
        const id = readStr(idPtr);
        const val = readStr(valPtr);
        activeImeId = id;
        syncImeBox({ id, val, x, y, w, h });
        if (imeInput) {
          imeInput.value = val;
          imeInput.focus({ preventScroll: true });
        }
      },
      kagura_host_blur_ime: () => {
        activeImeId = "";
        if (imeInput && document.activeElement === imeInput) imeInput.blur();
      },
      kagura_host_play_sfx: (sfxPtr) => playSfx(readStr(sfxPtr)),
      kagura_host_save_local: (kPtr, vPtr) => {
        try { localStorage.setItem(readStr(kPtr), readStr(vPtr)); } catch (_) {}
      },
      kagura_host_send_net: (payloadPtr) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(readStr(payloadPtr));
      },
      kagura_host_connect_net: (mPtr, uPtr, tPtr) => connectNet(readStr(mPtr), readStr(uPtr), readStr(tPtr)),
    },
  });

  wasmExports = instance.exports;
  invokeWasm(() => wasmExports.__geisha_init());
  lastGcLive = wasmExports.gs_wasm_heap_live() >>> 0;
  invokeWasm(() => wasmExports.kagura_init(cssW, cssH));

  // Event listeners
  const rectOffset = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  canvas.addEventListener("pointermove", (e) => {
    const { x, y } = rectOffset(e);
    if (wasmExports.kagura_pointer_move) invokeWasm(() => wasmExports.kagura_pointer_move(x, y));
  });

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    const { x, y } = rectOffset(e);
    if (wasmExports.kagura_pointer_click) invokeWasm(() => wasmExports.kagura_pointer_click(x, y));
    if (activeImeId && imeInput) {
      e.preventDefault();
      imeInput.focus({ preventScroll: true });
    }
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const { x, y } = rectOffset(e);
    if (wasmExports.kagura_scroll_wheel) invokeWasm(() => wasmExports.kagura_scroll_wheel(x, y, e.deltaY));
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    if (imeInput && document.activeElement === imeInput) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (wasmExports.kagura_key_down) invokeWasm(() => wasmExports.kagura_key_down(writeStr(e.key)));
  });

  if (imeInput) {
    const syncText = () => {
      if (activeImeId && wasmExports.kagura_text_input) {
        invokeWasm(() => wasmExports.kagura_text_input(writeStr(activeImeId), writeStr(imeInput.value)));
      }
    };
    imeInput.addEventListener("input", syncText);
    imeInput.addEventListener("compositionend", syncText);
    imeInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.isComposing && activeImeId && wasmExports.kagura_text_submit) {
        ev.preventDefault();
        invokeWasm(() => wasmExports.kagura_text_submit(writeStr(activeImeId)));
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        imeInput.blur();
      }
    });
    imeInput.addEventListener("blur", () => {
      activeImeId = "";
      if (wasmExports.kagura_blur_input) invokeWasm(() => wasmExports.kagura_blur_input());
    });
  }

  let lastTs = performance.now();
  const loop = (ts) => {
    const dt = Math.min(200, Math.max(1, ts - lastTs));
    lastTs = ts;
    if (!document.hidden && wasmExports.kagura_step_frame) {
      frameCount++;
      invokeWasm(() => wasmExports.kagura_step_frame(dt, cssW, cssH));
    }
    requestAnimationFrame(loop);
  };
  // Render initial frame synchronously before starting rAF
  if (wasmExports.kagura_step_frame) {
    frameCount++;
    invokeWasm(() => wasmExports.kagura_step_frame(16.6, cssW, cssH));
  }
  requestAnimationFrame(loop);

  const api = {
    exports: wasmExports,
    stats: () => ({
      frameCount,
      presentCount,
      heapLiveBytes: wasmExports.gs_wasm_heap_live() >>> 0,
      heapUsedBytes: wasmExports.gs_wasm_heap_used() >>> 0,
    }),
    click: (x, y) => invokeWasm(() => wasmExports.kagura_pointer_click(x, y)),
    move: (x, y) => invokeWasm(() => wasmExports.kagura_pointer_move(x, y)),
    wheel: (x, y, dy) => invokeWasm(() => wasmExports.kagura_scroll_wheel(x, y, dy)),
    key: (k) => invokeWasm(() => wasmExports.kagura_key_down(writeStr(k))),
    step: (dt = 16.6) => invokeWasm(() => wasmExports.kagura_step_frame(dt, cssW, cssH)),
  };
  window.__kagura = api;
  if (options.onReady) options.onReady(api);
  return api;
}
