Kwilt is a KWin tiling script for Plasma 6. Every (output, virtual desktop) pair gets its own independent window queue, layout choice, master pin, and per-column resize state — different monitors and different virtual desktops keep independent tiling behavior. Switch desktops or unplug a monitor and Kwilt re-flows each screen in place.

Layouts

Seven layouts, switchable at runtime with Meta+Ctrl+Shift+L or bound directly. Each (output, virtualDesktop) remembers its own layout choice:

autoGrid (cap 12) — smooth progression from one window to a 3×4 grid. At every "in-between" count the first window spans the full left column; on perfect grids (2×2, 2×3, 3×3, 3×4) every cell equalizes.
centerTile (cap 9) — center master column at MasterWidth (default 50%), side columns share the rest. Side columns grow downward; left fills first when uneven.
leftTile (cap 9, tunable) — master column anchored to the left; non-master area to the right splits into 1 or 2 columns (auto by aspect ratio, or forced via NonMasterColumns).
rightTile (cap 9, tunable) — mirror of leftTile with master on the right.
monocle (cap 1) — one window full-screen, the rest knocked out and one alt-tab away. Focus mode / presentations.
dual (cap 2) — at most two windows side-by-side. Diff views, doc + IDE, paired apps.
floating (no tiling) — escape hatch. Kwilt leaves every window on that (output, virtualDesktop) alone until you switch back to a tiling layout.

Caps default to 9 or 12 (per layout) and accept 0 = unlimited. autoGrid and centerTile fall back to their natural max (geometry defined for N=1..12 / N=1..9); leftTile and rightTile scale to arbitrary N.

Excess windows are "knocked out" (minimized) FIFO — activating a knocked-out window promotes it back into the visible set. The master slot is exempt from cap eviction: overflow drops the second-oldest visible window instead, so the master seat only changes when you promote something into it.

Master pin

Meta+S toggles a master pin on the active window. The pinned window claims the master slot on its (output, virtualDesktop) — center in centerTile, top-left in autoGrid, left in dual, master column in leftTile / rightTile. The pin is sticky under drag-swap, survives layout switches, and travels with the window when moved across outputs / desktops.

Float toggle

Meta+\ toggles a per-window float on the active window — a floated window is ignored by tiling until you toggle it back. Meta+Ctrl+F does the same at layout scope: switches the active (output, virtualDesktop) to the `floating` layout so nothing on that key tiles until you pick a tiling layout again.

Keybindings

All defaults are rebindable in System Settings → Shortcuts → KWin (search for `Kwilt:`).

Layout — act on the active (output, virtualDesktop):
  Meta + Ctrl + Shift + L    cycle through the seven layouts
  Meta + Ctrl + G            autoGrid
  Meta + Ctrl + C            centerTile
  Meta + Ctrl + M            monocle
  Meta + Ctrl + D            dual
  Meta + Ctrl + L            leftTile
  Meta + Ctrl + T            rightTile   (T because Meta+Ctrl+R is claimed by Spectacle)
  Meta + Ctrl + F            floating

Focus:
  Meta + Left/Right/Up/Down  focus the tile in that direction
  Meta + Tab                 cycle focus through visible tiles
  Meta + U                   focus the most-recently-focused window (toggle)

Move / swap:
  Meta + Shift + Arrows      swap with the neighbor in that direction
  Drag tile onto tile        swap positions (drag onto empty / own tile → snaps back)

Master & float:
  Meta + S                   toggle master pin on the active window
  Meta + \                   toggle float on the active window (opt out of tiling)

Utility:
  Meta + Ctrl + Shift + R    rebuild tile queues from current windows (ghost-slot recovery)

Mouse resize

Resizing a tiled window (Meta+Right-drag on Plasma defaults, or grab the border) adjusts the layout in place:

Master boundary — the horizontal edge between master and non-master area → updates MasterWidth (unified across centerTile, leftTile, rightTile).
Inter-column boundary — between the inner and outer non-master columns in leftTile / rightTile 2-col mode → updates the per-key inter-column split.
Vertical edges — between windows stacked in a column → updates the per-column row-height ratios.

Persistence (optional)

By default, everything you tune at runtime — mouse-resize state (MasterWidth, row splits, inter-column splits) and per-(output, virtualDesktop) layout overrides — lives in memory only and resets on script reload. KWin's script API can read config but not write it, so persistence needs a small helper.

Kwilt ships one: `scripts/install-persistence.sh` (in the git repo) installs a session-bus D-Bus daemon that shells out to `kwriteconfig6` when Kwilt calls it. Run it once and everything above survives reloads and relogins. Skip it and Kwilt still runs — you just get the session-only behavior.

Configurable

Tunables live in kwinrc [Script-kwilt] and ship with a Configure dialog in System Settings → Window Management → KWin Scripts:

Layout — default layout for new (output, virtualDesktop) combos (any of the seven)
CapAutoGrid / CapCenterTile / CapLeftTile / CapRightTile — visible cap before knockout (per layout); 0 = unlimited
MasterWidth — unified master column fraction (centerTile / leftTile / rightTile); default 0.5, range 0.15–0.85
NonMasterColumns — leftTile / rightTile non-master column count; 0 = auto (aspect ratio > 2:1 → 2, else 1), or 1 / 2 explicit
OuterGap / InnerGap — pixel gaps between tiles and the work-area edge
BorderlessWhenTiled — strip window decorations on tiled windows
AlwaysFloat — comma-separated substring matches against resourceClass / resourceName (e.g. kcalc, pavucontrol, plasma-systemmonitor); matches never tile

Install

Download the .kwinscript, then:

kpackagetool6 -t KWin/Script -i kwilt-*.kwinscript

Enable in System Settings → Window Management → KWin Scripts. Optional: clone the git repo and run `scripts/setup-shortcuts.sh` once to seed app-launcher bindings and clear Plasma KWin defaults that collide with the focus/swap shortcuts (Quick Tile on Meta+arrows, Move Window to Screen on Meta+Shift+Left/Right, and the Meta+Tab half of Walk Through Windows). Run `scripts/install-persistence.sh` in the same clone to enable persistent resize / layout state.

Beta status

Pre-1.0 — the layouts and shortcuts are stable, but config schema may still shift before 1.0. Issues and feedback welcome at the GitHub repo.

Source

github.com/jtekk1/kwilt
