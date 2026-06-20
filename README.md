# Kwilt

Personal KWin tiling script.

> **Renamed from Ixtli in v0.7.1-beta.3.** If you have v0.7.0-beta.2 or earlier installed, see [Migrating from Ixtli](#migrating-from-ixtli) below before installing.

## Layouts

Selected via the `LAYOUT` constant at the top of `contents/code/main.js`. Two are implemented:

### `centerTile` (current default; cap = 9)

40% center column, 30% left and right. Sides grow downward as windows are added; when side counts are uneven, **left fills first**.

| N | Layout |
|---|---|
| 1 | centered 85% column (full height) |
| 2 | left half / right half (intentional break from center+side) |
| 3 | left 30% / center 40% / right 30% |
| 4 | center / left split 1/2 height / right full / left-bot |
| 5 | center / left 1/2 / right 1/2 / left-bot / right-bot |
| 6 | center / left 1/3 / right 1/2 / left-mid / right-bot / left-bot |
| 7 | center / left 1/3 / right 1/3 / left-mid / right-mid / left-bot / right-bot |
| 8 | center / 4 left (quarters) / 3 right (thirds) — asymmetric, left fills first |
| 9 | center / 4 left (quarters) / 4 right (quarters) |
| 10+ | oldest knocked out — visible cap is 9 |

### `autoGrid` (cap = 12)

Pattern: while N is below the next perfect grid (2x2, 2x3, 3x3, 3x4), W1 spans the full left column; once N hits the perfect grid, every cell equalizes.

| N | Layout |
|---|---|
| 1 | full work area |
| 2 | left half / right half |
| 3 | 2x2 frame; W1 spans full left column |
| 4 | TL / TR / BR / BL (clockwise — intentional break from row-major) |
| 5 | 2x3 frame; W1 spans full left column, W2..W5 fill the right 2x2 |
| 6 | 2x3 grid (row-major) |
| 7 | 3x3 frame; W1 spans full left column, W2..W7 fill the right 2x3 |
| 8 | 3x3 frame; W1 spans top 2 rows of left column, bottom row is a normal 3-cell strip |
| 9 | 3x3 grid (row-major) |
| 10 | 3x4 frame; W1 spans full left column, W2..W10 fill the right 3x3 |
| 11 | 3x4 frame; W1 spans top 2 rows of left column, bottom row is a normal 4-cell strip |
| 12 | 3x4 grid (row-major) |
| 13+ | oldest is knocked out (minimized) — visible cap is 12 |

### `monocle` (cap = 1)

One window visible at full work area; everything else is knocked out. Alt-tab onto a knocked window to promote it. Useful for focus mode / presentations.

| N | Layout |
|---|---|
| 1 | full work area |
| 2+ | one visible, all others knocked out (alt-tab cycles) |

### `dual` (cap = 2)

At most two windows visible, side-by-side. Adding a 3rd window knocks out the oldest. Useful for diff views, paired apps, doc + IDE.

| N | Layout |
|---|---|
| 1 | full work area |
| 2 | left half / right half |
| 3+ | oldest is knocked out — visible cap is 2 |

### Shared behavior

- Only `normalWindow` top-levels tile. Dialogs, popups, fullscreen, multi-desktop windows stay floating.
- Activating a knocked-out window (alt-tab onto it) promotes it back into the visible set; the new-oldest is knocked out in its place.
- Dragging a tiled window onto another tile swaps them. Drag onto empty/own tile or resize → snap back.

## Configuration

Two equivalent paths — both read/write `~/.config/kwinrc` under `[Script-kwilt]`.

**GUI** — System Settings → Window Management → KWin Scripts → click the gear icon next to *Kwilt* (or the *Configure* button, depending on Plasma version). Form built from `contents/ui/config.ui` against the kcfg schema in `contents/config/main.xml`. **Apply** writes the kwinrc keys; values take effect on the next script reload (toggle Kwilt off and on in the same dialog, or relogin).

**CLI / scriptable** — change values directly and reload:

| Key | Type | Default | Range | Notes |
|---|---|---|---|---|
| `Layout` | string | `centerTile` | `centerTile` / `autoGrid` / `monocle` / `dual` | Boot-time layout. `Meta+Ctrl+Shift+L` cycles at runtime. |
| `CapAutoGrid` | int | `12` | `1`–`12` | Visible cap before knockout in autoGrid. |
| `CapCenterTile` | int | `9` | `1`–`9` | Visible cap before knockout in centerTile. |
| `CenterTileWidth1` | float | `0.85` | `0.5`–`1.0` | N=1 column width as fraction of work area in centerTile. |
| `CenterTileSideWidth` | float | `0.30` | `0.15`–`0.45` | Each side column's width fraction at N=3+ in centerTile; center absorbs the rest. |
| `OuterGap` | int | `0` | `0`–`80` | Pixels between any tile edge and the work area edge. `0` = flush to the screen. |
| `InnerGap` | int | `0` | `0`–`80` | Pixels between adjacent tiles. Split halved on each side; odd values round consistently so adjacent gaps sum exactly. |
| `BorderlessWhenTiled` | bool | `false` | `true` / `false` | Hide window decorations on visible tiles by setting `noBorder`. Original border state is saved per-window and restored on untrack/close/fullscreen. |
| `AlwaysFloat` | string | `""` | comma-separated | Substrings matched (case-insensitive) against each window's `resourceClass` and `resourceName`. Matches are never tiled (e.g. `kcalc, pavucontrol, plasma-systemmonitor`). |

Set via:

```sh
kwriteconfig6 --file kwinrc --group Script-kwilt --key Layout autoGrid
kwriteconfig6 --file kwinrc --group Script-kwilt --key CenterTileWidth1 0.9
./dev-reload.sh
```

Out-of-range values are clamped to the listed range. Invalid `Layout` strings fall back to `centerTile`.
- Geometry snaps. Visual transitions rely on KDE's built-in desktop effects (System Settings → Workspace Behavior → Desktop Effects).

## Install

**As a user — packaged release.** Grab the latest `.kwinscript` from the [Releases tab](../../releases) and install it:

```sh
kpackagetool6 -t KWin/Script -i kwilt-*.kwinscript
```

Then enable in **System Settings → Window Management → KWin Scripts** and run `scripts/setup-shortcuts.sh` once to seed app-launcher bindings + clear conflicting Plasma defaults.

**As a developer — repo symlink** for fast inner-loop iteration:

```sh
mkdir -p "$HOME/.local/share/kwin/scripts"
ln -s "$PWD" "$HOME/.local/share/kwin/scripts/kwilt"
```

The repo symlink and the `kpackagetool6` install **conflict** at the same path — `scripts/install-local.sh` refuses to clobber the symlink. Pick one mode at a time.

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

Look for `[kwilt]` lines. The KWin Scripting Console (`Alt+F2` → `wm console`) is also available for one-off experiments; its output goes to the same journal stream.

## Migrating from Ixtli

v0.7.1-beta.3 renames the plugin Id and display name. Existing users on v0.7.0-beta.2 or earlier need a one-time cleanup before the new install will pick up cleanly:

```sh
# 1. Remove the old packaged install (no-op if you never ran install-local).
kpackagetool6 -t KWin/Script -r ixtli 2>/dev/null || true

# 2. Replace the dev symlink, if you use one.
rm -f "$HOME/.local/share/kwin/scripts/ixtli"
ln -s "$PWD" "$HOME/.local/share/kwin/scripts/kwilt"

# 3. Migrate config from [Script-ixtli] to [Script-kwilt].
#    Keys to copy: Layout, CapAutoGrid, CapCenterTile, CenterTileWidth1,
#    CenterTileSideWidth, OuterGap, InnerGap, BorderlessWhenTiled, AlwaysFloat.
#    Example for one key:
old=$(kreadconfig6 --file kwinrc --group Script-ixtli --key Layout --default '')
[ -n "$old" ] && kwriteconfig6 --file kwinrc --group Script-kwilt --key Layout "$old"
kwriteconfig6 --file kwinrc --group Script-ixtli --key Layout --delete ''

# 4. Re-run setup-shortcuts.sh — it now sweeps old ixtli-spawn-*.desktop
#    files and their kglobalshortcutsrc groups before installing the
#    kwilt-spawn-*.desktop entries.
./scripts/setup-shortcuts.sh
```

A logout + login picks up the new bindings cleanly.

## Known gaps

- User maximizing/fullscreening a tiled window doesn't auto-untile.
- Windows on all desktops (or pinned to multiple desktops) stay floating.
- Knocked-out pile has no tab UI yet.

## Shortcuts

Kwilt registers its **window-management** shortcuts directly. **App launchers** live in KDE's native Custom Shortcuts mechanism — KWin scripts can't spawn processes (no exec API; `callDBus` → systemd-run can't marshal the nested-variant `ExecStart` arg cleanly). Both are configured in one shot by `scripts/setup-shortcuts.sh`, which:

1. Disables Plasma KWin defaults that collide with Kwilt's bindings (Quick Tile on `Meta+arrows`, Move Window to Screen on `Meta+Shift+Left/Right`, and the `Meta+Tab` half of Walk Through Windows — `Alt+Tab` is preserved).
2. Installs hidden `.desktop` files under `~/.local/share/applications/kwilt-spawn-*.desktop` for each launcher.
3. Binds each `.desktop` to a key via `~/.config/kglobalshortcutsrc`.

Run it once after installing the script package:

```sh
./scripts/setup-shortcuts.sh
```

Re-runnable safely. After running, log out and back in once if a shortcut doesn't fire — `kglobalaccel` sometimes needs the session restart to pick up new bindings.

### Window management (in main.js)

| Default | Action |
|---|---|
| `Meta+Ctrl+Shift+L` | Cycle window layout (autoGrid → centerTile → monocle → dual) |
| `Meta+Ctrl+G` | Set layout: autoGrid |
| `Meta+Ctrl+C` | Set layout: centerTile |
| `Meta+Ctrl+M` | Set layout: monocle |
| `Meta+Ctrl+D` | Set layout: dual |
| `Meta+Ctrl+Shift+R` | Rebuild tile queues from current windows (ghost-slot recovery) |
| `Meta+Left/Right/Up/Down` | Focus tile in that direction |
| `Meta+Shift+Left/Right/Up/Down` | Swap focused window with neighbor in that direction |
| `Meta+Tab` | Cycle focus through visible tiles |
| `Meta+U` | Focus most-recently-focused window (toggle) |

Rebind in **System Settings → Shortcuts → KWin** (search for `Kwilt:`).

### App launchers (via setup-shortcuts.sh)

| Default | Action |
|---|---|
| `Meta+Return` | `kitty` |
| `Meta+Shift+Return` | `foot -c $HOME/.config/ThemeSwitcher/foot.ini` |
| `Meta+/` | `bitwarden` |
| `Meta+Shift+B/F/H/I/M/N/T/U/W/Y` | btop / spf / htop / impala / spotify / nvim / helium / bluetui / wiremix / yazi (kitty-wrapped where applicable) |
| `Meta+Alt+A/D/G/N/U/Y` | Helium webapps: Audible / Discord / Gemini / Netflix / Upwork / YouTube |
| `Ctrl+Shift+Space` | Nerd Fonts cheatsheet (Helium webapp) |

Rebind in **System Settings → Shortcuts → Custom Shortcuts** (entries named `Kwilt: …`). To remove all launcher bindings, delete the `kwilt-spawn-*.desktop` files and the matching groups in `kglobalshortcutsrc`.
