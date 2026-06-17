#!/usr/bin/env bash
# Dev reload for the Ixtli KWin script.
#
# Usage:
#   ./dev-reload.sh           # reload with current LAYOUT
#   ./dev-reload.sh grid      # switch to autoGrid, then reload
#   ./dev-reload.sh center    # switch to centerTile, then reload

set -euo pipefail

SCRIPT_NAME="ixtli"
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

# Optional layout switch. We sed the project file directly, not the symlink,
# because `sed -i` writes-and-renames and would break a symlink.
case "${1:-}" in
    "")
        ;;
    grid)
        sed -i 's|^let LAYOUT = "[^"]*"|let LAYOUT = "autoGrid"|' "$MAIN_JS"
        ;;
    center)
        sed -i 's|^let LAYOUT = "[^"]*"|let LAYOUT = "centerTile"|' "$MAIN_JS"
        ;;
    *)
        echo "unknown layout: $1" >&2
        echo "usage: $0 [grid|center]" >&2
        exit 1
        ;;
esac

current_layout=$(grep -oP '^let LAYOUT = "\K[^"]+' "$MAIN_JS" || echo "?")

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

echo "ixtli loaded as Script${sid} (layout: ${current_layout}) and started."
echo
echo "Tail logs in another terminal:"
echo "  journalctl -f QT_CATEGORY=js QT_CATEGORY=kwin_scripting"
