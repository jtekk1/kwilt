Kwilt Pile lists the minimized windows on its screen, the current virtual desktop and the current activity, and brings any of them back with one click.

It's the companion widget to the Kwilt tiling script. Each Kwilt layout has a cap on how many windows it shows; past the cap, Kwilt minimizes ("knocks out") the oldest. Kwilt Pile shows that pile, plus anything you minimized yourself, so nothing gets lost.

What it does

In a panel: the Kwilt logo with a badge counting the minimized windows; click it for the list. With nothing minimized the icon dims, and the system tray can hide it.
On the desktop: the list directly.
Click a window to bring it back. Kwilt tiles it again in place of the oldest visible window, just as alt-tabbing to it would.

The list follows Kwilt's own scope: one widget per screen shows that screen's windows, on the current desktop and activity.

Requirements

Plasma 6. The Kwilt KWin script is optional but is what the widget is made for; without it, Kwilt Pile is simply a list of minimized windows.

Install

Install from Add or Manage Widgets → Get New Widgets…, or download the .plasmoid and run:

kpackagetool6 -t Plasma/Applet -i dev.jtekk.kwilt.pile-*.plasmoid

Then right-click a panel → Add or Manage Widgets → Kwilt Pile. To upgrade a manual install, use -u instead of -i, then log out and back in (Plasma caches widget code).

Beta status

Pre-1.0, released together with Kwilt. Issues and feedback welcome at the GitHub repo.

Source

github.com/jtekk1/kwilt
