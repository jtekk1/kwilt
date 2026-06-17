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

One-time setup (symlink so KWin sees the package):

```sh
mkdir -p "$HOME/.local/share/kwin/scripts"
ln -s "$PWD" "$HOME/.local/share/kwin/scripts/ixtli"
```

Interactive experimentation: **Alt+F2 → `wm console`** opens KWin's scripting REPL; its output goes to the same journal stream.

There is no build, lint, or test step. The runtime is KWin itself.

## Architecture

Single file: `contents/code/main.js` (~360 lines). `metadata.json` is the KPackage manifest KWin reads.

**Runtime model.** This script runs *inside the KWin process* on a QJSEngine. Globals like `workspace`, `KWin`, and `print` are injected by KWin — they are not standard JS. There is no `console`, no `require`/`import`, no `setTimeout` you should rely on. Signals are connected with `.connect(fn)`. Window objects are live Qt objects; properties like `w.frameGeometry`, `w.minimized`, `w.output`, `w.desktops` mutate the WM directly when set.

**Per-(output, virtualDesktop) queues.** State lives in `queues: Map<string, Window[]>`, keyed by `outputId|desktopId`. Within each queue, the **last `CAP` entries are visible and tiled**; everything before that is "knocked out" (minimized). Eviction is FIFO. Activating a knocked-out window (`onActivated`) promotes it to the end of its queue and the new-oldest is knocked out. `CAP` is per-layout (`autoGrid: 4`, `centerTile: 7`); changing it requires understanding both layouts' geometry functions.

**Layout switching is build-time.** `LAYOUT` is a `const` at the top of `main.js`. There is no in-script switching shortcut; `dev-reload.sh grid|center` rewrites the constant with `sed` and reloads. Important: `sed -i` writes-and-renames, which would break the symlink — `dev-reload.sh` therefore sed's the **project file**, not the symlinked install path. Both point at the same inode via the symlink.

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
