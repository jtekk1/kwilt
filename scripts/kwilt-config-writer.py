#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 jtekk <jtekk@jtekk.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Kwilt config-writer helper.
#
# KWin scripts on Plasma 6 can call D-Bus outbound but cannot spawn processes
# or write config files. `readConfig` reads kwinrc's `[Script-kwilt]` group;
# there is no `writeConfig`. This daemon fills that gap: Kwilt calls
#   dev.jtekk.KwiltConfigWriter.Write(key, value)
# and the daemon shells out to kwriteconfig6.
#
# Runs as a per-user systemd service, D-Bus-activated on demand. Install via
# scripts/install-persistence.sh. Without it, Kwilt still works — state just
# doesn't survive script reload.
#
# Only whitelisted keys can be written. Session bus only (no system bus).

import subprocess
import sys

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

BUS_NAME = "dev.jtekk.KwiltConfigWriter"
OBJ_PATH = "/dev/jtekk/KwiltConfigWriter"

CONFIG_FILE = "kwinrc"
CONFIG_GROUP = "Script-kwilt"

# Keys Kwilt is allowed to persist. Anything else gets rejected — prevents
# a rogue caller from writing arbitrary kwinrc keys through us.
ALLOWED_KEYS = frozenset([
    "MasterWidth",
    "PerKeyLayoutsJson",
    "RowSplitsJson",
    "InterColSplitsJson",
])

KWRITECONFIG = "kwriteconfig6"


def log(msg):
    print("[kwilt-config-writer]", msg, file=sys.stderr, flush=True)


class ConfigWriter(dbus.service.Object):
    def __init__(self, bus, path):
        super().__init__(bus, path)

    @dbus.service.method(BUS_NAME, in_signature="", out_signature="s")
    def Ping(self):
        return "pong"

    @dbus.service.method(BUS_NAME, in_signature="ss", out_signature="b")
    def Write(self, key, value):
        key = str(key)
        value = str(value)
        if key not in ALLOWED_KEYS:
            log(f"rejected write: unknown key {key!r}")
            return False
        try:
            subprocess.run(
                [
                    KWRITECONFIG,
                    "--file", CONFIG_FILE,
                    "--group", CONFIG_GROUP,
                    "--key", key,
                    value,
                ],
                check=True,
                timeout=5,
            )
        except FileNotFoundError:
            log(f"{KWRITECONFIG} not found on PATH")
            return False
        except subprocess.CalledProcessError as exc:
            log(f"{KWRITECONFIG} failed for {key}: exit {exc.returncode}")
            return False
        except subprocess.TimeoutExpired:
            log(f"{KWRITECONFIG} timed out for {key}")
            return False
        log(f"wrote {key} (len={len(value)})")
        return True


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    try:
        bus.request_name(BUS_NAME, dbus.bus.NAME_FLAG_DO_NOT_QUEUE)
    except dbus.exceptions.DBusException as exc:
        log(f"could not acquire bus name {BUS_NAME}: {exc}")
        sys.exit(1)
    _writer = ConfigWriter(bus, OBJ_PATH)  # noqa: F841 (retain reference)
    log(f"started; bus={BUS_NAME} path={OBJ_PATH}")
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
