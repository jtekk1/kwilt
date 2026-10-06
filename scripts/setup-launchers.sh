#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 jtekk <jtekk@jtekk.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
#
# The author's personal app-launcher bindings — NOT needed to use Kwilt.
# Kwilt itself only manages windows; scripts/setup-shortcuts.sh frees the
# keys its shortcuts use. Edit the install_launcher rows to taste before
# running this on your own machine.
#
#   1. Cleans up stale Ixtli launcher entries left in [kwin] by an
#      earlier main.js (pre-rename, pre-setup-shortcuts). KWin scripts
#      can't reliably spawn processes (callDBus → systemd-run can't
#      marshal StartTransientUnit's ExecStart variant), so launcher
#      bindings moved to KDE's native Custom Shortcuts mechanism —
#      handled in step 3.
#
#   2. Removes pre-rename Ixtli desktop files + kglobalshortcutsrc groups
#      (ixtli-spawn-*.desktop) so they don't double-bind alongside the
#      new Kwilt-prefixed entries from step 3.
#
#   3. Installs 20 hidden .desktop files under ~/.local/share/applications/
#      and binds each to a key via kglobalshortcutsrc. This is the same
#      mechanism System Settings → Shortcuts → Custom Shortcuts uses for
#      "Application" shortcuts. Plasma's launcher menu doesn't show them
#      (NoDisplay=true) — they exist only to be triggered by the key.
#
# Re-runnable safely.

set -euo pipefail

if ! command -v kwriteconfig6 >/dev/null 2>&1; then
    echo "error: kwriteconfig6 not found (Plasma 6 required)" >&2
    exit 1
fi

kgs() {
    kwriteconfig6 --notify --file kglobalshortcutsrc "$@"
}

# --- 1. Strip stale Ixtli launcher entries from [kwin] ---

stale_keys=(
    IxtliLaunchKitty IxtliLaunchFoot IxtliLaunchBitwarden
    IxtliLaunchBtop IxtliLaunchSpf IxtliLaunchHtop IxtliLaunchImpala
    IxtliLaunchSpotify IxtliLaunchNvim IxtliLaunchHelium
    IxtliLaunchBluetui IxtliLaunchWiremix IxtliLaunchYazi
    IxtliWebAudible IxtliWebDiscord IxtliWebGemini IxtliWebNetflix
    IxtliWebUpwork IxtliWebYouTube IxtliWebNerdFonts
)
for key in "${stale_keys[@]}"; do
    kgs --group kwin --key "$key" --delete '' 2>/dev/null || true
done

# --- 2. Remove pre-rename Ixtli .desktop files + their shortcut groups ---
#
# v0.7.0-beta.2 and earlier installed launchers as
# ~/.local/share/applications/ixtli-spawn-*.desktop with kglobalshortcutsrc
# groups [ixtli-spawn-*.desktop]. After the v0.7.1-beta.3 rename to Kwilt,
# step 3 installs kwilt-spawn-*.desktop instead. Sweep the old files and
# their shortcut groups so they don't double-bind keys.

old_desktop_dir="${HOME}/.local/share/applications"
shopt -s nullglob
for old_file in "${old_desktop_dir}"/ixtli-spawn-*.desktop; do
    old_id="$(basename "$old_file")"
    kgs --group "$old_id" --key "_k_friendly_name" --delete '' 2>/dev/null || true
    kgs --group "$old_id" --key "_launch" --delete '' 2>/dev/null || true
    rm -f "$old_file"
done
shopt -u nullglob

# Retired kwilt launchers (slug no longer installed by step 3). Without this
# sweep the old .desktop file + shortcut group would keep binding its key
# alongside the replacement entry. kglobalaccel mirrors the active binding
# into a nested [services][<id>] group at runtime — that copy is the one
# that actually claims the key, so it must be swept too.
retired_slugs=(
    helium    # replaced by chromium (Meta+Shift+T)
)
for slug in "${retired_slugs[@]}"; do
    old_id="kwilt-spawn-${slug}.desktop"
    kgs --group "$old_id" --key "_k_friendly_name" --delete '' 2>/dev/null || true
    kgs --group "$old_id" --key "_launch" --delete '' 2>/dev/null || true
    kgs --group services --group "$old_id" --key "_launch" --delete '' 2>/dev/null || true
    rm -f "${old_desktop_dir}/${old_id}"
done

# --- 3. App launcher .desktop files + kglobalshortcutsrc bindings ---

desktop_dir="${HOME}/.local/share/applications"
mkdir -p "$desktop_dir"

install_launcher() {
    local slug="$1"
    local name="$2"
    local keys="$3"
    local exec="$4"
    local file="${desktop_dir}/kwilt-spawn-${slug}.desktop"

    cat > "$file" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Kwilt: ${name}
Exec=${exec}
NoDisplay=true
Categories=Utility;
X-KDE-StartupNotify=false
DESKTOP

    local id="kwilt-spawn-${slug}.desktop"
    kgs --group "$id" --key "_k_friendly_name" "Kwilt: ${name}"
    kgs --group "$id" --key "_launch" "${keys},none,Launch"
}

# Core launchers
install_launcher "kitty"     "Launch kitty terminal"  "Meta+Return"        "kitty"
install_launcher "foot"      "Launch foot terminal"   "Meta+Shift+Return"  "foot -c ${HOME}/.config/ThemeSwitcher/foot.ini"
install_launcher "bitwarden" "Launch Bitwarden"       "Meta+/"             "bitwarden"

# Native apps (Meta+Shift)
install_launcher "btop"      "Launch btop"            "Meta+Shift+B"       "kitty --title 1280x900 btop"
install_launcher "spf"       "Launch spf"             "Meta+Shift+F"       "kitty --title 1280x900 spf"
install_launcher "htop"      "Launch htop"            "Meta+Shift+H"       "kitty --title 800x600 htop -C"
install_launcher "impala"    "Launch impala"          "Meta+Shift+I"       "kitty --title 800x600 impala"
install_launcher "spotify"   "Launch Spotify"         "Meta+Shift+M"       "spotify-launcher"
install_launcher "nvim"      "Launch nvim"            "Meta+Shift+N"       "kitty --title 1280x900 nvim"
install_launcher "chromium"  "Launch Chromium"        "Meta+Shift+T"       "chromium"
install_launcher "bluetui"   "Launch bluetui"         "Meta+Shift+U"       "kitty --title 800x600 bluetui"
install_launcher "wiremix"   "Launch wiremix"         "Meta+Shift+W"       "kitty --title 800x600 wiremix"
install_launcher "yazi"      "Launch yazi"            "Meta+Shift+Y"       "kitty --title 1280x900 yazi"

# Webapps (Meta+Alt)
install_launcher "audible"   "Audible webapp"         "Meta+Alt+A"         "chromium --app=https://www.audible.com"
install_launcher "discord"   "Discord webapp"         "Meta+Alt+D"         "chromium --app=https://discord.com"
install_launcher "gemini"    "Gemini webapp"          "Meta+Alt+G"         "chromium --app=https://gemini.google.com/gem/a2e9c5b0e7e1"
install_launcher "netflix"   "Netflix webapp"         "Meta+Alt+N"         "chromium --app=https://netflix.com"
install_launcher "upwork"    "Upwork webapp"          "Meta+Alt+U"         "chromium --app=https://upwork.com"
install_launcher "youtube"   "YouTube webapp"         "Meta+Alt+Y"         "chromium --app=https://youtube.com"
install_launcher "nerdfonts" "Nerd Fonts cheatsheet"  "Ctrl+Shift+Space"   "chromium --app=https://www.nerdfonts.com/cheat-sheet"

# --- 4. Refresh KDE service cache so the .desktop files are pickable ---

if command -v kbuildsycoca6 >/dev/null 2>&1; then
    kbuildsycoca6 >/dev/null 2>&1 || true
fi

echo "Kwilt launchers configured:"
echo "  - Any pre-rename ixtli-spawn-*.desktop entries removed"
echo "  - 20 launcher .desktop entries installed under ${desktop_dir}/kwilt-spawn-*.desktop"
echo
echo "Press Meta+Return to test. If nothing fires, log out and back in once"
echo "to let kglobalaccel pick up the changes."
