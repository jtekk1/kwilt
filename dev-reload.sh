#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 jtekk <jtekk@jtekk.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Dev reload for the Kwilt KWin script.
#
# Usage:
#   ./dev-reload.sh             # reload with the currently configured layout
#   ./dev-reload.sh grid        # set Layout=autoGrid in kwinrc, then reload
#   ./dev-reload.sh center      # set Layout=centerTile in kwinrc, then reload
#   ./dev-reload.sh <layout>    # any canonical layout name, then reload
#
# The boot layout lives in kwinrc [Script-kwilt] Layout (read by cfg() at
# script init), not in main.js — switching writes user config, not source.

set -euo pipefail

SCRIPT_NAME="kwilt"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN_JS="${SCRIPT_DIR}/contents/code/main.js"
INSTALLED_PATH="$HOME/.local/share/kwin/scripts/${SCRIPT_NAME}/contents/code/main.js"

if [ ! -f "$MAIN_JS" ]; then
    echo "error: project main.js not found at $MAIN_JS" >&2
    exit 1
fi

if [ ! -f "$INSTALLED_PATH" ]; then
    echo "error: $INSTALLED_PATH not found" >&2
    echo "  symlink the package first:" >&2
    echo "    mkdir -p ~/.local/share/kwin/scripts" >&2
    echo "    ln -s \"\$PWD\" ~/.local/share/kwin/scripts/${SCRIPT_NAME}" >&2
    exit 1
fi

# Optional layout switch — writes kwinrc [Script-kwilt] Layout, which cfg()
# reads at script init. Keep this list in sync with LAYOUT_NAMES in main.js.
LAYOUT_NAMES=(autoGrid centerTile monocle dual leftTile rightTile floating)

set_layout() {
    kwriteconfig6 --file kwinrc --group Script-kwilt --key Layout "$1"
}

case "${1:-}" in
    "")
        ;;
    grid)
        set_layout "autoGrid"
        ;;
    center)
        set_layout "centerTile"
        ;;
    *)
        for name in "${LAYOUT_NAMES[@]}"; do
            if [ "$1" = "$name" ]; then
                set_layout "$name"
                break
            fi
        done
        if [ "$1" != "$name" ]; then
            echo "unknown layout: $1" >&2
            echo "usage: $0 [grid|center|$(IFS='|'; echo "${LAYOUT_NAMES[*]}")]" >&2
            exit 1
        fi
        ;;
esac

current_layout=$(kreadconfig6 --file kwinrc --group Script-kwilt \
    --key Layout --default centerTile)

# Unload. Returns "b false" if the script wasn't loaded — that's fine.
busctl --user call org.kde.KWin /Scripting \
    org.kde.kwin.Scripting unloadScript s "$SCRIPT_NAME" >/dev/null 2>&1 || true

# Load. busctl prints "i <id>"; extract the id.
load_output=$(busctl --user call org.kde.KWin /Scripting \
    org.kde.kwin.Scripting loadScript ss "$INSTALLED_PATH" "$SCRIPT_NAME")
sid=$(awk '{print $2}' <<<"$load_output")

if ! [[ "$sid" =~ ^[0-9]+$ ]]; then
    echo "error: could not parse script id from loadScript output: $load_output" >&2
    exit 1
fi

# Run — loadScript registers but does not auto-start.
busctl --user call org.kde.KWin "/Scripting/Script${sid}" \
    org.kde.kwin.Script run

echo "kwilt loaded as Script${sid} (layout: ${current_layout}) and started."
echo
echo "Tail logs in another terminal:"
echo "  journalctl -f QT_CATEGORY=js QT_CATEGORY=kwin_scripting"
