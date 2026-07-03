#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 jtekk <jtekk@jtekk.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Install the built .kwinscript via kpackagetool6.
#
# This is the end-to-end install path — the real one a user would take. It is
# NOT the dev loop (./dev-reload.sh handles that via the symlink and a busctl
# loadScript+run dance). Use this to verify the packaged archive itself is
# valid before shipping.

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

if ! command -v kpackagetool6 >/dev/null 2>&1; then
    echo "error: kpackagetool6 not found. Install Plasma 6 dev tools." >&2
    exit 1
fi

plugin_id=$(jq -r '.KPlugin.Id' metadata.json)
version=$(jq -r '.KPlugin.Version' metadata.json)
archive="build/${plugin_id}-${version}.kwinscript"

if [ ! -f "$archive" ]; then
    echo "error: ${archive} not found. Run 'npm run package' first." >&2
    exit 1
fi

# The dev symlink (./dev-reload.sh's install path) lives where kpackagetool6
# would write. Refuse rather than clobber — the user must consciously switch
# modes.
install_path="${HOME}/.local/share/kwin/scripts/${plugin_id}"
if [ -L "$install_path" ]; then
    echo "error: ${install_path} is a dev symlink." >&2
    echo "Remove it before installing the packaged version:" >&2
    echo "    rm '${install_path}'" >&2
    echo "Re-add it later with:" >&2
    echo "    ln -s \"\$PWD\" '${install_path}'" >&2
    exit 1
fi

# kpackagetool6's -i and -u are sibling actions that each take a path
# argument (NOT a flag on -i). Pick one based on whether the plugin is
# already installed; otherwise -i errors with "already exists".
if [ -d "$install_path" ]; then
    action="-u"
    verb="upgraded"
else
    action="-i"
    verb="installed"
fi

kpackagetool6 -t KWin/Script "$action" "$archive"
echo
echo "${verb^} ${plugin_id} ${version}."
echo "Enable in: System Settings → Window Management → KWin Scripts."
