# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Ixtli** is a personal KWin tiling script (KDE Plasma's window manager scripting API). The user also intends to ship it to the **KDE Store** as a plugin — so scope decisions should preserve a path toward user-configurability, real `metadata.json` values (version, authors, description), and closing the README's "Known gaps" list before submission. Don't over-engineer for that goal, but don't actively foreclose it either.

The README is the canonical spec of what each layout looks like and what behavior is intentional vs. a known gap. Read it before changing tiling logic.

## Dev loop

```sh
./dev-reload.sh                  # reload with the LAYOUT currently in main.js
./dev-reload.sh grid             # sed-rewrite LAYOUT → "autoGrid", then reload
./dev-reload.sh center           # sed-rewrite LAYOUT → "centerTile", then reload
./dev-stop.sh                    # unload (stop + teardown in one D-Bus call)

journalctl -f QT_CATEGORY=js QT_CATEGORY=kwin_scripting   # tail logs; look for "[ixtli]"
```

One-time setup (after `git clone`):

```sh
# Symlink the package so KWin sees it
mkdir -p "$HOME/.local/share/kwin/scripts"
ln -s "$PWD" "$HOME/.local/share/kwin/scripts/ixtli"

# Enable the tracked git hooks (.git/hooks/ is not tracked; .githooks/ is)
git config core.hooksPath .githooks

# Install the lint toolchain (ESLint)
npm install
```

The dev box is Fedora Kinoite (rpm-ostree). `shellcheck` isn't shipped on the base image and layering it requires a reboot, so `flake.nix` provides a Nix dev shell with `shellcheck`, `jq`, and `nodejs_22` — same toolchain CI uses:

```sh
nix develop          # enter shell with shellcheck/jq/node available
nix develop -c .githooks/pre-commit    # run the full lint pass one-shot
```

Outside the dev shell, the `pre-commit` hook detects `shellcheck` is missing and skips that check with a warning — so commits still work, you just don't get local shell lint until you enter the shell.

Interactive experimentation: **Alt+F2 → `wm console`** opens KWin's scripting REPL; its output goes to the same journal stream.

## Checks

There is no build or test step — the runtime is KWin itself — but there is lint:

```sh
npm run check         # JSON validity + node --check + ESLint on main.js
npm run lint          # ESLint only
shellcheck dev-reload.sh dev-stop.sh scripts/*.sh .githooks/*
```

These run automatically as `.githooks/pre-commit` (and again as `pre-push`). The same checks plus per-commit message validation run in `.github/workflows/check.yml` on PRs and pushes to main.

**Commit messages must follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)** — `<type>(<scope>)?!?: <subject>` with type ∈ `feat fix docs style refactor perf test build ci chore revert`. The `commit-msg` hook enforces this locally; the workflow re-checks every commit in a PR.

## Packaging

A `.kwinscript` is the install artifact for KWin scripts — a ZIP with `metadata.json` at the root. KDE Store, GitHub releases, and `kpackagetool6` all consume the same file.

```sh
npm run package        # → build/ixtli-<VERSION>.kwinscript
npm run install:local  # kpackagetool6 -t KWin/Script -i build/ixtli-<VERSION>.kwinscript --upgrade
```

`scripts/package.sh` reads `KPlugin.Id` and `KPlugin.Version` from `metadata.json` and zips an **explicit allowlist** — `metadata.json`, `contents/`, `README.md`, `LICENSE`. Dev-only files (`.githooks/`, `flake.nix`, `package.json`, `node_modules/`, etc.) never leak in. Bump `KPlugin.Version` in `metadata.json` to cut a new artifact; the filename tracks it automatically.

`scripts/install-local.sh` is for end-to-end testing the packaged archive (not the dev loop — `./dev-reload.sh` is still the fast inner loop via the symlink). It **refuses** to clobber the dev symlink at `~/.local/share/kwin/scripts/ixtli`; remove the symlink (`rm ~/.local/share/kwin/scripts/ixtli`) to switch to packaged-install mode, re-add it (`ln -s "$PWD" ~/.local/share/kwin/scripts/ixtli`) to switch back.

## Architecture

Single file: `contents/code/main.js` (~360 lines). `metadata.json` is the KPackage manifest KWin reads.

**Runtime model.** This script runs *inside the KWin process* on a QJSEngine. Globals like `workspace`, `KWin`, `print`, and `registerShortcut` are injected by KWin — they are not standard JS. There is no `console`, no `require`/`import`, no `setTimeout` you should rely on. Signals are connected with `.connect(fn)`. Window objects are live Qt objects; properties like `w.frameGeometry`, `w.minimized`, `w.output`, `w.desktops` mutate the WM directly when set. **New KWin globals you introduce in code must also be added to `eslint.config.js`'s `globals` map**, else lint fails with `no-undef`.

**Per-(output, virtualDesktop) queues.** State lives in `queues: Map<string, Window[]>`, keyed by `outputId|desktopId`. Within each queue, the **last `CAP` entries are visible and tiled**; everything before that is "knocked out" (minimized). Eviction is FIFO. Activating a knocked-out window (`onActivated`) promotes it to the end of its queue and the new-oldest is knocked out. `CAP` is per-layout (`autoGrid: 4`, `centerTile: 7`); changing it requires understanding both layouts' geometry functions.

**Layout switching is runtime, with a build-time default.** `LAYOUT` is a `let` at the top of `main.js` (CAP follows it). `cycleLayout()` mutates both and calls `retileAll()`; it's wired to `Meta+Ctrl+Shift+L` via `registerShortcut` in `init()`. `registerShortcut` is a KWin-injected global (also gated by `typeof` in case a build doesn't expose it). The `./dev-reload.sh grid|center` sed-rewrite path still works — it now sets the boot-time default rather than the only mode. Important: `sed -i` writes-and-renames, which would break a symlink — `dev-reload.sh` therefore sed's the **project file**, not the symlinked install path. Both point at the same inode via the symlink when one is set up.

**Event flow.**
- `init()` snapshots existing windows via `workspace.windowList()` (with `clientList()` fallback for older KWin), wires `workspace.windowAdded / windowRemoved / windowActivated / screensChanged / desktopLayoutChanged`, then retiles all queues.
- Each tracked window also gets per-window signal connections in `bindWindow(w)` (idempotent via `w._ixtliBound`): `outputChanged` / `desktopsChanged` trigger `migrate(w)` (untrack from old queue, track in new, retile both); `interactiveMoveResizeStarted/Finished` implement drag-swap.

**Drag-swap.** On move-finished, `handleDrop` computes the dropped window's centroid, finds which tile rect from the current layout's `geometries(n, area)` contains it, and swaps positions in the queue. Drops onto own tile, empty space, or after a *resize* (not a move) snap back via `retileKey`. Resize is detected at start time and discarded — tiles own geometry.

**`isTileable` gate.** Only `normalWindow` top-levels on a single desktop with an output and not fullscreen and not `onAllDesktops` tile. Dialogs, popups, pinned-to-all-desktops windows stay floating. Don't relax this without understanding what KWin classifies as `normalWindow`.

## KWin gotchas worth knowing

- **`loadScript` registers but does NOT run the script.** You must call `run` on the per-script object (`/Scripting/Script${sid}`). `dev-reload.sh` handles this with `busctl`; `unloadScript` is the only call that stops + tears down in one shot.
- **Unmaximize before setting `frameGeometry`,** else KWin's maximize state overrides the assignment. See `applyQueue`: `w.setMaximize(false, false)` precedes `w.frameGeometry = ...`.
- **Geometry snaps; visual transitions are KDE's desktop effects.** The script sets target rects instantly; smoothing comes from System Settings → Workspace Behavior → Desktop Effects. If transitions look janky, that's the effects engine, not the script.
- **No `try`/`catch` around signal callbacks.** A thrown error in a signal handler is silent in the journal beyond a Qt warning — log liberally with the `log()` helper and the `[ixtli]` prefix.
- **`desktops` is an array.** `singleDesktop(w)` returns the desktop only when `w.desktops.length === 1`; windows on all desktops or multi-pinned stay untracked (intentional).
