#!/usr/bin/env bash
# Stop and unload the Ixtli KWin script.
# unloadScript handles stop + teardown in one call.

set -euo pipefail

SCRIPT_NAME="ixtli"

result=$(busctl --user call org.kde.KWin /Scripting \
    org.kde.kwin.Scripting unloadScript s "$SCRIPT_NAME")

case "$result" in
    "b true")
        echo "ixtli stopped and unloaded."
        ;;
    "b false")
        echo "ixtli was not loaded — nothing to do."
        ;;
    *)
        echo "unexpected response from unloadScript: $result" >&2
        exit 1
        ;;
esac
