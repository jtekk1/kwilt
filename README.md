# Ixtli

Personal KWin tiling script.

## Layouts

Selected via the `LAYOUT` constant at the top of `contents/code/main.js`. Two are implemented:

### `centerTile` (current default; cap = 7)

40% center column, 30% left and right. Sides grow downward as windows are added.

| N | Layout |
|---|---|
| 1 | centered 80% column (full height) |
| 2 | left half / right half (intentional break from center+side) |
| 3 | left 30% / center 40% / right 30% |
| 4 | center / left split 1/2 height / right full / left-bot |
| 5 | center / left 1/2 / right 1/2 / left-bot / right-bot |
| 6 | center / left 1/3 / right 1/2 / left-mid / right-bot / left-bot |
| 7 | center / left 1/3 / right 1/3 / left-mid / right-mid / left-bot / right-bot |
| 8+ | oldest knocked out — visible cap is 7 |

### `autoGrid` (cap = 4)

| N | Layout |
|---|---|
| 1 | full work area |
| 2 | left half / right half |
| 3 | left full-height / right top / right bottom |
| 4 | TL / TR / BR / BL (clockwise) |
| 5+ | oldest is knocked out (minimized) — visible cap is 4 |

### Shared behavior

- Only `normalWindow` top-levels tile. Dialogs, popups, fullscreen, multi-desktop windows stay floating.
- Activating a knocked-out window (alt-tab onto it) promotes it back into the visible set; the new-oldest is knocked out in its place.
- Dragging a tiled window onto another tile swaps them. Drag onto empty/own tile or resize → snap back.
- Geometry snaps. Visual transitions rely on KDE's built-in desktop effects (System Settings → Workspace Behavior → Desktop Effects).

## Install (development)

One-time symlink so KWin sees the package:

```sh
mkdir -p "$HOME/.local/share/kwin/scripts"
ln -s "$PWD" "$HOME/.local/share/kwin/scripts/ixtli"
```

## Dev loop

```sh
./dev-reload.sh          # reload with current LAYOUT
./dev-reload.sh grid     # switch to autoGrid, then reload
./dev-reload.sh center   # switch to centerTile, then reload
./dev-stop.sh            # stop and unload
```

`dev-reload.sh` with a layout argument sed-rewrites the `LAYOUT` declaration in `main.js`, then reloads — so the source reflects the boot default (and `git diff` shows what you last ran). Runtime switching is via the `Meta+Ctrl+Shift+L` shortcut.

Important: KWin's `loadScript` over D-Bus **registers but doesn't start** the script — `run` must be called on the per-script object. `dev-reload.sh` handles this; `dev-stop.sh` calls `unloadScript`, which stops and removes in one call.

## Logs

```sh
journalctl -f QT_CATEGORY=js QT_CATEGORY=kwin_scripting
```

Look for `[ixtli]` lines. The KWin Scripting Console (`Alt+F2` → `wm console`) is also available for one-off experiments; its output goes to the same journal stream.

## Known gaps

- User maximizing/fullscreening a tiled window doesn't auto-untile.
- No config file — boot-time `LAYOUT` and per-layout caps are constants in `main.js`. Set the boot default via `./dev-reload.sh grid|center`; cycle at runtime with the shortcut below.
- Windows on all desktops (or pinned to multiple desktops) stay floating.
- Knocked-out pile has no tab UI yet.

## Shortcuts

Ixtli registers its **window-management** shortcuts directly. **App launchers** live in KDE's native Custom Shortcuts mechanism — KWin scripts can't spawn processes (no exec API; `callDBus` → systemd-run can't marshal the nested-variant `ExecStart` arg cleanly). Both are configured in one shot by `scripts/setup-shortcuts.sh`, which:

1. Disables Plasma KWin defaults that collide with Ixtli's bindings (Quick Tile on `Meta+arrows`, Move Window to Screen on `Meta+Shift+Left/Right`, and the `Meta+Tab` half of Walk Through Windows — `Alt+Tab` is preserved).
2. Installs hidden `.desktop` files under `~/.local/share/applications/ixtli-spawn-*.desktop` for each launcher.
3. Binds each `.desktop` to a key via `~/.config/kglobalshortcutsrc`.

Run it once after installing the script package:

```sh
./scripts/setup-shortcuts.sh
```

Re-runnable safely. After running, log out and back in once if a shortcut doesn't fire — `kglobalaccel` sometimes needs the session restart to pick up new bindings.

### Window management (in main.js)

| Default | Action |
|---|---|
| `Meta+Ctrl+Shift+L` | Cycle window layout (centerTile ↔ autoGrid) |
| `Meta+Ctrl+G` | Set layout: autoGrid |
| `Meta+Ctrl+C` | Set layout: centerTile |
| `Meta+Left/Right/Up/Down` | Focus tile in that direction |
| `Meta+Shift+Left/Right/Up/Down` | Swap focused window with neighbor in that direction |
| `Meta+Tab` | Cycle focus through visible tiles |
| `Meta+U` | Focus most-recently-focused window (toggle) |

Rebind in **System Settings → Shortcuts → KWin** (search for `Ixtli:`).

### App launchers (via setup-shortcuts.sh)

| Default | Action |
|---|---|
| `Meta+Return` | `kitty` |
| `Meta+Shift+Return` | `foot -c $HOME/.config/ThemeSwitcher/foot.ini` |
| `Meta+/` | `bitwarden` |
| `Meta+Shift+B/F/H/I/M/N/T/U/W/Y` | btop / spf / htop / impala / spotify / nvim / helium / bluetui / wiremix / yazi (kitty-wrapped where applicable) |
| `Meta+Alt+A/D/G/N/U/Y` | Helium webapps: Audible / Discord / Gemini / Netflix / Upwork / YouTube |
| `Ctrl+Shift+Space` | Nerd Fonts cheatsheet (Helium webapp) |

Rebind in **System Settings → Shortcuts → Custom Shortcuts** (entries named `Ixtli: …`). To remove all launcher bindings, delete the `ixtli-spawn-*.desktop` files and the matching groups in `kglobalshortcutsrc`.
