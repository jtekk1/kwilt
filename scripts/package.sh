#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 jtekk <jtekk@jtekk.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Build the release archives for KWin / KDE Store distribution:
#
#   build/kwilt-<VERSION>.kwinscript                 the KWin script
#   build/dev.jtekk.kwilt.pile-<VERSION>.plasmoid     the Kwilt Pile widget
#   build/dev.jtekk.kwilt.layouts-<VERSION>.plasmoid  the Kwilt Layouts widget
#
# One .plasmoid per directory under widgets/. All are plain ZIPs with metadata.json at the root, installed with
# `kpackagetool6 -t KWin/Script -i <file>` and `-t Plasma/Applet -i <file>`.
# Each ships metadata.json, its runtime contents/ directory and LICENSE (the
# script also README.md) — nothing else from the dev tree (no .githooks,
# package.json, flake.nix, etc.).

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

if ! command -v jq >/dev/null 2>&1; then
    echo "error: jq required to read metadata.json" >&2
    exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
    echo "error: zip required to build the archive" >&2
    exit 1
fi

plugin_id=$(jq -r '.KPlugin.Id' metadata.json)
version=$(jq -r '.KPlugin.Version' metadata.json)

if [ -z "$plugin_id" ] || [ "$plugin_id" = "null" ]; then
    echo "error: could not read KPlugin.Id from metadata.json" >&2
    exit 1
fi

if [ -z "$version" ] || [ "$version" = "null" ]; then
    echo "error: could not read KPlugin.Version from metadata.json" >&2
    exit 1
fi

out_dir="build"
mkdir -p "$out_dir"
out="${out_dir}/${plugin_id}-${version}.kwinscript"
rm -f "$out"

# Explicit allowlist so dev-only files never leak into the package.
zip -r "$out" \
    metadata.json \
    contents \
    README.md \
    LICENSE \
    >/dev/null

echo "wrote ${out} ($(du -h "$out" | cut -f1))"

for dir in widgets/*/; do
    dir=${dir%/}
    widget_id=$(jq -r '.KPlugin.Id' "${dir}/metadata.json")
    widget_version=$(jq -r '.KPlugin.Version' "${dir}/metadata.json")

    # The script and widgets release together under one tag, so their
    # versions move in lockstep.
    if [ "$widget_version" != "$version" ]; then
        echo "error: ${dir}/metadata.json KPlugin.Version (${widget_version}) does not match metadata.json (${version})" >&2
        exit 1
    fi

    widget_out="${out_dir}/${widget_id}-${version}.plasmoid"
    rm -f "$widget_out"

    # zip stores paths relative to the working directory, so build from
    # inside the widget's directory to put its metadata.json at the archive
    # root. LICENSE comes from the repo root via -j (junk the path).
    (cd "$dir" && zip -r "${repo_root}/${widget_out}" metadata.json contents >/dev/null)
    zip -j "$widget_out" LICENSE >/dev/null
    echo "wrote ${widget_out} ($(du -h "$widget_out" | cut -f1))"
done
echo
echo "Install locally for end-to-end testing:"
echo "    npm run install:local"
echo
echo "Inspect contents:"
echo "    unzip -l ${out}"
echo "    unzip -l ${out_dir}/*.plasmoid"
