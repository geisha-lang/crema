# Crema

Declarative **UI & 2D Stage Framework** for [Geisha](https://github.com/geisha-lang/geisha.gsa), compiling the **exact same pure `.gsa` source** to both **WebAssembly (`wasm32` + HTML5 Canvas2D)** and **Native macOS (`arm64` Cocoa + CoreGraphics Quartz 2D)**.

## Architecture (`src/`)

| Module | Responsibility |
| --- | --- |
| `crema.gfx` | 8-byte word-aligned binary `DrawList` (`MutArray Int64` + interned `MutArray String`), `0xRRGGBBAA` color algebra, and UTF-8 / CJK-aware text measurement & wrapping |
| `crema.ui` | Clay-inspired two-pass Flexbox (`row`, `wrapRow`, `col`, `zstack`, `scrollView`, `SizeFixed` / `SizeFit` / `SizeGrow` / `SizePercent`), `instance Functor Element` (`fmap` component composition), neutral `themeLight()` / `themeDark()`, automatic scroll/hover/focus/IME management, and embedded `canvasStage` / `canvasInteractive` |
| `crema.stage` | `Camera2D` (frame-rate-independent spring follow, zoom, trauma shake, `worldToScreen` ⇄ `screenToWorld`), keyframe tracks, **Hit-Stop** time dilation, **2-Bone Analytic IK** (`solveTwoBoneIk`), Catmull-Rom / Bezier tapered ribbons, and 2D particle bursts |
| `crema.app` | TEA (`AppConfig model msg` + `Functor Cmd` with extensible `CmdPerform(() -> Void)` + pluggable `HostBridge` with zero-FFI `headlessHost()`) runtime: **dirty-driven 0%-idle redraw** when `appTick: None`, or **60fps simulation loop** when `appTick: Some(tickFn)` |
| `crema.host` | Thin `envHost()` bindings connecting `crema.app.Runtime` to `wasm32` Web (`host/web/crema.js`) or `native` macOS (`host/native/crema_macos.m`) |

## Dual Hosts (`host/`)

- **`host/web/crema.js`**: Zero-dependency ES Module reading `Int32Array` / `Float64Array` directly out of `wasmExports.memory.buffer` with zero string splitting, transparent `<input>` CJK IME proxy, pluggable `extraImports` / `onClearBg` / `fonts` hooks, and frame-boundary `gs_wasm_gc_collect()`.
- **`host/native/crema_macos.m`**: Zero-dependency Objective-C Cocoa + CoreGraphics Quartz 2D host executing the identical 16 binary opcodes in a native Retina `NSWindow`.

## Quick Start

Add `crema` to any Geisha project via `geisha.toml`:

```bash
geisha add crema
# or explicitly:
geisha add github.com/geisha-lang/crema
```

Build and test this repository:

```bash
# Run headless framework test suite + build wasm32 & native macOS Studio showcase + native smoke test
make test

# Or run unit tests directly with Geisha
geisha test

# Run the native macOS Retina app directly
./build/crema-studio

# Or serve the WebAssembly build (open http://127.0.0.1:8090/examples/studio/)
make serve
```

## Minimal Example

```geisha
use std.option.Some
use crema.ui.{themeLight, fillSpace, pad, gap, col, heading, button}
use crema.app.{CmdNone, basicUiApp, runtimeCreate}
use crema.host.envHost

data Msg { Increment }

def appCfg() = basicUiApp(
    themeLight(),
    (_vp) -> (0, CmdNone),
    (msg, count) -> match msg { Increment -> (count + 1, CmdNone) },
    (_vp, count) -> col([fillSpace(), pad(24.0), gap(12.0)], [
        heading(themeLight(), 22.0, "Count: " + std.str.intToStr(count)),
        button(themeLight(), "inc", "+1", Some(Increment)),
    ])
)

pub def createApp(w: Float, h: Float) = runtimeCreate(appCfg(), w, h, envHost())
```
