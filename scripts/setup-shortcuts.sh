#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 jtekk <jtekk@jtekk.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Idempotent KDE-side setup for Kwilt's keybindings: frees the keys
# Kwilt's own shortcuts default to.
#
# Disables Plasma KWin defaults that collide with Kwilt's window-management
# shortcuts (Quick Tile on Meta+arrows, Move Window to Screen on
# Meta+Shift+Left/Right, Switch Window on Meta+Alt+arrows, Walk Through
# Windows' Meta+Tab half). The Plasma defaults are preserved as the
# "default" half of each entry so you can revert via System Settings →
# Shortcuts.
#
# App launchers are separate: scripts/setup-launchers.sh.
#
# Re-runnable safely. Writes go through `kwriteconfig6 --notify`; if a key
# still doesn't fire afterwards, log out and back in once.

set -euo pipefail

if ! command -v kwriteconfig6 >/dev/null 2>&1; then
    echo "error: kwriteconfig6 not found (Plasma 6 required)" >&2
    exit 1
fi

# --- Clear conflicting Plasma KWin defaults ---

# Format: "<active>,<default>,<description>". `none` disables the active
# binding while keeping the default intact, so System Settings can revert.

kgs() {
    kwriteconfig6 --notify --file kglobalshortcutsrc "$@"
}

kgs --group kwin --key "Window Quick Tile Left"    "none,Meta+Left,Quick Tile Window to the Left"
kgs --group kwin --key "Window Quick Tile Right"   "none,Meta+Right,Quick Tile Window to the Right"
kgs --group kwin --key "Window Quick Tile Top"     "none,Meta+Up,Quick Tile Window to the Top"
kgs --group kwin --key "Window Quick Tile Bottom"  "none,Meta+Down,Quick Tile Window to the Bottom"
kgs --group kwin --key "Window to Previous Screen" "none,Meta+Shift+Left,Move Window to Previous Screen"
kgs --group kwin --key "Window to Next Screen"     "none,Meta+Shift+Right,Move Window to Next Screen"

# Switch Window <dir> duplicates Kwilt's Meta+arrows focus; clearing it
# frees Meta+Alt+arrows for Kwilt's focus-screen shortcuts.
kgs --group kwin --key "Switch Window Left"  "none,Meta+Alt+Left,Switch to Window to the Left"
kgs --group kwin --key "Switch Window Right" "none,Meta+Alt+Right,Switch to Window to the Right"
kgs --group kwin --key "Switch Window Up"    "none,Meta+Alt+Up,Switch to Window Above"
kgs --group kwin --key "Switch Window Down"  "none,Meta+Alt+Down,Switch to Window Below"

# Walk Through Windows holds two keys joined by a real tab character:
# "Alt+Tab<TAB>Meta+Tab". Preserve Alt+Tab (you almost certainly want it)
# and strip just Meta+Tab so Kwilt's KwiltCycleFocus can claim it. We pass
# the tab via $'\t' so it's a real 0x09 byte; kwriteconfig6 round-trips it
# through KConfig's escaping, which writes it back as a literal "\t" in
# the file — matching the format Plasma originally wrote.
TAB=$'\t'
kgs --group kwin --key "Walk Through Windows"           "Alt+Tab,Alt+Tab${TAB}Meta+Tab,Walk Through Windows"
kgs --group kwin --key "Walk Through Windows (Reverse)" "Alt+Shift+Tab,Alt+Shift+Tab${TAB}Meta+Shift+Tab,Walk Through Windows (Reverse)"

echo "Kwilt shortcut conflicts cleared:"
echo "  - 12 Plasma KWin defaults disabled (Quick Tile, Move to Screen, Switch Window, Meta+Tab from Walk Through)"
echo "  - Written to ~/.config/kglobalshortcutsrc"
echo
echo "If a Kwilt key still doesn't fire, log out and back in once so"
echo "kglobalaccel picks up the changes."
