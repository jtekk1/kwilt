#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 jtekk <jtekk@jtekk.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Install the built .kwinscript and the Kwilt Pile .plasmoid via kpackagetool6.
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
widget_id=$(jq -r '.KPlugin.Id' widget/metadata.json)
widget_archive="build/${widget_id}-${version}.plasmoid"

for f in "$archive" "$widget_archive"; do
    if [ ! -f "$f" ]; then
        echo "error: ${f} not found. Run 'npm run package' first." >&2
        exit 1
    fi
done

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
echo "${verb^} ${plugin_id} ${version}."

# The widget has no dev symlink to protect: the dev path installs it from
# widget/ with kpackagetool6 too, so upgrading over it is safe.
widget_path="${HOME}/.local/share/plasma/plasmoids/${widget_id}"
if [ -d "$widget_path" ]; then
    widget_action="-u"
    widget_verb="upgraded"
else
    widget_action="-i"
    widget_verb="installed"
fi

kpackagetool6 -t Plasma/Applet "$widget_action" "$widget_archive"
echo "${widget_verb^} ${widget_id} ${version}."

echo
echo "Enable the script in: System Settings → Window Management → KWin Scripts."
echo "Add the widget: right-click a panel → Add or Manage Widgets → Kwilt Pile."
echo "Plasma caches widget QML; after an upgrade, run"
echo "    systemctl --user restart plasma-plasmashell"
