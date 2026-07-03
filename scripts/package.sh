#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 jtekk <jtekk@jtekk.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Build a .kwinscript archive for KWin / KDE Store distribution.
#
# A .kwinscript is just a ZIP with metadata.json at the root. KWin installs it
# via `kpackagetool6 -t KWin/Script -i <file>`. We ship metadata.json, the
# runtime contents/ directory, README.md, and LICENSE — nothing else from the
# dev tree (no .githooks, package.json, flake.nix, etc.).

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

size=$(du -h "$out" | cut -f1)
echo "wrote ${out} (${size})"
echo
echo "Install locally for end-to-end testing:"
echo "    npm run install:local"
echo
echo "Inspect contents:"
echo "    unzip -l ${out}"
