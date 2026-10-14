Kwilt Layouts picks the Kwilt tiling layout with a click instead of a keyboard shortcut.

It's a companion widget to the Kwilt tiling script. Kwilt has eleven layouts — Auto Grid, Center Tile, Vertical Center, Monocle, Dual, Vertical Dual, Left Tile, Right Tile, Top Tile, Bottom Tile and Floating — each on its own shortcut. This widget lists them all, each with a small sketch of its tiles, master highlighted.

What it does

In a panel: an icon that opens the list. On the desktop: the list directly.
Click a layout to switch to it. The click runs exactly the same action as that layout's shortcut, and Kwilt's on-screen popup confirms the change.
The layout applies to the screen and desktop of the focused window, or, when nothing tiled has the focus, to the screen with the mouse on the current desktop.

The widget doesn't mark the current layout yet: a KWin script can't publish its state to a widget. That's planned for a later release.

Requirements

Plasma 6 and the Kwilt KWin script, enabled. Without Kwilt, the clicks do nothing.

Install

Install from Add or Manage Widgets → Get New Widgets…, or download the .plasmoid and run:

kpackagetool6 -t Plasma/Applet -i dev.jtekk.kwilt.layouts-*.plasmoid

Then right-click a panel → Add or Manage Widgets → Kwilt Layouts. To upgrade a manual install, use -u instead of -i, then log out and back in (Plasma caches widget code).

Beta status

Pre-1.0, released together with Kwilt. Issues and feedback welcome at the GitHub repo.

Source

github.com/jtekk1/kwilt
