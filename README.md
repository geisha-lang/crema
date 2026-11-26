# Kagura（神楽）

Declarative **UI & 2D Game Stage Framework** for [Geisha](https://github.com/geisha-lang/geisha.gsa), compiling the **exact same pure `.gsa` source** to both **WebAssembly (`wasm32` + HTML5 Canvas2D)** and **Native macOS (`arm64` Cocoa + CoreGraphics Quartz 2D)**.

## Architecture (`src/`)

| Module | Responsibility |
| --- | --- |
| `kagura.gfx` | 8-byte word-aligned binary `DrawList` (`MutArray Int64` + interned `MutArray String`), `0xRRGGBBAA` color algebra, and UTF-8 / CJK-aware text measurement & wrapping |
| `kagura.ui` | Clay-inspired two-pass Flexbox (`row`, `col`, `zstack`, `scrollView`, `SizeFixed` / `SizeFit` / `SizeGrow` / `SizePercent`), `instance Functor Element` (`fmap` component composition), automatic scroll/hover/focus/IME management, and embedded `canvasStage` |
| `kagura.stage` | `Camera2D` (frame-rate-independent spring follow, zoom, trauma shake, `worldToScreen` ⇄ `screenToWorld`), keyframe tracks, **Hit-Stop** time dilation, **2-Bone Analytic IK** (`solveTwoBoneIk`), Catmull-Rom / Bezier tapered ribbons, and 2D particle bursts |
| `kagura.app` | TEA (`AppConfig model msg` + `Functor Cmd` + pluggable `HostBridge` with zero-FFI `headlessHost()`) runtime: **dirty-driven 0%-idle redraw** when `appTick: None`, or **60fps simulation loop** when `appTick: Some(tickFn)` |
| `kagura.host` | Thin `envHost()` bindings connecting `kagura.app.Runtime` to `wasm32` Web (`host/web/kagura.js`) or `native` macOS (`host/native/kagura_macos.m`) |

## Dual Hosts (`host/`)

- **`host/web/kagura.js`**: Zero-dependency ES Module (~350 LOC) reading `Int32Array` / `Float64Array` directly out of `wasmExports.memory.buffer` with zero string splitting, plus synthesized WebAudio SFX, transparent `<input>` CJK IME proxy, and frame-boundary `gs_wasm_gc_collect()`.
- **`host/native/kagura_macos.m`**: Zero-dependency Objective-C Cocoa + CoreGraphics Quartz 2D host executing the identical 15 binary opcodes in a native Retina `NSWindow`.

## Quick Start

Add `kagura` to any Geisha project via `geisha.toml`:

```bash
geisha add kagura
# or explicitly:
geisha add github.com/geisha-lang/kagura
```

Build and test this repository:

```bash
# Run headless framework test suite + build wasm32 & native macOS Dojo showcase + native smoke test
make test

# Or run unit tests directly with Geisha
geisha test

# Run the native macOS Retina app directly
./build/kagura-dojo

# Or serve the WebAssembly build (open http://127.0.0.1:8090/examples/dojo/)
make serve
```

## Minimal Example

```geisha
use std.option.Some
use kagura.ui.{themeXuanPaper, fillSpace, pad, gap, col, heading, button}
use kagura.app.{CmdNone, basicUiApp, runtimeCreate}
use kagura.host.envHost

data Msg { Increment }

def appCfg() = basicUiApp(
    themeXuanPaper(),
    (_vp) -> (0, CmdNone),
    (msg, count) -> match msg { Increment -> (count + 1, CmdNone) },
    (_vp, count) -> col([fillSpace(), pad(24.0), gap(12.0)], [
        heading(themeXuanPaper(), 22.0, "Count: " + std.str.intToStr(count)),
        button(themeXuanPaper(), "inc", "+1", Some(Increment)),
    ])
)

pub def createApp(w: Float, h: Float) = runtimeCreate(appCfg(), w, h, envHost())
```
