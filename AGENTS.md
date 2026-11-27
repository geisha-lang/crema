# AGENTS.md — Maintenance & PR Rules (`crema`)

Declarative UI & 2D game stage framework for Geisha (`wasm32` WebAssembly + `darwin-arm64` Cocoa/Quartz2D).

## Branch, Worktree & Pull Request Workflow (No Direct Push to `main`)

`main` is protected on GitHub and gated by `Test & Wasm32 Build (linux-x86_64)` and `Test & Native Smoke (darwin-arm64)`.

1. **Never edit or commit directly on `main` in `~/code/crema`**:
   - Keep `~/code/crema` strictly on clean `main` (`git pull --ff-only`).
   - Always open an isolated `git worktree` on a feature/fix branch (`git -C ~/code/crema worktree add -b <type>/<topic> <workspace>/crema-wt origin/main`).
2. **Open a Pull Request & wait for both CI jobs before merging**:
   - Push your branch (`git push -u origin <branch>`), open a PR via `gh pr create`, and merge only after both `Test & Wasm32 Build (linux-x86_64)` and `Test & Native Smoke (darwin-arm64)` pass.
   - Do not self-merge breaking public API changes without user review.

## Dual-Host Parity & Verification

- Any new opcode or host callback added to `src/gfx.gsa` or `src/host.gsa` **must** be implemented identically in both `host/web/crema.js` and `host/native/crema_macos.m`.
- Core modules (`crema.gfx`, `crema.ui`, `crema.stage`, `crema.app`) must remain pure Geisha with zero host-specific FFI so `geisha test` runs headlessly on both Linux and macOS.
- Verify locally before opening a PR:
  ```sh
  geisha check
  make test
  ```
