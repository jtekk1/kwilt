"use strict";

// Ixtli — Phase 0 auto-grid tiler.
//
// Per (output, virtual desktop) we maintain an ordered queue of tracked
// windows. The last CAP entries are visible and tiled; the rest are
// "knocked out" (minimized). Eviction is FIFO; activating a knocked-out
// window promotes it to the end of the queue.

const LOG_PREFIX = "[ixtli]";

function log(msg) { print(LOG_PREFIX, msg); }

// Read a tunable option at script-load time. KWin injects `readConfig` as a
// global that reads from kwinrc under the script's own config namespace; if
// the build is old or the key is unset, `defaultValue` wins. We coerce
// against the default's type because readConfig can return QVariant
// strings ("0.85") even when the caller wanted a number.
function cfg(key, defaultValue) {
  if (typeof readConfig !== "function") return defaultValue;
  const raw = readConfig(key, defaultValue);
  if (typeof defaultValue === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : defaultValue;
  }
  if (typeof defaultValue === "boolean") {
    return raw === true || raw === "true";
  }
  return raw;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Tunables. Override with:
//   kwriteconfig6 --file kwinrc --group Script-ixtli --key <Key> <value>
// then reload the script (./dev-reload.sh or relogin). Defaults match the
// hardcoded values that were here before this commit, so an unconfigured
// kwinrc is a no-op.
const VALID_LAYOUTS = ["autoGrid", "centerTile", "monocle", "dual"];

const CFG = (function () {
  const layoutRaw = cfg("Layout", "centerTile");
  const layout = VALID_LAYOUTS.indexOf(layoutRaw) !== -1 ? layoutRaw : "centerTile";
  return {
    layout: layout,
    capAutoGrid:        Math.round(clamp(cfg("CapAutoGrid", 12),        1, 12)),
    capCenterTile:      Math.round(clamp(cfg("CapCenterTile", 9),       1, 9)),
    centerTileWidth1:               clamp(cfg("CenterTileWidth1", 0.85), 0.5, 1.0),
    centerTileSideWidth:            clamp(cfg("CenterTileSideWidth", 0.30), 0.15, 0.45),
  };
})();

// LAYOUT and CAP are mutable so the cycle-layout shortcut can switch at
// runtime. The initial value comes from CFG.layout (kwinrc-tunable).
// monocle and dual are fixed-cap layouts — their cap defines the layout
// (1 visible / 2 visible) and isn't configurable.
let LAYOUT = CFG.layout;
const CAPS = {
  autoGrid:   CFG.capAutoGrid,
  centerTile: CFG.capCenterTile,
  monocle:    1,
  dual:       2,
};
let CAP = CAPS[LAYOUT];

// App-launcher shortcuts are NOT registered here. KWin scripts can't spawn
// processes (no exec/spawn API; callDBus → systemd-run doesn't marshal the
// nested-variant ExecStart arg). Launcher bindings live in KDE's native
// Custom Shortcuts mechanism and are seeded by scripts/setup-shortcuts.sh
// (which also clears Plasma KWin defaults like Quick Tile that conflict
// with the window-mgmt shortcuts below).

// Map<string, Window[]>: key = `${outputId}|${desktopId}`
const queues = new Map();

function outputId(out) {
  if (!out) return "null";
  return out.serialNumber || out.name || String(out);
}

function desktopId(desk) {
  if (!desk) return "null";
  return desk.id || desk.x11DesktopNumber || String(desk);
}

function keyFor(out, desk) {
  return outputId(out) + "|" + desktopId(desk);
}

function singleDesktop(w) {
  if (!w.desktops || w.desktops.length !== 1) return null;
  return w.desktops[0];
}

function isTileable(w) {
  if (!w) return false;
  if (!w.normalWindow) return false;
  if (w.fullScreen) return false;
  if (w.onAllDesktops) return false;
  if (!w.output) return false;
  if (!singleDesktop(w)) return false;
  // Some apps (Electron tray helpers, hidden background windows) pass
  // normalWindow but never become user-facing. Skip-taskbar AND skip-
  // switcher together is a reliable signal these aren't real user
  // windows we should be tiling. We require BOTH because some legit
  // apps set just one (e.g., a few terminals skip the switcher).
  if (w.skipTaskbar && w.skipSwitcher) return false;
  return true;
}

function workArea(out, desk) {
  return workspace.clientArea(KWin.MaximizeArea, out, desk);
}

function rect(x, y, w, h) { return { x: x, y: y, width: w, height: h }; }

// autoGrid — pattern: while N is below the next perfect MxM grid, W1 spans
// the full left column; once N hits the perfect grid, every cell equalizes.
// 2x2 frame for N=3/4, 2x3 frame for N=5/6, 3x3 frame for N=7/8/9.
// Last column / last row absorbs floor-rounding remainders.
function geometriesAutoGrid(n, area) {
  const x = area.x, y = area.y, w = area.width, h = area.height;
  if (n <= 0) return [];
  if (n === 1) return [rect(x, y, w, h)];

  // N=2: left half / right half.
  if (n === 2) {
    const hw = Math.floor(w / 2);
    return [
      rect(x, y, hw, h),
      rect(x + hw, y, w - hw, h),
    ];
  }

  // 2x2 frame.
  if (n === 3 || n === 4) {
    const hw = Math.floor(w / 2);
    const hh = Math.floor(h / 2);
    if (n === 3) {
      // W1 spans full left column.
      return [
        rect(x, y, hw, h),
        rect(x + hw, y, w - hw, hh),
        rect(x + hw, y + hh, w - hw, h - hh),
      ];
    }
    // N=4: TL / TR / BR / BL (clockwise). Intentional break from row-major
    // — preserved for continuity with the original autoGrid behavior.
    return [
      rect(x, y, hw, hh),
      rect(x + hw, y, w - hw, hh),
      rect(x + hw, y + hh, w - hw, h - hh),
      rect(x, y + hh, hw, h - hh),
    ];
  }

  // 2x3 frame.
  if (n === 5 || n === 6) {
    const cw = Math.floor(w / 3);
    const lastCw = w - 2 * cw;
    const rh = Math.floor(h / 2);
    const lastRh = h - rh;
    if (n === 5) {
      // W1 spans full left column; W2..W5 fill the right 2x2 block.
      return [
        rect(x, y, cw, h),
        rect(x + cw, y, cw, rh),
        rect(x + 2 * cw, y, lastCw, rh),
        rect(x + cw, y + rh, cw, lastRh),
        rect(x + 2 * cw, y + rh, lastCw, lastRh),
      ];
    }
    // N=6: perfect 2x3, row-major.
    return [
      rect(x, y, cw, rh),
      rect(x + cw, y, cw, rh),
      rect(x + 2 * cw, y, lastCw, rh),
      rect(x, y + rh, cw, lastRh),
      rect(x + cw, y + rh, cw, lastRh),
      rect(x + 2 * cw, y + rh, lastCw, lastRh),
    ];
  }

  // 3x3 frame (n is 7, 8, or 9).
  if (n >= 7 && n <= 9) {
    const cw = Math.floor(w / 3);
    const lastCw = w - 2 * cw;
    const rh = Math.floor(h / 3);
    const lastRh = h - 2 * rh;

    if (n === 7) {
      // W1 spans full left column (all 3 rows); W2..W7 fill the right 2x3 block.
      return [
        rect(x, y, cw, h),
        rect(x + cw, y, cw, rh),
        rect(x + 2 * cw, y, lastCw, rh),
        rect(x + cw, y + rh, cw, rh),
        rect(x + 2 * cw, y + rh, lastCw, rh),
        rect(x + cw, y + 2 * rh, cw, lastRh),
        rect(x + 2 * cw, y + 2 * rh, lastCw, lastRh),
      ];
    }

    if (n === 8) {
      // W1 spans top 2 rows of left column (2h/3 tall); bottom row is a normal
      // 3-cell strip. Smooth shrink between N=7 (3 rows) and N=9 (1 row).
      return [
        rect(x, y, cw, 2 * rh),
        rect(x + cw, y, cw, rh),
        rect(x + 2 * cw, y, lastCw, rh),
        rect(x + cw, y + rh, cw, rh),
        rect(x + 2 * cw, y + rh, lastCw, rh),
        rect(x, y + 2 * rh, cw, lastRh),
        rect(x + cw, y + 2 * rh, cw, lastRh),
        rect(x + 2 * cw, y + 2 * rh, lastCw, lastRh),
      ];
    }

    // n === 9: perfect 3x3, row-major.
    return [
      rect(x, y, cw, rh),
      rect(x + cw, y, cw, rh),
      rect(x + 2 * cw, y, lastCw, rh),
      rect(x, y + rh, cw, rh),
      rect(x + cw, y + rh, cw, rh),
      rect(x + 2 * cw, y + rh, lastCw, rh),
      rect(x, y + 2 * rh, cw, lastRh),
      rect(x + cw, y + 2 * rh, cw, lastRh),
      rect(x + 2 * cw, y + 2 * rh, lastCw, lastRh),
    ];
  }

  // 3x4 frame (n is 10, 11, or 12; CAP caps at 12). Same W1-spans-left-column
  // progression as the 3x3 frame, just one column wider.
  const cw = Math.floor(w / 4);
  const lastCw = w - 3 * cw;
  const rh = Math.floor(h / 3);
  const lastRh = h - 2 * rh;

  if (n === 10) {
    // W1 spans full left column (all 3 rows); W2..W10 fill the right 3x3 block.
    return [
      rect(x, y, cw, h),
      rect(x + cw, y, cw, rh),
      rect(x + 2 * cw, y, cw, rh),
      rect(x + 3 * cw, y, lastCw, rh),
      rect(x + cw, y + rh, cw, rh),
      rect(x + 2 * cw, y + rh, cw, rh),
      rect(x + 3 * cw, y + rh, lastCw, rh),
      rect(x + cw, y + 2 * rh, cw, lastRh),
      rect(x + 2 * cw, y + 2 * rh, cw, lastRh),
      rect(x + 3 * cw, y + 2 * rh, lastCw, lastRh),
    ];
  }

  if (n === 11) {
    // W1 spans top 2 rows of left column; bottom row is a normal 4-cell strip.
    return [
      rect(x, y, cw, 2 * rh),
      rect(x + cw, y, cw, rh),
      rect(x + 2 * cw, y, cw, rh),
      rect(x + 3 * cw, y, lastCw, rh),
      rect(x + cw, y + rh, cw, rh),
      rect(x + 2 * cw, y + rh, cw, rh),
      rect(x + 3 * cw, y + rh, lastCw, rh),
      rect(x, y + 2 * rh, cw, lastRh),
      rect(x + cw, y + 2 * rh, cw, lastRh),
      rect(x + 2 * cw, y + 2 * rh, cw, lastRh),
      rect(x + 3 * cw, y + 2 * rh, lastCw, lastRh),
    ];
  }

  // n >= 12: perfect 3x4, row-major.
  return [
    rect(x, y, cw, rh),
    rect(x + cw, y, cw, rh),
    rect(x + 2 * cw, y, cw, rh),
    rect(x + 3 * cw, y, lastCw, rh),
    rect(x, y + rh, cw, rh),
    rect(x + cw, y + rh, cw, rh),
    rect(x + 2 * cw, y + rh, cw, rh),
    rect(x + 3 * cw, y + rh, lastCw, rh),
    rect(x, y + 2 * rh, cw, lastRh),
    rect(x + cw, y + 2 * rh, cw, lastRh),
    rect(x + 2 * cw, y + 2 * rh, cw, lastRh),
    rect(x + 3 * cw, y + 2 * rh, lastCw, lastRh),
  ];
}

// Center Tile layout — 40% center column, 30% left, 30% right.
// Queue order maps to slots:
//   slot 0 → center (always W1)
//   slot 1 → top of left column (W2)
//   slot 2 → top of right column (W3)   [N>=3]
//   slot 3 → next left-column slot       (W4)
//   slot 4 → next right-column slot      (W5)
//   slot 5 → next left-column slot       (W6)
//   slot 6 → next right-column slot      (W7)
// Side columns grow top-down: 1 tile → split halves → split thirds.
function geometriesCenterTile(n, area) {
  const x = area.x, y = area.y, w = area.width, h = area.height;
  if (n <= 0) return [];

  // N=1: single column at CFG.centerTileWidth1 fraction of width, centered.
  if (n === 1) {
    const cw = Math.floor(CFG.centerTileWidth1 * w);
    return [rect(x + Math.floor((w - cw) / 2), y, cw, h)];
  }

  // N=2: plain halves (intentional break from the center+side pattern).
  if (n === 2) {
    const hw = Math.floor(w / 2);
    return [
      rect(x, y, hw, h),
      rect(x + hw, y, w - hw, h),
    ];
  }

  // N>=3: sides take CFG.centerTileSideWidth fraction each; center absorbs
  // the rest (and any floor-rounding remainder).
  const sideW = Math.floor(CFG.centerTileSideWidth * w);
  const centerW = w - 2 * sideW;
  const leftX = x;
  const centerX = x + sideW;
  const rightX = x + sideW + centerW;
  const center = rect(centerX, y, centerW, h);

  if (n === 3) return [
    center,
    rect(leftX, y, sideW, h),                                    // left full
    rect(rightX, y, sideW, h),                                    // right full
  ];

  if (n === 4) {
    const halfH = Math.floor(h / 2);
    return [
      center,
      rect(leftX, y, sideW, halfH),                    // left-top  (W2)
      rect(rightX, y, sideW, h),                        // right full (W3)
      rect(leftX, y + halfH, sideW, h - halfH),                // left-bot  (W4)
    ];
  }

  if (n === 5) {
    const halfH = Math.floor(h / 2);
    return [
      center,
      rect(leftX, y, sideW, halfH),                    // left-top  (W2)
      rect(rightX, y, sideW, halfH),                    // right-top (W3)
      rect(leftX, y + halfH, sideW, h - halfH),                // left-bot  (W4)
      rect(rightX, y + halfH, sideW, h - halfH),                // right-bot (W5)
    ];
  }

  if (n === 6) {
    const thirdH = Math.floor(h / 3);
    const halfH = Math.floor(h / 2);
    return [
      center,
      rect(leftX, y, sideW, thirdH),             // left-top  (W2)
      rect(rightX, y, sideW, halfH),              // right-top (W3)
      rect(leftX, y + thirdH, sideW, thirdH),             // left-mid  (W4)
      rect(rightX, y + halfH, sideW, h - halfH),          // right-bot (W5)
      rect(leftX, y + 2 * thirdH, sideW, h - 2 * thirdH),     // left-bot  (W6)
    ];
  }

  if (n === 7) {
    // Both columns in thirds. Symmetric.
    const thirdH = Math.floor(h / 3);
    return [
      center,
      rect(leftX, y, sideW, thirdH),                                          // left-top  (W2)
      rect(rightX, y, sideW, thirdH),                                         // right-top (W3)
      rect(leftX, y + thirdH, sideW, thirdH),                                 // left-mid  (W4)
      rect(rightX, y + thirdH, sideW, thirdH),                                // right-mid (W5)
      rect(leftX, y + 2 * thirdH, sideW, h - 2 * thirdH),                     // left-bot  (W6)
      rect(rightX, y + 2 * thirdH, sideW, h - 2 * thirdH),                    // right-bot (W7)
    ];
  }

  if (n === 8) {
    // 4 left (quarters) + 3 right (thirds). Asymmetric — continues the
    // "left fills first when uneven" pattern from N=4 and N=6.
    const quarterH = Math.floor(h / 4);
    const lastQuarterH = h - 3 * quarterH;
    const thirdH = Math.floor(h / 3);
    const lastThirdH = h - 2 * thirdH;
    return [
      center,
      rect(leftX, y, sideW, quarterH),                                        // left-1  (W2)
      rect(rightX, y, sideW, thirdH),                                         // right-1 (W3)
      rect(leftX, y + quarterH, sideW, quarterH),                             // left-2  (W4)
      rect(rightX, y + thirdH, sideW, thirdH),                                // right-2 (W5)
      rect(leftX, y + 2 * quarterH, sideW, quarterH),                         // left-3  (W6)
      rect(rightX, y + 2 * thirdH, sideW, lastThirdH),                        // right-3 (W7)
      rect(leftX, y + 3 * quarterH, sideW, lastQuarterH),                     // left-4  (W8)
    ];
  }

  // n >= 9: both columns in quarters. Capped at 9 by CAP.
  const quarterH = Math.floor(h / 4);
  const lastQuarterH = h - 3 * quarterH;
  return [
    center,
    rect(leftX, y, sideW, quarterH),                                          // left-1  (W2)
    rect(rightX, y, sideW, quarterH),                                         // right-1 (W3)
    rect(leftX, y + quarterH, sideW, quarterH),                               // left-2  (W4)
    rect(rightX, y + quarterH, sideW, quarterH),                              // right-2 (W5)
    rect(leftX, y + 2 * quarterH, sideW, quarterH),                           // left-3  (W6)
    rect(rightX, y + 2 * quarterH, sideW, quarterH),                          // right-3 (W7)
    rect(leftX, y + 3 * quarterH, sideW, lastQuarterH),                       // left-4  (W8)
    rect(rightX, y + 3 * quarterH, sideW, lastQuarterH),                      // right-4 (W9)
  ];
}

// Monocle — one visible window at full work area. CAP=1 knocks out the rest;
// alt-tab onto a knocked window promotes it via the existing onActivated path.
function geometriesMonocle(n, area) {
  if (n <= 0) return [];
  return [rect(area.x, area.y, area.width, area.height)];
}

// Dual — at most two visible windows. CAP=2. N=1 fills full area; N=2 is left
// half / right half (the same shape as autoGrid's N=2 and centerTile's N=2).
function geometriesDual(n, area) {
  if (n <= 0) return [];
  if (n === 1) return [rect(area.x, area.y, area.width, area.height)];
  const hw = Math.floor(area.width / 2);
  return [
    rect(area.x, area.y, hw, area.height),
    rect(area.x + hw, area.y, area.width - hw, area.height),
  ];
}

const LAYOUTS = {
  autoGrid:   geometriesAutoGrid,
  centerTile: geometriesCenterTile,
  monocle:    geometriesMonocle,
  dual:       geometriesDual,
};

function geometries(n, area) {
  return LAYOUTS[LAYOUT](n, area);
}

function queueFor(out, desk, create) {
  const key = keyFor(out, desk);
  let q = queues.get(key);
  if (!q && create) { q = []; queues.set(key, q); }
  return q;
}

function findContaining(w) {
  for (const [key, q] of queues) {
    const idx = q.indexOf(w);
    if (idx !== -1) return { key: key, q: q, idx: idx };
  }
  return null;
}

function applyQueue(key, q, out, desk) {
  // Defensive prune: drop entries that are no longer tileable, no longer on
  // this output, or no longer on this desktop. Belt-and-suspenders for state
  // changes signal handlers may miss (zombie Window refs, externally
  // fullscreened or destroyed windows, etc.) — without this they'd inflate
  // visible.length and we'd allocate a tile slot for a window that isn't
  // actually there, leaving a "ghost" slot showing the desktop.
  for (let i = q.length - 1; i >= 0; i--) {
    const w = q[i];
    if (!isTileable(w) || w.output !== out || singleDesktop(w) !== desk) {
      q.splice(i, 1);
    }
  }
  const split = Math.max(0, q.length - CAP);
  const knocked = q.slice(0, split);
  const visible = q.slice(split);
  const geos = geometries(visible.length, workArea(out, desk));
  for (const w of knocked) {
    if (!w.minimized) w.minimized = true;
  }
  visible.forEach(function (w, i) {
    if (w.minimized) w.minimized = false;
    // Unmaximize before setting geometry, else maximize state overrides us.
    if (w.maximizable) w.setMaximize(false, false);
    w.frameGeometry = geos[i];
  });
  log("apply " + key + " n=" + q.length + " visible=" + visible.length + " knocked=" + knocked.length);
}

function retileKey(key) {
  const q = queues.get(key);
  if (!q || q.length === 0) { queues.delete(key); return; }
  const member = q[0];
  const desk = singleDesktop(member);
  if (!member.output || !desk) return;
  applyQueue(key, q, member.output, desk);
}

function retileAll() {
  const keys = Array.from(queues.keys());
  for (const k of keys) retileKey(k);
}

function track(w) {
  if (!isTileable(w)) return null;
  const desk = singleDesktop(w);
  const q = queueFor(w.output, desk, true);
  if (q.indexOf(w) === -1) q.push(w);
  return keyFor(w.output, desk);
}

function untrack(w) {
  const found = findContaining(w);
  if (!found) return null;
  found.q.splice(found.idx, 1);
  return found.key;
}

function migrate(w) {
  const oldKey = untrack(w);
  const newKey = track(w);
  if (oldKey && oldKey !== newKey) retileKey(oldKey);
  if (newKey) retileKey(newKey);
}

// External state-change handlers. The minimized/fullScreen handlers
// distinguish our own writes (which match the window's queue position) from
// external user actions (which don't) by checking whether the window's new
// state matches its queue-side expectation.
function onMinimizedChanged(w) {
  const found = findContaining(w);
  if (!found) return;
  const split = Math.max(0, found.q.length - CAP);
  if (w.minimized) {
    // User minimized a visible tile (taskbar / title-bar button / app). Honor
    // it: drop from the queue so the tile slot collapses instead of leaving
    // a ghost slot. Knocked-slice transitions are our own — no-op.
    if (found.idx >= split) {
      untrack(w);
      retileKey(found.key);
    }
  } else {
    // External un-minimize. If it's a knocked window coming back, promote it
    // like activation. Visible-slice transitions are our own — no-op.
    if (found.idx < split) {
      found.q.splice(found.idx, 1);
      found.q.push(w);
      retileKey(found.key);
    }
  }
}

function onFullScreenChanged(w) {
  const found = findContaining(w);
  if (w.fullScreen) {
    if (found) {
      untrack(w);
      retileKey(found.key);
    }
  } else if (!found && isTileable(w)) {
    const newKey = track(w);
    if (newKey) retileKey(newKey);
  }
}

// Some windows die without windowRemoved firing reliably (apps that exit
// abruptly, transient surfaces, etc.). Listening to per-window `closed`
// catches those cases and prevents stale refs from squatting on tile slots.
function onWindowClosed(w) {
  const key = untrack(w);
  if (key) retileKey(key);
}

function bindWindow(w) {
  if (w._ixtliBound) return;
  w._ixtliBound = true;
  if (w.outputChanged) w.outputChanged.connect(function () { migrate(w); });
  if (w.desktopsChanged) w.desktopsChanged.connect(function () { migrate(w); });
  if (w.minimizedChanged) w.minimizedChanged.connect(function () { onMinimizedChanged(w); });
  if (w.fullScreenChanged) w.fullScreenChanged.connect(function () { onFullScreenChanged(w); });
  if (w.closed) w.closed.connect(function () { onWindowClosed(w); });
  if (w.interactiveMoveResizeStarted) {
    w.interactiveMoveResizeStarted.connect(function () {
      w._ixtliDragMode = w.move ? "move" : (w.resize ? "resize" : null);
    });
  }
  if (w.interactiveMoveResizeFinished) {
    w.interactiveMoveResizeFinished.connect(function () {
      const mode = w._ixtliDragMode;
      w._ixtliDragMode = null;
      if (mode === "move") {
        handleDrop(w);
      } else if (mode === "resize") {
        // Tiles own geometry; snap back.
        const found = findContaining(w);
        if (found) retileKey(found.key);
      }
    });
  }
}

function handleDrop(w) {
  const found = findContaining(w);
  if (!found) return;

  const split = Math.max(0, found.q.length - CAP);
  const visible = found.q.slice(split);
  const srcVisIdx = visible.indexOf(w);
  if (srcVisIdx === -1) {
    // Source isn't in the visible set (shouldn't happen for a draggable window).
    retileKey(found.key);
    return;
  }

  const desk = singleDesktop(w);
  if (!desk || !w.output) { retileKey(found.key); return; }

  const area = workArea(w.output, desk);
  const tiles = geometries(visible.length, area);

  const fg = w.frameGeometry;
  const cx = fg.x + fg.width / 2;
  const cy = fg.y + fg.height / 2;

  let dstVisIdx = -1;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (cx >= t.x && cx < t.x + t.width && cy >= t.y && cy < t.y + t.height) {
      dstVisIdx = i;
      break;
    }
  }

  if (dstVisIdx === -1 || dstVisIdx === srcVisIdx) {
    retileKey(found.key);  // snap back
    return;
  }

  const srcQIdx = split + srcVisIdx;
  const dstQIdx = split + dstVisIdx;
  const tmp = found.q[srcQIdx];
  found.q[srcQIdx] = found.q[dstQIdx];
  found.q[dstQIdx] = tmp;
  log("swap slot " + srcVisIdx + " <-> " + dstVisIdx);
  retileKey(found.key);
}

function onAdded(w) {
  const key = track(w);
  if (!key) return;
  bindWindow(w);
  retileKey(key);
}

function onRemoved(w) {
  const key = untrack(w);
  if (key) retileKey(key);
}

// Focus history for the focus-last shortcut: when the active window changes,
// shift the previous "lastFocused" into "prevFocused" and store the new one.
let lastFocused = null;
let prevFocused = null;

function onActivated(w) {
  if (!w) return;
  const found = findContaining(w);
  if (found) {
    const split = Math.max(0, found.q.length - CAP);
    if (found.idx < split) {
      // Knocked-out window activated — promote to most-recent.
      found.q.splice(found.idx, 1);
      found.q.push(w);
      retileKey(found.key);
    }
  }
  if (w !== lastFocused) {
    prevFocused = lastFocused;
    lastFocused = w;
  }
}

function setLayout(name) {
  if (!LAYOUTS[name] || name === LAYOUT) return;
  LAYOUT = name;
  CAP = CAPS[LAYOUT];
  log("layout=" + LAYOUT + " cap=" + CAP);
  // retileAll picks up the new geometries function and CAP — windows past
  // the new cap are minimized, windows that fit are unminimized.
  retileAll();
}

function cycleLayout() {
  const names = Object.keys(LAYOUTS);
  setLayout(names[(names.indexOf(LAYOUT) + 1) % names.length]);
}

// tileSlotOf returns the visible-tile context of a window, or null if the
// window isn't tiled or is currently knocked out. Used by every keyboard-
// driven focus/swap so the layout's geometry function is the single source
// of truth for what "neighbor" means.
function tileSlotOf(w) {
  if (!w) return null;
  const found = findContaining(w);
  if (!found) return null;
  const split = Math.max(0, found.q.length - CAP);
  if (found.idx < split) return null;
  const desk = singleDesktop(w);
  if (!desk || !w.output) return null;
  const visibleCount = found.q.length - split;
  const tiles = geometries(visibleCount, workArea(w.output, desk));
  const visIdx = found.idx - split;
  return { found: found, split: split, visIdx: visIdx, tiles: tiles };
}

// Find the visible-tile index closest to the current tile's center in the
// given direction. The y-deviation penalty (for left/right) makes the search
// prefer same-row neighbors over diagonal ones, and vice versa for up/down.
function neighborSlot(currentVisIdx, tiles, direction) {
  const cur = tiles[currentVisIdx];
  const cx = cur.x + cur.width / 2;
  const cy = cur.y + cur.height / 2;
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < tiles.length; i++) {
    if (i === currentVisIdx) continue;
    const t = tiles[i];
    const tx = t.x + t.width / 2;
    const ty = t.y + t.height / 2;
    let dist = -1;
    if (direction === "left"  && tx < cx) dist = (cx - tx) + Math.abs(ty - cy) * 0.5;
    if (direction === "right" && tx > cx) dist = (tx - cx) + Math.abs(ty - cy) * 0.5;
    if (direction === "up"    && ty < cy) dist = (cy - ty) + Math.abs(tx - cx) * 0.5;
    if (direction === "down"  && ty > cy) dist = (ty - cy) + Math.abs(tx - cx) * 0.5;
    if (dist >= 0 && dist < bestDist) { bestDist = dist; bestIdx = i; }
  }
  return bestIdx;
}

function focusByDirection(direction) {
  const slot = tileSlotOf(workspace.activeWindow);
  if (!slot) return;
  const nextVis = neighborSlot(slot.visIdx, slot.tiles, direction);
  if (nextVis === -1) return;
  const target = slot.found.q[slot.split + nextVis];
  if (target) {
    workspace.activeWindow = target;
    log("focus " + direction + " → vis " + nextVis);
  }
}

function swapByDirection(direction) {
  const slot = tileSlotOf(workspace.activeWindow);
  if (!slot) return;
  const nextVis = neighborSlot(slot.visIdx, slot.tiles, direction);
  if (nextVis === -1) return;
  const srcQ = slot.split + slot.visIdx;
  const dstQ = slot.split + nextVis;
  const tmp = slot.found.q[srcQ];
  slot.found.q[srcQ] = slot.found.q[dstQ];
  slot.found.q[dstQ] = tmp;
  log("swap " + direction + " → vis " + nextVis);
  retileKey(slot.found.key);
}

function cycleFocus() {
  const w = workspace.activeWindow;
  if (!w) return;
  const found = findContaining(w);
  if (!found) return;
  const split = Math.max(0, found.q.length - CAP);
  const visCount = found.q.length - split;
  if (visCount < 2) return;
  const curVis = found.idx >= split ? (found.idx - split) : -1;
  const nextVis = (curVis + 1) % visCount;
  const target = found.q[split + nextVis];
  if (target) {
    workspace.activeWindow = target;
    log("cycle focus → vis " + nextVis);
  }
}

function focusLast() {
  if (prevFocused && prevFocused !== workspace.activeWindow) {
    workspace.activeWindow = prevFocused;
    log("focus last");
  }
}

// Rebuild every queue from the current `workspace.windowList()`. Bound to
// Meta+Ctrl+Shift+R as a manual recovery hatch — if a ghost slot ever
// appears, this re-snapshots ground truth without needing a script reload.
function rebuildQueues() {
  queues.clear();
  const existing = workspace.windowList ? workspace.windowList() : (workspace.clientList ? workspace.clientList() : []);
  for (const w of existing) {
    // Stale Qt dynamic property from a prior script-load — clear so
    // bindWindow actually re-connects signals against the new JS engine.
    w._ixtliBound = false;
    const key = track(w);
    if (key) bindWindow(w);
  }
  retileAll();
  log("rebuilt queues from workspace.windowList()");
}

function init() {
  log("loaded; layout=" + LAYOUT + " cap=" + CAP);
  const existing = workspace.windowList ? workspace.windowList() : (workspace.clientList ? workspace.clientList() : []);
  for (const w of existing) {
    // _ixtliBound is a Qt dynamic property that persists across script
    // reloads (the QObject lives in KWin), but the signal connections
    // bindWindow set up under the previous JS engine were torn down when
    // it was destroyed. Resetting here ensures we re-connect against the
    // current engine — otherwise bindWindow short-circuits and our
    // minimizedChanged / fullScreenChanged / closed listeners never fire
    // for windows that were open before the reload.
    w._ixtliBound = false;
    const key = track(w);
    if (key) bindWindow(w);
  }
  retileAll();

  // Seed focus history so Meta+U works after the FIRST window switch
  // (rather than the second). Without this, prevFocused stays null until
  // onActivated fires twice with different windows.
  lastFocused = workspace.activeWindow;

  workspace.windowAdded.connect(onAdded);
  workspace.windowRemoved.connect(onRemoved);
  workspace.windowActivated.connect(onActivated);
  workspace.screensChanged.connect(retileAll);
  if (workspace.desktopLayoutChanged) workspace.desktopLayoutChanged.connect(retileAll);

  // `typeof` guard rather than direct read — undeclared globals throw
  // ReferenceError on QJSEngine, and not every KWin build exposes this.
  if (typeof registerShortcut !== "function") {
    log("registerShortcut unavailable; all keybindings skipped");
    return;
  }

  // Layout — cycle and direct-set.
  registerShortcut("IxtliCycleLayout",  "Ixtli: Cycle window layout",       "Meta+Ctrl+Shift+L", cycleLayout);
  registerShortcut("IxtliLayoutGrid",   "Ixtli: Layout — autoGrid",         "Meta+Ctrl+G",       function () { setLayout("autoGrid"); });
  registerShortcut("IxtliLayoutCenter", "Ixtli: Layout — centerTile",       "Meta+Ctrl+C",       function () { setLayout("centerTile"); });

  // Manual recovery: re-snapshot the queues from workspace.windowList().
  // Use when you suspect a ghost tile slot — quicker than ./dev-reload.sh.
  registerShortcut("IxtliRebuildQueues", "Ixtli: Rebuild tile queues (ghost-slot recovery)", "Meta+Ctrl+Shift+R", rebuildQueues);

  // Focus by direction (Meta+arrows) and swap by direction (Meta+Shift+arrows).
  // Plasma's KWin defaults (Quick Tile / Move Window to Screen) claim these
  // key combos and win the dispatch. scripts/setup-shortcuts.sh disables
  // them in kglobalshortcutsrc; run it once per machine.
  registerShortcut("IxtliFocusLeft",  "Ixtli: Focus window left",  "Meta+Left",  function () { focusByDirection("left");  });
  registerShortcut("IxtliFocusRight", "Ixtli: Focus window right", "Meta+Right", function () { focusByDirection("right"); });
  registerShortcut("IxtliFocusUp",    "Ixtli: Focus window up",    "Meta+Up",    function () { focusByDirection("up");    });
  registerShortcut("IxtliFocusDown",  "Ixtli: Focus window down",  "Meta+Down",  function () { focusByDirection("down");  });
  registerShortcut("IxtliSwapLeft",   "Ixtli: Swap window left",   "Meta+Shift+Left",  function () { swapByDirection("left");  });
  registerShortcut("IxtliSwapRight",  "Ixtli: Swap window right",  "Meta+Shift+Right", function () { swapByDirection("right"); });
  registerShortcut("IxtliSwapUp",     "Ixtli: Swap window up",     "Meta+Shift+Up",    function () { swapByDirection("up");    });
  registerShortcut("IxtliSwapDown",   "Ixtli: Swap window down",   "Meta+Shift+Down",  function () { swapByDirection("down");  });

  // Focus history. Meta+Tab is claimed by KWin's Walk Through Windows
  // (alongside Alt+Tab) — setup-shortcuts.sh strips just the Meta+Tab half.
  registerShortcut("IxtliCycleFocus", "Ixtli: Cycle focus (next tile)", "Meta+Tab", cycleFocus);
  registerShortcut("IxtliFocusLast",  "Ixtli: Focus last window",       "Meta+U",   focusLast);
}

init();
