#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 jtekk <jtekk@jtekk.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Install the Kwilt config-writer D-Bus helper. Run once per user account.
#
# Without this: Kwilt still runs, but state changes (MasterWidth from mouse
# resize, per-monitor layout overrides, row-split ratios, inter-column split)
# stay in memory and are lost on script reload.
#
# With this: those state changes get persisted to kwinrc [Script-kwilt] via a
# small Python daemon (kwilt-config-writer.py) that Kwilt reaches over D-Bus.
# The daemon is D-Bus-activated on demand and managed by systemd.
#
# Removal: ./scripts/install-persistence.sh --uninstall

set -euo pipefail

BUS_NAME="dev.jtekk.KwiltConfigWriter"
UNIT_NAME="kwilt-config-writer.service"

# --- Paths ---

install_dir="${HOME}/.local/share/kwilt"
dbus_dir="${HOME}/.local/share/dbus-1/services"
systemd_dir="${HOME}/.config/systemd/user"

daemon_dst="${install_dir}/kwilt-config-writer.py"
dbus_service="${dbus_dir}/${BUS_NAME}.service"
systemd_unit="${systemd_dir}/${UNIT_NAME}"

# --- Uninstall ---

if [[ "${1-}" == "--uninstall" ]]; then
    systemctl --user disable --now "${UNIT_NAME}" 2>/dev/null || true
    rm -f "${systemd_unit}" "${dbus_service}" "${daemon_dst}"
    systemctl --user daemon-reload
    rmdir "${install_dir}" 2>/dev/null || true
    echo "Kwilt persistence helper removed."
    exit 0
fi

# --- Preflight ---

if ! command -v python3 >/dev/null 2>&1; then
    echo "error: python3 not found" >&2
    exit 1
fi

if ! python3 -c "import dbus" >/dev/null 2>&1; then
    echo "error: python3-dbus (dbus-python) is required." >&2
    echo "  Fedora:     sudo dnf install python3-dbus" >&2
    echo "  Kinoite:    rpm-ostree install python3-dbus  (needs reboot)" >&2
    echo "  Debian/Ubu: sudo apt install python3-dbus" >&2
    echo "  Arch:       sudo pacman -S python-dbus" >&2
    exit 1
fi

if ! command -v kwriteconfig6 >/dev/null 2>&1; then
    echo "error: kwriteconfig6 not found (Plasma 6 required)" >&2
    exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
daemon_src="${script_dir}/kwilt-config-writer.py"

if [[ ! -f "${daemon_src}" ]]; then
    echo "error: kwilt-config-writer.py not found next to install-persistence.sh" >&2
    exit 1
fi

# --- Install daemon ---

mkdir -p "${install_dir}"
cp "${daemon_src}" "${daemon_dst}"
chmod +x "${daemon_dst}"

# --- D-Bus session activation file ---
#
# SystemdService= makes D-Bus hand activation to systemd instead of forking
# the ExecStart directly. That way the daemon gets the same lifecycle,
# logging, and restart behavior whether it comes up on demand (Kwilt makes
# a call) or at login (default.target).

mkdir -p "${dbus_dir}"
cat > "${dbus_service}" <<DBUS
[D-BUS Service]
Name=${BUS_NAME}
Exec=/usr/bin/python3 ${daemon_dst}
SystemdService=${UNIT_NAME}
DBUS

# --- Systemd user unit ---

mkdir -p "${systemd_dir}"
cat > "${systemd_unit}" <<UNIT
[Unit]
Description=Kwilt config-writer helper (D-Bus)
Documentation=https://github.com/jtekk1/kwilt
After=graphical-session.target

[Service]
Type=dbus
BusName=${BUS_NAME}
ExecStart=/usr/bin/python3 ${daemon_dst}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now "${UNIT_NAME}"

# --- Verify ---

sleep 0.3
if busctl --user call \
    "${BUS_NAME}" /dev/jtekk/KwiltConfigWriter \
    "${BUS_NAME}" Ping >/dev/null 2>&1; then
    ping_ok="yes"
else
    ping_ok="no (check: journalctl --user -u ${UNIT_NAME})"
fi

echo "Kwilt persistence helper installed:"
echo "  Daemon: ${daemon_dst}"
echo "  D-Bus:  ${dbus_service}"
echo "  Unit:   ${systemd_unit}"
echo "  Ping:   ${ping_ok}"
echo
echo "Reload Kwilt (./dev-reload.sh) to pick up the persistence path."
echo "Uninstall with: $0 --uninstall"
