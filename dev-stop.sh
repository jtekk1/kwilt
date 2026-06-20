#!/usr/bin/env bash
# Stop and unload the Kwilt KWin script.
# unloadScript handles stop + teardown in one call.

set -euo pipefail

SCRIPT_NAME="kwilt"

result=$(busctl --user call org.kde.KWin /Scripting \
    org.kde.kwin.Scripting unloadScript s "$SCRIPT_NAME")

case "$result" in
    "b true")
        echo "kwilt stopped and unloaded."
        ;;
    "b false")
        echo "kwilt was not loaded — nothing to do."
        ;;
    *)
        echo "unexpected response from unloadScript: $result" >&2
        exit 1
        ;;
esac
