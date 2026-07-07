// SPDX-FileCopyrightText: 2026 jtekk <jtekk@jtekk.dev>
// SPDX-License-Identifier: GPL-3.0-or-later

"use strict";

// Kwilt — Phase 0 auto-grid tiler.
//
// Per (output, virtual desktop) we maintain an ordered queue of tracked
// windows. The last CAP entries are visible and tiled; the rest are
// "knocked out" (minimized). Eviction is FIFO; activating a knocked-out
// window promotes it to the end of the queue.

const LOG_PREFIX = "[kwilt]";

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
//   kwriteconfig6 --file kwinrc --group Script-kwilt --key <Key> <value>
// then reload the script (./dev-reload.sh or relogin). Defaults match the
// hardcoded values that were here before this commit, so an unconfigured
// kwinrc is a no-op.
const VALID_LAYOUTS = ["autoGrid", "centerTile", "monocle", "dual", "leftTile", "rightTile", "floating"];

const CFG = (function () {
  const layoutRaw = cfg("Layout", "centerTile");
  const layout = VALID_LAYOUTS.indexOf(layoutRaw) !== -1 ? layoutRaw : "centerTile";
  const alwaysFloatRaw = cfg("AlwaysFloat", "");
  const alwaysFloat = String(alwaysFloatRaw)
    .split(",")
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(function (s) { return s.length > 0; });
  return {
    layout: layout,
    // Caps: 0 = unlimited. autoGrid/centerTile have hardcoded geometry ranges
    // (see capFor for fallback semantics); leftTile/rightTile scale freely.
    capAutoGrid:        Math.round(clamp(cfg("CapAutoGrid", 12),        0, 12)),
    capCenterTile:      Math.round(clamp(cfg("CapCenterTile", 9),       0, 9)),
    capLeftTile:        Math.round(clamp(cfg("CapLeftTile", 9),         0, 12)),
    capRightTile:       Math.round(clamp(cfg("CapRightTile", 9),        0, 12)),
    // Unified master column fraction — used by centerTile (N>=3),
    // leftTile (N>=2), rightTile (N>=2). Sides derive as (1 - master) / 2.
    masterWidth:                    clamp(cfg("MasterWidth", 0.5),      0.15, 0.85),
    // Non-master column count for leftTile/rightTile. 0 = auto (ultrawide
    // aspect ratio > 2.0 -> 2 cols, else 1); 1 or 2 = explicit override.
    // centerTile ignores this (its column layout is intrinsic).
    nonMasterColumns:   Math.round(clamp(cfg("NonMasterColumns", 0),    0, 2)),
    outerGap:           Math.round(clamp(cfg("OuterGap", 0),  0, 80)),
    innerGap:           Math.round(clamp(cfg("InnerGap", 0),  0, 80)),
    borderlessWhenTiled:                cfg("BorderlessWhenTiled", false),
    alwaysFloat:        alwaysFloat,
  };
})();

// Persistence: KWin scripts have readConfig but no writeConfig, so runtime
// state (MasterWidth writes from mouse resize, per-key layout overrides, row
// splits, inter-column splits) can only be persisted through an external
// helper. `dev.jtekk.KwiltConfigWriter` is a small Python daemon (installed
// by scripts/install-persistence.sh) that receives Write(key, value) calls
// and shells out to kwriteconfig6. If the daemon isn't installed, callDBus
// silently fails and state stays session-only — Kwilt still works, changes
// just don't survive a script reload.
const PERSIST_BUS   = "dev.jtekk.KwiltConfigWriter";
const PERSIST_PATH  = "/dev/jtekk/KwiltConfigWriter";
const PERSIST_IFACE = "dev.jtekk.KwiltConfigWriter";

function saveConfig(key, value) {
  if (typeof callDBus !== "function") return;
  callDBus(PERSIST_BUS, PERSIST_PATH, PERSIST_IFACE, "Write",
           String(key), String(value));
}

// Parse a persisted JSON-object blob into a Map. Empty / missing / malformed
// entries fall back to an empty Map — matching the "no persisted state"
// default without special-casing at every read site.
function readJsonMap(key) {
  const raw = cfg(key, "");
  if (!raw) return new Map();
  try {
    const obj = JSON.parse(String(raw));
    if (!obj || typeof obj !== "object") return new Map();
    const m = new Map();
    for (const k of Object.keys(obj)) m.set(k, obj[k]);
    return m;
  } catch (e) {
    log("readJsonMap(" + key + ") parse failed: " + e);
    return new Map();
  }
}

// Layout choice is per-(output, virtualDesktop). `layouts` holds explicit
// per-key overrides; missing entries fall back to CFG.layout (the
// kwinrc-tunable global default). setLayoutFor / cycleLayout mutate a
// single key; new (output, desktop) combos inherit CFG.layout on first
// read via layoutFor.
//
// CAPS is a lookup table by layout name. monocle and dual are fixed-cap
// layouts — their cap defines the layout (1 visible / 2 visible) and
// isn't configurable. capFor(key) resolves the cap for whatever layout is
// active on that key.
const layouts = new Map();
const CAPS = {
  autoGrid:   CFG.capAutoGrid,
  centerTile: CFG.capCenterTile,
  monocle:    1,
  dual:       2,
  leftTile:   CFG.capLeftTile,
  rightTile:  CFG.capRightTile,
  // floating never tiles anything — isTileable short-circuits, the queue
  // stays empty, so cap is never resolved. The 0 is bookkeeping.
  floating:   0,
};

function layoutFor(key) { return layouts.get(key) || CFG.layout; }

// Resolve the visible cap for a key's active layout. 0 in the CFG means
// "unlimited": leftTile/rightTile scale to arbitrary N via row splits, so
// they get MAX_SAFE_INTEGER (effectively no cap). autoGrid and centerTile
// have hardcoded geometry ranges — falling back to their natural max is
// the least-surprising translation of "unlimited" for them. A one-shot
// warning at init tells the user which fallback applied.
function capFor(key) {
  const layout = layoutFor(key);
  const raw = CAPS[layout];
  if (raw > 0) return raw;
  if (layout === "leftTile" || layout === "rightTile") return Number.MAX_SAFE_INTEGER;
  if (layout === "autoGrid")   return 12;
  if (layout === "centerTile") return 9;
  return raw;
}

// Split index for a queue on `key` — everything before is knocked-out, from
// here on is visible. Every place that reasons about knocked/visible slices
// derives it from `q.length - capFor(key)` clamped to zero; the helper names
// that convention so the arithmetic doesn't have to be re-parsed at each site.
function splitOf(key, q) { return Math.max(0, q.length - capFor(key)); }

// True when the work area's aspect ratio exceeds 2:1 — the trigger for the
// NonMasterColumns "auto" mode to pick 2 columns instead of 1. Guards
// against zero height (defensive; work areas shouldn't be zero-height).
function isUltrawide(area) {
  return area.height > 0 && (area.width / area.height) > 2.0;
}

// Resolve the effective non-master column count for a work area. Explicit
// CFG values (1 or 2) win; 0 (auto) reads the aspect ratio.
function effectiveNonMasterColumns(area) {
  const c = CFG.nonMasterColumns;
  if (c === 1 || c === 2) return c;
  return isUltrawide(area) ? 2 : 1;
}

// App-launcher shortcuts are NOT registered here. KWin scripts can't spawn
// processes (no exec/spawn API; callDBus → systemd-run doesn't marshal the
// nested-variant ExecStart arg). Launcher bindings live in KDE's native
// Custom Shortcuts mechanism and are seeded by scripts/setup-shortcuts.sh
// (which also clears Plasma KWin defaults like Quick Tile that conflict
// with the window-mgmt shortcuts below).

// Map<string, Window[]>: key = `${outputId}|${desktopId}`
const queues = new Map();

// Map<string, Window>: key = `${outputId}|${desktopId}` — the pinned "master"
// window for that (output, desktop). At most one pin per key. Session-only:
// not persisted across script reload. applyPin (called from applyQueue) is
// what makes it take effect by reordering the queue so the pin lands at the
// visible[0] slot; toggleMasterPin (Meta+S) sets/clears it.
const pins = new Map();

// Map<string, Window>: key = `${outputId}|${desktopId}` — the current
// visible[0] occupant of that key's queue. Recorded at the end of every
// applyQueue and consulted at the start of the next one, so cap-based FIFO
// eviction skips the master slot: overflow evicts visible[1] instead of
// visible[0]. Distinct from `pins` — pin is a user-explicit lock on a
// specific window's identity; this tracks the slot's current occupant, which
// changes naturally as the user drag-swaps or as the master closes. Session-
// only. cap==1 (monocle) is a natural no-op (no visible[1] to sacrifice).
const masters = new Map();

// Map<string, number[]>: key = `${queueKey}|${layout}|${column}` — per-column
// row-height ratios for centerTile and (2-col mode) leftTile/rightTile.
// Ratios sum to 1 and have one entry per row in that column. Missing entries
// (or a length mismatch when the column's row count has changed since state
// was written) fall back to equal splits — keeps user-adjusted splits stable
// at a specific N without needing per-N state buckets. Session-only, like
// pins — persistence is a shared write-path follow-up.
//
// Column names:
//   centerTile:                  "left" | "right"
//   leftTile / rightTile 2-col:  "inner" (closer to master) | "outer"
//   leftTile / rightTile 1-col:  "single"
const rowSplits = new Map();

// Map<string, number>: key = `${queueKey}|${layout}` (layout in {leftTile,
// rightTile}), value = inner-column fraction of the non-master area in 2-col
// mode. Default 0.5 (equal halves). Session-only.
const interColSplits = new Map();

function interColSplitKey(queueKey, layout) {
  return queueKey + "|" + layout;
}

function interColSplitFor(queueKey, layout) {
  const v = interColSplits.get(interColSplitKey(queueKey, layout));
  return typeof v === "number" ? v : 0.5;
}

function rowSplitKey(queueKey, layout, column) {
  return queueKey + "|" + layout + "|" + column;
}

function rowSplitFor(queueKey, layout, column, expectedRows) {
  const rs = rowSplits.get(rowSplitKey(queueKey, layout, column));
  return (rs && rs.length === expectedRows) ? rs : null;
}

// Serialize the whole Map to a JSON object under one kwinrc key. Cheap for
// the sizes we deal with (dozens of entries at worst); the alternative of
// one config key per entry needs a separate enumeration mechanism because
// KWin's readConfig can't list keys — the blob is simpler.
function serializeMap(m, valueOk) {
  const obj = {};
  m.forEach(function (v, k) {
    if (!valueOk || valueOk(v)) obj[k] = v;
  });
  return JSON.stringify(obj);
}

function savePerKeyLayouts() {
  saveConfig("PerKeyLayoutsJson",
             serializeMap(layouts, function (v) { return typeof v === "string"; }));
}

function saveRowSplitsAll() {
  saveConfig("RowSplitsJson",
             serializeMap(rowSplits, function (v) { return Array.isArray(v); }));
}

function saveInterColSplitsAll() {
  saveConfig("InterColSplitsJson",
             serializeMap(interColSplits, function (v) { return typeof v === "number"; }));
}

// Hydrate session Maps from persisted state written by prior sessions via the
// KwiltConfigWriter helper. Runs at script load, before init() retiles.
// PerKeyLayoutsJson entries are validated against VALID_LAYOUTS so a stale
// or renamed layout doesn't strand a queue on an unknown mode.
(function hydrate() {
  function hydrateInto(configKey, target, ok) {
    const parsed = readJsonMap(configKey);
    parsed.forEach(function (v, k) { if (ok(v)) target.set(k, v); });
    return parsed.size;
  }
  const nL = hydrateInto("PerKeyLayoutsJson", layouts,
                         function (v) { return typeof v === "string" && VALID_LAYOUTS.indexOf(v) !== -1; });
  const nR = hydrateInto("RowSplitsJson", rowSplits, Array.isArray);
  const nI = hydrateInto("InterColSplitsJson", interColSplits,
                         function (v) { return typeof v === "number"; });
  if (nL + nR + nI > 0) {
    log("hydrated persisted state: " + nL + " layout(s), " +
        nR + " row-split(s), " + nI + " inter-col split(s)");
  }
})();

// Turn row ratios (or an equal-split fallback) into concrete {y, h} pairs
// summing to totalH. The last row absorbs floor-rounding remainder so the
// column ends exactly at totalH.
function computeRowRects(totalH, count, ratios) {
  const rs = ratios || Array.from({length: count}, function () { return 1 / count; });
  const rows = [];
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const rh = (i === count - 1) ? totalH - acc : Math.floor(rs[i] * totalH);
    rows.push({ y: acc, h: rh });
    acc += rh;
  }
  return rows;
}

// Slot orderings for centerTile at N=3..9. Drives both geometriesCenterTile
// (tile placement) and centerTileSlotMeta (resize -> row-split routing) so
// the mapping stays authoritative in one place.
const CENTER_TILE_ORDER = {
  3: { left: [1],          right: [2] },
  4: { left: [1, 3],       right: [2] },
  5: { left: [1, 3],       right: [2, 4] },
  6: { left: [1, 3, 5],    right: [2, 4] },
  7: { left: [1, 3, 5],    right: [2, 4, 6] },
  8: { left: [1, 3, 5, 7], right: [2, 4, 6] },
  9: { left: [1, 3, 5, 7], right: [2, 4, 6, 8] },
};

// Map a centerTile visible slot -> {column, row, colRows}. Slot 0 (master)
// and out-of-range N return null.
function centerTileSlotMeta(slotIdx, n) {
  if (slotIdx === 0) return null;
  if (n < 3 || n > 9) return null;
  const order = CENTER_TILE_ORDER[n];
  const li = order.left.indexOf(slotIdx);
  if (li !== -1) return { column: "left",  row: li, colRows: order.left.length };
  const ri = order.right.indexOf(slotIdx);
  if (ri !== -1) return { column: "right", row: ri, colRows: order.right.length };
  return null;
}

// Map a side-tile (leftTile / rightTile) visible slot -> {column, row,
// colRows}. `nmCols` is the effective non-master column count (1 or 2). With
// nmCols===1 OR n_nm===1 the non-master area collapses to a single wide
// column stacked vertically. Otherwise it's the 2-column fill algorithm used
// by geometriesSideTile:
//   slot 1 -> col_inner row 0
//   slot 2 -> col_outer row 0
//   slot k>=3: k odd -> col_outer row (k-1)/2 ; k even -> col_inner row k/2-1
// Row counts: inner = floor(n_nm/2), outer = ceil(n_nm/2). Returns null for
// slot 0 (master has no side-tile meta) and n_nm < 2 (no rows to split).
function sideTileSlotMeta(slotIdx, n_nm, nmCols) {
  if (slotIdx === 0) return null;
  if (n_nm < 2)      return null;
  if (nmCols === 1 || n_nm === 1) {
    return { column: "single", row: slotIdx - 1, colRows: n_nm };
  }
  const innerRows = Math.floor(n_nm / 2);
  const outerRows = Math.ceil(n_nm / 2);
  if (slotIdx === 1) return { column: "inner", row: 0, colRows: innerRows };
  if (slotIdx === 2) return { column: "outer", row: 0, colRows: outerRows };
  if (slotIdx % 2 === 1) return { column: "outer", row: (slotIdx - 1) / 2, colRows: outerRows };
  return { column: "inner", row: slotIdx / 2 - 1, colRows: innerRows };
}

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
  // Per-window float opt-out. Set by toggleFloat (Meta+\). Wins over every
  // other check — a floated window stays untracked even if it would otherwise
  // qualify. The `=== true` guard means "unset" defaults to tileable, so
  // fresh windows aren't accidentally floated.
  if (w._kwiltFloat === true) return false;
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
  // User-configured float-list. Substring match against resourceClass
  // OR resourceName (both lowercased) — case-insensitive, partial OK so
  // "kcalc" matches "kcalc.kcalc" etc. Empty list short-circuits.
  if (CFG.alwaysFloat.length > 0) {
    const rc = (w.resourceClass || "").toLowerCase();
    const rn = (w.resourceName || "").toLowerCase();
    for (const pat of CFG.alwaysFloat) {
      if (rc.indexOf(pat) !== -1 || rn.indexOf(pat) !== -1) return false;
    }
  }
  // Per-key floating: if this window's (output, virtualDesktop) is set to the
  // "floating" layout, nothing on that key tiles. Deferred to the end so all
  // other rejections still apply (dialogs, popups, fullscreen, etc. stay
  // non-tileable regardless of the key's layout).
  if (layoutFor(keyFor(w.output, singleDesktop(w))) === "floating") return false;
  return true;
}

function workArea(out, desk) {
  return workspace.clientArea(KWin.MaximizeArea, out, desk);
}

// Enumerate every top-level window KWin knows about. `windowList` is the
// Plasma 6 name; `clientList` is retained for older KWin builds — either can
// be the injected global depending on which vintage of KWin is running.
function allWindows() {
  if (workspace.windowList) return workspace.windowList();
  if (workspace.clientList) return workspace.clientList();
  return [];
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
function geometriesCenterTile(n, area, queueKey) {
  const x = area.x, y = area.y, w = area.width, h = area.height;
  if (n <= 0) return [];

  // N=1: single window fills the entire work area. (Matches leftTile /
  // rightTile N=1 behavior — "1 window = full".)
  if (n === 1) return [rect(x, y, w, h)];

  // N=2: two windows share the work area using MasterWidth. Consistent with
  // leftTile / rightTile N=2 — a single "master" boundary the user can drag.
  if (n === 2) {
    const mw = Math.floor(CFG.masterWidth * w);
    return [
      rect(x, y, mw, h),
      rect(x + mw, y, w - mw, h),
    ];
  }

  // N>=3: center master + left/right side columns. Master width from
  // MasterWidth; sides derive as (1 - MasterWidth) / 2 each; center absorbs
  // any floor-rounding remainder. Slot -> (column, row) via
  // CENTER_TILE_ORDER; row heights per column come from rowSplits state
  // (falls back to equal splits when the length doesn't match).
  const nEff = Math.min(n, 9);
  const order = CENTER_TILE_ORDER[nEff];
  const sideW = Math.floor(((1 - CFG.masterWidth) / 2) * w);
  const centerW = w - 2 * sideW;
  const leftX = x;
  const centerX = x + sideW;
  const rightX = x + sideW + centerW;

  const leftRows  = order.left.length;
  const rightRows = order.right.length;
  const leftRatios  = queueKey ? rowSplitFor(queueKey, "centerTile", "left",  leftRows)  : null;
  const rightRatios = queueKey ? rowSplitFor(queueKey, "centerTile", "right", rightRows) : null;
  const leftRects   = computeRowRects(h, leftRows,  leftRatios);
  const rightRects  = computeRowRects(h, rightRows, rightRatios);

  const tiles = new Array(nEff);
  tiles[0] = rect(centerX, y, centerW, h);
  order.left.forEach(function (slot, i) {
    tiles[slot] = rect(leftX,  y + leftRects[i].y,  sideW, leftRects[i].h);
  });
  order.right.forEach(function (slot, i) {
    tiles[slot] = rect(rightX, y + rightRects[i].y, sideW, rightRects[i].h);
  });
  return tiles;
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

// Shared geometry for leftTile (masterOnLeft=true) and rightTile
// (masterOnLeft=false). Master column anchored to one side at
// CFG.masterWidth * area.width; non-master area on the other side splits
// into 1 or 2 columns via effectiveNonMasterColumns(area).
//
// 2-column fill order (interpretation A — outer column grows first each
// pair):
//   non_master[1] -> col_inner row 1
//   non_master[2] -> col_outer row 1
//   for k = 3..n_nm:
//     k odd  -> col_outer row ceil(k/2)
//     k even -> col_inner row k/2
// Row counts: col_inner = floor(n_nm/2), col_outer = ceil(n_nm/2). Last row
// in each column absorbs any floor-rounding remainder in height.
//
// N=1 fills the full area (matches centerTile N=1 and the "1 window = full"
// user spec). n_nm == 1 in 2-col mode collapses to one wide column.
function geometriesSideTile(n, area, masterOnLeft, queueKey) {
  if (n <= 0) return [];
  const x = area.x, y = area.y, w = area.width, h = area.height;
  if (n === 1) return [rect(x, y, w, h)];

  const layout = masterOnLeft ? "leftTile" : "rightTile";
  const n_nm = n - 1;
  const masterW = Math.floor(CFG.masterWidth * w);
  const nmW = w - masterW;
  const masterX = masterOnLeft ? x : x + nmW;
  const nmX     = masterOnLeft ? x + masterW : x;
  const master = rect(masterX, y, masterW, h);

  const nmCols = effectiveNonMasterColumns(area);

  // 1-column non-master area OR exactly 1 non-master: single wide vertical
  // stack. Row heights from rowSplits state ("single" column), else equal
  // splits.
  if (nmCols === 1 || n_nm === 1) {
    if (n_nm === 1) return [master, rect(nmX, y, nmW, h)];
    const ratios = queueKey ? rowSplitFor(queueKey, layout, "single", n_nm) : null;
    const rects = computeRowRects(h, n_nm, ratios);
    const tiles = [master];
    for (let i = 0; i < n_nm; i++) {
      tiles.push(rect(nmX, y + rects[i].y, nmW, rects[i].h));
    }
    return tiles;
  }

  // 2-column non-master area with n_nm >= 2. Inner-column fraction of the
  // non-master area comes from interColSplits state (default 0.5); the outer
  // column absorbs any floor-rounding remainder.
  const innerFrac = queueKey ? interColSplitFor(queueKey, layout) : 0.5;
  const colInnerW = Math.floor(innerFrac * nmW);
  const colOuterW = nmW - colInnerW;
  const colInnerX = masterOnLeft ? nmX             : nmX + colOuterW;
  const colOuterX = masterOnLeft ? nmX + colInnerW : nmX;

  const innerRows = Math.floor(n_nm / 2);
  const outerRows = Math.ceil(n_nm / 2);
  const innerRatios = queueKey ? rowSplitFor(queueKey, layout, "inner", innerRows) : null;
  const outerRatios = queueKey ? rowSplitFor(queueKey, layout, "outer", outerRows) : null;
  const innerRects = computeRowRects(h, innerRows, innerRatios);
  const outerRects = computeRowRects(h, outerRows, outerRatios);

  function cellRect(colX, colW, rects, rowIdx) {
    return rect(colX, y + rects[rowIdx].y, colW, rects[rowIdx].h);
  }

  const tiles = [master];
  // non_master[1] -> col_inner row 0, non_master[2] -> col_outer row 0
  tiles.push(cellRect(colInnerX, colInnerW, innerRects, 0));
  tiles.push(cellRect(colOuterX, colOuterW, outerRects, 0));

  for (let k = 3; k <= n_nm; k++) {
    if (k % 2 === 1) {
      tiles.push(cellRect(colOuterX, colOuterW, outerRects, (k - 1) / 2));
    } else {
      tiles.push(cellRect(colInnerX, colInnerW, innerRects, k / 2 - 1));
    }
  }
  return tiles;
}

function geometriesLeftTile(n, area, key)  { return geometriesSideTile(n, area, true,  key); }
function geometriesRightTile(n, area, key) { return geometriesSideTile(n, area, false, key); }

// floating — no tile geometry. isTileable returns false for any window on a
// key whose layout is "floating", so the queue is empty and applyQueue never
// asks for rects. This stub only exists to satisfy the LAYOUTS[name] check
// in setLayoutFor and cycleLayout's key iteration.
function geometriesFloating() { return []; }

const LAYOUTS = {
  autoGrid:   geometriesAutoGrid,
  centerTile: geometriesCenterTile,
  monocle:    geometriesMonocle,
  dual:       geometriesDual,
  leftTile:   geometriesLeftTile,
  rightTile:  geometriesRightTile,
  floating:   geometriesFloating,
};

function geometries(key, n, area) {
  return LAYOUTS[layoutFor(key)](n, area, key);
}

// Apply user-configured gaps as a post-processing pass on layout rects.
// Edges that touch the work area's edge shrink by OuterGap; interior edges
// (between tiles) shrink by half of InnerGap on each side, so adjacent
// tiles' combined retreat equals InnerGap. Floor/ceil split keeps the math
// integer-clean when InnerGap is odd. With both gaps at 0 (the default)
// this is a no-op and the layout's raw rects are returned unchanged.
function applyGaps(rects, area) {
  if (CFG.outerGap === 0 && CFG.innerGap === 0) return rects;
  const og = CFG.outerGap;
  const igLo = Math.floor(CFG.innerGap / 2);
  const igHi = CFG.innerGap - igLo;
  const ax2 = area.x + area.width;
  const ay2 = area.y + area.height;
  return rects.map(function (r) {
    const left   = r.x === area.x          ? og : igLo;
    const top    = r.y === area.y          ? og : igLo;
    const right  = (r.x + r.width)  === ax2 ? og : igHi;
    const bottom = (r.y + r.height) === ay2 ? og : igHi;
    return {
      x: r.x + left,
      y: r.y + top,
      width:  Math.max(1, r.width  - left - right),
      height: Math.max(1, r.height - top  - bottom),
    };
  });
}

// tilesFor is the single source of truth for the final, gap-adjusted tile
// rects used by applyQueue (geometry assignment), handleDrop (drop hit-test),
// and tileSlotOf (focus/swap neighbor search). Layout functions stay pure.
function tilesFor(key, n, area) {
  return applyGaps(geometries(key, n, area), area);
}

// Border-toggle helpers. Save the window's original `noBorder` on first
// force so we can put it back exactly the way we found it; restore is a
// no-op if we never forced. `_kwiltBorderForced` is a Qt dynamic property
// — same persistence-across-reload caveat as `_kwiltBound`, which is why
// init's loop resets both before re-binding signals.
function forceNoBorder(w) {
  if (!CFG.borderlessWhenTiled) return;
  if (typeof w.noBorder === "undefined") return;
  if (w._kwiltBorderForced) return;
  w._kwiltOrigNoBorder = w.noBorder;
  w.noBorder = true;
  w._kwiltBorderForced = true;
}

function restoreBorder(w) {
  if (!w || !w._kwiltBorderForced) return;
  if (typeof w.noBorder !== "undefined") {
    w.noBorder = w._kwiltOrigNoBorder;
  }
  w._kwiltBorderForced = false;
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

// In-place swap of two array elements. Named because half a dozen queue
// mutations (pin, master-exempt reflow, drag-drop, swap-by-direction) all
// need it and the three-line tmp dance obscures the higher-level intent.
function swap(arr, i, j) { const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }

// Resolve `w`'s (output, virtualDesktop) pair. Returns null if either can't
// be pinned down (window on all desktops, output missing, etc.) — every site
// that needs both together also needs to bail on either being absent, so the
// null return matches the shape callers already had.
function outputAndDesk(w) {
  if (!w) return null;
  const desk = singleDesktop(w);
  if (!desk || !w.output) return null;
  return { out: w.output, desk: desk };
}

// Move a knocked-out queue entry to the tail (newest visible) and retile.
// Both external un-minimize and taskbar-activation call this shape. Callers
// do the `found.idx < split` gate themselves since that test needs the
// queue's cap context.
function promoteKnockedToNewest(found) {
  const w = found.q[found.idx];
  found.q.splice(found.idx, 1);
  found.q.push(w);
  retileKey(found.key);
}

// If a pin exists on `key` and the pinned window is currently in the queue's
// visible slice, swap it into the queue position that maps to visible[0].
// No-op when the pin isn't set, isn't in this queue right now (maximized /
// fullscreened / temporarily out), or is knocked out — pin persists silently
// in those cases and re-takes visible[0] as soon as it's visible again. Sticky
// under drag-swap: dropping another tile onto the master position gets undone
// on the next retile as the pin swaps back.
function applyPin(q, key, split) {
  const pinned = pins.get(key);
  if (!pinned) return;
  const idx = q.indexOf(pinned);
  if (idx === -1 || idx <= split) return;
  swap(q, split, idx);
}

// Clear any pin entry pointing at `w` (there is at most one per window, since
// a window is only in one queue). Called from onWindowClosed so terminated
// windows don't leave dead refs in the pin map.
function clearPinsFor(w) {
  for (const [k, pw] of pins) {
    if (pw === w) { pins.delete(k); return; }
  }
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
  // Master-slot exemption: if a previous apply recorded a master for this
  // key and it's still in the queue, swap it to q[split] so cap-based FIFO
  // eviction knocks visible[1] (old second-oldest visible) instead of
  // visible[0]. No-op when there's no overflow (split===0), when cap<2
  // (monocle has no visible[1] to sacrifice), or when the master already
  // holds q[split]. Runs BEFORE applyPin so an explicit pin still wins.
  const cap = capFor(key);
  const split = Math.max(0, q.length - cap);
  if (cap >= 2 && split > 0) {
    const master = masters.get(key);
    if (master) {
      const mIdx = q.indexOf(master);
      if (mIdx !== -1 && mIdx !== split) swap(q, split, mIdx);
    }
  }
  applyPin(q, key, split);
  const knocked = q.slice(0, split);
  const visible = q.slice(split);
  const geos = tilesFor(key, visible.length, workArea(out, desk));
  for (const w of knocked) {
    if (!w.minimized) w.minimized = true;
  }
  visible.forEach(function (w, i) {
    if (w.minimized) w.minimized = false;
    // Unmaximize before setting geometry, else maximize state overrides us —
    // but skip the KWin roundtrip when already in Restore mode, which is the
    // common case. Also avoids the setMaximize→maximizedChanged self-signal
    // path taking a needless lap through findContaining.
    if (w.maximizable && maximizeMode(w) !== 0) w.setMaximize(false, false);
    forceNoBorder(w);
    w.frameGeometry = geos[i];
  });
  // Record the current master for the next apply's exemption check.
  if (visible.length > 0) masters.set(key, visible[0]);
  else masters.delete(key);
  log("apply " + key + " n=" + q.length + " visible=" + visible.length + " knocked=" + knocked.length);
}

function retileKey(key) {
  const q = queues.get(key);
  if (!q || q.length === 0) { queues.delete(key); masters.delete(key); return; }
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

// `found` is optional. Callers that already resolved `findContaining(w)`
// pass it in to skip the second walk over every queue; internal callers
// omit it and pay the lookup once.
function untrack(w, found) {
  found = found || findContaining(w);
  if (!found) return null;
  found.q.splice(found.idx, 1);
  restoreBorder(w);
  return found.key;
}

function migrate(w) {
  const oldKey = untrack(w);
  const newKey = track(w);
  // Pin travels with the window across (output, desktop) changes. If the
  // window isn't tileable at the new key (newKey === null), the pin drops.
  if (oldKey && pins.get(oldKey) === w) {
    pins.delete(oldKey);
    if (newKey && newKey !== oldKey) pins.set(newKey, w);
  }
  if (oldKey && oldKey !== newKey) retileKey(oldKey);
  if (newKey) retileKey(newKey);
}

// External state-change handlers. The minimized/fullScreen handlers
// distinguish our own writes (which match the window's queue position) from
// external user actions (which don't) by checking whether the window's new
// state matches its queue-side expectation.
function onMinimizedChanged(w) {
  const found = findContaining(w);
  if (!found) {
    // Window isn't in any queue. If it just came back from a user-driven
    // minimize (we untrack on external minimize — see the `if (w.minimized)`
    // branch below), bring it back into the layout. Re-track puts it at the
    // most-recent visible slot, mirroring the promote-on-activate behavior
    // for knocked windows. Without this, un-minimizing a previously-tiled
    // window left it floating instead of re-tiling.
    if (!w.minimized && isTileable(w)) {
      const key = track(w);
      if (key) retileKey(key);
    }
    return;
  }
  const split = splitOf(found.key, found.q);
  if (w.minimized) {
    // User minimized a visible tile (taskbar / title-bar button / app). Honor
    // it: drop from the queue so the tile slot collapses instead of leaving
    // a ghost slot. Knocked-slice transitions are our own — no-op.
    if (found.idx >= split) {
      untrack(w, found);
      retileKey(found.key);
    }
  } else {
    // External un-minimize. If it's a knocked window coming back, promote it
    // like activation. Visible-slice transitions are our own — no-op.
    if (found.idx < split) promoteKnockedToNewest(found);
  }
}

// Shared body for the fullscreen / maximize signal handlers. When `blocking`
// is true (window went fullscreen or maximized), drop it from its queue and
// let it float at whatever geometry KWin chose. When false (external un-
// block), re-track and reflow. applyQueue's own `setMaximize(false, false)`
// also fires this via onMaximizedChanged, but the window is already in its
// queue then — the re-track branch short-circuits on `!found`, the untrack
// branch sees Restore mode. No recursion.
// Read the current maximize mode (0 = Restore, non-zero = some kind of
// maximize). Prefers `requestedMaximizeMode` because it reflects the target
// state during a transition; falls back to `maximizeMode` on KWin builds that
// don't expose the requested form. Returns 0 when neither is available.
function maximizeMode(w) {
  if (typeof w.requestedMaximizeMode !== "undefined") return w.requestedMaximizeMode;
  if (typeof w.maximizeMode !== "undefined") return w.maximizeMode;
  return 0;
}

function reconcileBlocked(w, blocking) {
  const found = findContaining(w);
  if (blocking) {
    if (found) {
      untrack(w, found);
      retileKey(found.key);
    }
  } else if (!found && isTileable(w)) {
    const newKey = track(w);
    if (newKey) retileKey(newKey);
  }
}

function onFullScreenChanged(w) { reconcileBlocked(w, w.fullScreen); }

// KWin::MaximizeMode: 0 = Restore (none), 1 = Vertical, 2 = Horizontal,
// 3 = Full — anything non-zero means the user asked for some kind of
// maximize.
function onMaximizedChanged(w) { reconcileBlocked(w, maximizeMode(w) !== 0); }

// Some windows die without windowRemoved firing reliably (apps that exit
// abruptly, transient surfaces, etc.). Listening to per-window `closed`
// catches those cases and prevents stale refs from squatting on tile slots.
function onWindowClosed(w) {
  clearPinsFor(w);
  const key = untrack(w);
  if (key) retileKey(key);
}

function bindWindow(w) {
  if (w._kwiltBound) return;
  w._kwiltBound = true;
  if (w.outputChanged) w.outputChanged.connect(function () { migrate(w); });
  if (w.desktopsChanged) w.desktopsChanged.connect(function () { migrate(w); });
  if (w.minimizedChanged) w.minimizedChanged.connect(function () { onMinimizedChanged(w); });
  if (w.fullScreenChanged) w.fullScreenChanged.connect(function () { onFullScreenChanged(w); });
  if (w.maximizedChanged) w.maximizedChanged.connect(function () { onMaximizedChanged(w); });
  if (w.closed) w.closed.connect(function () { onWindowClosed(w); });
  if (w.interactiveMoveResizeStarted) {
    w.interactiveMoveResizeStarted.connect(function () {
      w._kwiltDragMode = w.move ? "move" : (w.resize ? "resize" : null);
      w._kwiltResizeCtx = w._kwiltDragMode === "resize" ? captureResizeCtx(w) : null;
    });
  }
  if (w.interactiveMoveResizeFinished) {
    w.interactiveMoveResizeFinished.connect(function () {
      const mode = w._kwiltDragMode;
      const ctx  = w._kwiltResizeCtx;
      w._kwiltDragMode = null;
      w._kwiltResizeCtx = null;
      if (mode === "move") {
        handleDrop(w);
      } else if (mode === "resize") {
        if (ctx && handleResize(w, ctx)) return;
        // No adjustable boundary at this slot; tiles own geometry — snap back.
        const found = findContaining(w);
        if (found) retileKey(found.key);
      }
    });
  }
}

function handleDrop(w) {
  const found = findContaining(w);
  if (!found) return;

  const split = splitOf(found.key, found.q);
  const visible = found.q.slice(split);
  const srcVisIdx = visible.indexOf(w);
  if (srcVisIdx === -1) {
    // Source isn't in the visible set (shouldn't happen for a draggable window).
    retileKey(found.key);
    return;
  }

  const od = outputAndDesk(w);
  if (!od) { retileKey(found.key); return; }

  const area = workArea(od.out, od.desk);
  const tiles = tilesFor(found.key, visible.length, area);

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

  swap(found.q, split + srcVisIdx, split + dstVisIdx);
  // Drag-swap into the master slot: promote the new occupant to master so
  // the exemption swap in applyQueue doesn't snap the old master back into
  // visible[0] on the next retile. Only matters when the drop touched slot
  // 0 — swaps between two non-master tiles leave the master slot alone.
  if (srcVisIdx === 0 || dstVisIdx === 0) masters.set(found.key, found.q[split]);
  log("swap slot " + srcVisIdx + " <-> " + dstVisIdx);
  retileKey(found.key);
}

// Snapshot everything handleResize needs at resize-start: layout, queue key,
// the window's slot in the visible tile array, current work area, visible-N.
// Returns null when the window can't map cleanly to a slot (untracked, on
// multiple desktops, no output, or knocked-out) — handleResize is skipped on
// finish and the existing snap-back path runs like before.
function captureResizeCtx(w) {
  const found = findContaining(w);
  if (!found) return null;
  const od = outputAndDesk(w);
  if (!od) return null;
  const cap = capFor(found.key);
  const split = Math.max(0, found.q.length - cap);
  const slotIdx = found.idx - split;
  if (slotIdx < 0) return null;
  const fg = w.frameGeometry;
  return {
    layout: layoutFor(found.key),
    key: found.key,
    slotIdx: slotIdx,
    area: workArea(od.out, od.desk),
    n: Math.min(found.q.length, cap),
    // Drag-start geometry snapshot so handleResize can detect which edge
    // moved (top vs bottom for vertical drags) and compute delta ratios
    // against a stable baseline instead of reconstructing from CFG.
    startFg: { x: fg.x, y: fg.y, width: fg.width, height: fg.height },
  };
}

// Translate a finished interactive resize into tunable + row-split updates.
// Returns true when at least one update landed and retileKey was scheduled;
// false when nothing changed (caller falls back to snap-back).
//
// Width delta -> tryUpdateMasterWidth (existing back-solve for MasterWidth).
// Height delta -> tryUpdateRowSplit (adjust row-height ratios in the slot's
// column). Both can fire in the same drag if the user resized diagonally.
//
// Writes are IN-MEMORY: KWin's script API exposes readConfig but not
// writeConfig, so new values survive until the next script reload (login,
// KCM save, dev cycle). Persistence via kwriteconfig6-through-callDBus is
// a follow-up — same write-path problem as the 0.8.0 anchor.
function handleResize(w, ctx) {
  const fg = w.frameGeometry;
  const startFg = ctx.startFg;

  // Skip drags that didn't materially move either dimension (< 2 px).
  const widthChanged  = Math.abs(fg.width  - startFg.width)  > 2;
  const heightChanged = Math.abs(fg.height - startFg.height) > 2;
  if (!widthChanged && !heightChanged) return false;

  let updated = false;
  if (widthChanged) {
    updated = tryUpdateMasterWidth(ctx, fg)    || updated;
    updated = tryUpdateInterColSplit(ctx, fg)  || updated;
  }
  if (heightChanged) updated = tryUpdateRowSplit(ctx, fg) || updated;

  if (updated) retileKey(ctx.key);
  return updated;
}

// Back-solve CFG.masterWidth from the resized tile's new geometry — but only
// when the drag actually moved the master boundary. Each slot has a known
// "master-side edge" (the edge that borders the master column); if a
// different edge moved, MasterWidth stays put. Outer col in leftTile /
// rightTile 2-col mode has no master-side edge at all and always skips.
//
// For leftTile / rightTile 2-col inner col, we back-solve from the tile's
// LEFT-EDGE POSITION (leftTile) or RIGHT-EDGE POSITION (rightTile) so the
// formula is independent of the current inter-column split. Other slots use
// the width formula since sides are symmetric there.
function tryUpdateMasterWidth(ctx, fg) {
  const layout = ctx.layout;
  const isMaster = ctx.slotIdx === 0;
  const aw = ctx.area.width;
  const ax = ctx.area.x;
  const startFg = ctx.startFg;

  if (ctx.n === 1) return false;
  if (layout === "monocle" || layout === "dual" || layout === "autoGrid") return false;

  const leftEdgeMoved  = Math.abs(fg.x - startFg.x) > 2;
  const rightEdgeMoved = Math.abs((fg.x + fg.width) - (startFg.x + startFg.width)) > 2;

  let masterEdgeMoved;
  let masterFrac;
  if (layout === "centerTile") {
    if (isMaster) {
      // N=2 master has no left neighbor (area boundary); only RIGHT edge
      // borders non-master. N>=3 has both sides.
      masterEdgeMoved = ctx.n === 2 ? rightEdgeMoved : (leftEdgeMoved || rightEdgeMoved);
      masterFrac = fg.width / aw;
    } else if (ctx.n === 2) {
      // Slot 1 at N=2 is the right half; LEFT edge borders master.
      masterEdgeMoved = leftEdgeMoved;
      masterFrac = 1 - fg.width / aw;
    } else {
      const meta = centerTileSlotMeta(ctx.slotIdx, ctx.n);
      if (!meta) return false;
      masterEdgeMoved = meta.column === "left" ? rightEdgeMoved : leftEdgeMoved;
      masterFrac = 1 - 2 * (fg.width / aw);
    }
  } else if (layout === "leftTile" || layout === "rightTile") {
    const masterOnLeft = layout === "leftTile";
    if (isMaster) {
      masterEdgeMoved = masterOnLeft ? rightEdgeMoved : leftEdgeMoved;
      masterFrac = fg.width / aw;
    } else {
      const nmCols = effectiveNonMasterColumns(ctx.area);
      const singleWide = (nmCols === 1 || ctx.n === 2);
      if (singleWide) {
        masterEdgeMoved = masterOnLeft ? leftEdgeMoved : rightEdgeMoved;
        masterFrac = 1 - fg.width / aw;
      } else {
        const meta = sideTileSlotMeta(ctx.slotIdx, ctx.n - 1, 2);
        if (!meta || meta.column !== "inner") return false;
        // Edge-position back-solve — independent of the current inter-column
        // split. leftTile inner LEFT edge is master boundary; rightTile inner
        // RIGHT edge is master boundary.
        if (masterOnLeft) {
          masterEdgeMoved = leftEdgeMoved;
          masterFrac = (fg.x - ax) / aw;
        } else {
          masterEdgeMoved = rightEdgeMoved;
          masterFrac = (ax + aw - (fg.x + fg.width)) / aw;
        }
      }
    }
  } else {
    return false;
  }

  if (!masterEdgeMoved) return false;

  const clamped = clamp(masterFrac, 0.15, 0.85);
  if (Math.abs(clamped - CFG.masterWidth) < 0.005) return false;
  CFG.masterWidth = clamped;
  saveConfig("MasterWidth", clamped.toString());
  log("masterWidth = " + clamped.toFixed(3));
  return true;
}

// Update per-column row-split ratios from the resized tile's new height.
// Only fires for tiles with a vertical neighbor in their column that can
// absorb the delta. Which neighbor: detect from which edge moved (top y or
// bottom y+h). Rejects updates that would push either row below a 5%
// minimum. Skips when the slot is master or its column has only one row.
function tryUpdateRowSplit(ctx, fg) {
  const layout = ctx.layout;
  if (ctx.slotIdx === 0) return false;

  let meta;
  if (layout === "centerTile") {
    meta = centerTileSlotMeta(ctx.slotIdx, ctx.n);
  } else if (layout === "leftTile" || layout === "rightTile") {
    const n_nm = ctx.n - 1;
    const nmCols = effectiveNonMasterColumns(ctx.area);
    meta = sideTileSlotMeta(ctx.slotIdx, n_nm, nmCols);
  } else {
    return false;
  }
  if (!meta || meta.colRows < 2) return false;

  const startFg = ctx.startFg;
  const topEdgeMoved = Math.abs(fg.y - startFg.y) > 2;
  const botEdgeMoved = Math.abs((fg.y + fg.height) - (startFg.y + startFg.height)) > 2;

  let neighborRow;
  if (topEdgeMoved && meta.row > 0) {
    neighborRow = meta.row - 1;
  } else if (botEdgeMoved && meta.row < meta.colRows - 1) {
    neighborRow = meta.row + 1;
  } else {
    return false;
  }

  const totalH = ctx.area.height;
  const deltaRatio = (fg.height - startFg.height) / totalH;
  const currentRatios = rowSplitFor(ctx.key, layout, meta.column, meta.colRows);
  const ratios = currentRatios ? currentRatios.slice()
                               : Array.from({length: meta.colRows}, function () { return 1 / meta.colRows; });

  const newDragged  = ratios[meta.row]    + deltaRatio;
  const newNeighbor = ratios[neighborRow] - deltaRatio;
  const MIN = 0.05;
  if (newDragged < MIN || newNeighbor < MIN) return false;

  ratios[meta.row]    = newDragged;
  ratios[neighborRow] = newNeighbor;
  rowSplits.set(rowSplitKey(ctx.key, layout, meta.column), ratios);
  saveRowSplitsAll();
  log("rowSplit[" + layout + "|" + meta.column + "] row " + meta.row + " → " + newDragged.toFixed(3));
  return true;
}

// Update the inner-vs-outer column split when the user drags the boundary
// between the two non-master columns in leftTile / rightTile 2-col mode.
// Skips when the drag was on a different edge (master boundary is handled
// by tryUpdateMasterWidth; horizontal edges by tryUpdateRowSplit). Clamps
// the new inner fraction to [0.1, 0.9] to avoid collapsing either column.
function tryUpdateInterColSplit(ctx, fg) {
  const layout = ctx.layout;
  if (layout !== "leftTile" && layout !== "rightTile") return false;
  if (ctx.slotIdx === 0) return false;
  const n_nm = ctx.n - 1;
  const nmCols = effectiveNonMasterColumns(ctx.area);
  if (nmCols !== 2 || n_nm < 2) return false;

  const meta = sideTileSlotMeta(ctx.slotIdx, n_nm, nmCols);
  if (!meta) return false;

  const startFg = ctx.startFg;
  const leftEdgeMoved  = Math.abs(fg.x - startFg.x) > 2;
  const rightEdgeMoved = Math.abs((fg.x + fg.width) - (startFg.x + startFg.width)) > 2;

  // Which edge of this slot is the inter-column boundary?
  //   leftTile inner  -> RIGHT ;  leftTile outer  -> LEFT
  //   rightTile inner -> LEFT  ;  rightTile outer -> RIGHT
  const masterOnLeft = layout === "leftTile";
  let interColEdgeMoved;
  if (meta.column === "inner") {
    interColEdgeMoved = masterOnLeft ? rightEdgeMoved : leftEdgeMoved;
  } else {
    interColEdgeMoved = masterOnLeft ? leftEdgeMoved  : rightEdgeMoved;
  }
  if (!interColEdgeMoved) return false;

  // Only the inter-column boundary moved: the dragged tile's width IS its
  // column's new width (the OTHER edge stayed put). Back-solve inner
  // fraction of non-master area.
  const nmW = (1 - CFG.masterWidth) * ctx.area.width;
  if (nmW <= 0) return false;
  const colFrac = fg.width / nmW;
  const newInnerFrac = meta.column === "inner" ? colFrac : 1 - colFrac;

  const MIN = 0.1;
  const clamped = clamp(newInnerFrac, MIN, 1 - MIN);
  const cur = interColSplitFor(ctx.key, layout);
  if (Math.abs(clamped - cur) < 0.005) return false;
  interColSplits.set(interColSplitKey(ctx.key, layout), clamped);
  saveInterColSplitsAll();
  log("interColSplit[" + layout + "] = " + clamped.toFixed(3));
  return true;
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
    const split = splitOf(found.key, found.q);
    // Knocked-out window activated — promote to most-recent.
    if (found.idx < split) promoteKnockedToNewest(found);
  }
  if (w !== lastFocused) {
    prevFocused = lastFocused;
    lastFocused = w;
  }
}

// Resolve the (output, virtualDesktop) key of the currently focused window.
// Returns null when there's no active window or its (output, desktop) can't be
// determined — direct-set / cycle shortcuts log a warning and no-op in that
// case rather than mutating a random key.
function activeKey() {
  const od = outputAndDesk(workspace.activeWindow);
  return od ? keyFor(od.out, od.desk) : null;
}

// Set the layout on a specific (output, virtualDesktop) key. Missing keys
// inherit CFG.layout via layoutFor, so setting a key to the config default
// deletes its override — keeps the map from accumulating tombstone entries.
function setLayoutFor(key, name) {
  if (!LAYOUTS[name]) return;
  if (name === layoutFor(key)) return;
  const wasFloating = layoutFor(key) === "floating";
  const nowFloating = name === "floating";
  // Entering floating: un-minimize any windows currently knocked-out in this
  // key's queue. applyQueue's defensive prune will drop them from the queue
  // (isTileable=false under the new layout), and prune leaves their minimize
  // state untouched — without this pass they'd stay hidden after switching.
  if (nowFloating && !wasFloating) {
    const q = queues.get(key);
    if (q) {
      for (const w of q) { if (w.minimized) w.minimized = false; }
    }
  }
  if (name === CFG.layout) layouts.delete(key);
  else layouts.set(key, name);
  savePerKeyLayouts();
  // Leaving floating: no windows are tracked for this key (they were pruned
  // when we entered floating). Discover eligible windows from the workspace
  // and track them so retileKey has something to tile.
  if (wasFloating && !nowFloating) {
    for (const w of allWindows()) {
      const desk = singleDesktop(w);
      if (desk && w.output && keyFor(w.output, desk) === key) track(w);
    }
  }
  log("layout[" + key + "]=" + name + " cap=" + CAPS[name]);
  retileKey(key);
}

// Direct-set shortcuts (Meta+Ctrl+G/C/M/D) act on the ACTIVE (output,
// virtualDesktop). If there's no clear active key, log and skip.
function setLayout(name) {
  const key = activeKey();
  if (!key) { log("setLayout skipped: no active (output, desktop) key"); return; }
  setLayoutFor(key, name);
}

// Cycle the ACTIVE key's layout only. Other (output, desktop) keys stay put —
// this is the whole point of per-key overrides.
function cycleLayout() {
  const key = activeKey();
  if (!key) { log("cycleLayout skipped: no active (output, desktop) key"); return; }
  const names = Object.keys(LAYOUTS);
  const current = layoutFor(key);
  setLayoutFor(key, names[(names.indexOf(current) + 1) % names.length]);
}

// Toggle master pin on the active window: pin claims visible[0] on its
// (output, virtualDesktop) via applyPin. Pressing again on the same window
// clears the pin; pressing on a different window on the same key replaces
// the previous pin.
function toggleMasterPin() {
  const w = workspace.activeWindow;
  if (!w) return;
  const found = findContaining(w);
  if (!found) { log("pin skipped: window not tracked"); return; }
  if (pins.get(found.key) === w) {
    pins.delete(found.key);
    log("unpinned master on " + found.key);
  } else {
    pins.set(found.key, w);
    log("pinned '" + (w.resourceName || "?") + "' as master on " + found.key);
  }
  retileKey(found.key);
}

// Toggle per-window float opt-out on the active window. `_kwiltFloat` is a
// Qt dynamic property (session-only, dies with the window). When true,
// isTileable short-circuits — the window stays out of every queue and keeps
// whatever geometry the user gives it. Floating a tracked window untracks it,
// drops its master pin, and unminimizes if it was in a knocked-out slot;
// un-floating re-tracks (subject to the rest of isTileable) and retiles.
function toggleFloat() {
  const w = workspace.activeWindow;
  if (!w) return;
  const nowFloat = !(w._kwiltFloat === true);
  w._kwiltFloat = nowFloat;
  if (nowFloat) {
    const oldKey = untrack(w);
    if (oldKey && pins.get(oldKey) === w) pins.delete(oldKey);
    if (w.minimized) w.minimized = false;
    if (oldKey) retileKey(oldKey);
    log("floated '" + (w.resourceName || "?") + "'");
  } else {
    const newKey = track(w);
    if (newKey) retileKey(newKey);
    log("un-floated '" + (w.resourceName || "?") + "'");
  }
}

// tileSlotOf returns the visible-tile context of a window, or null if the
// window isn't tiled or is currently knocked out. Used by every keyboard-
// driven focus/swap so the layout's geometry function is the single source
// of truth for what "neighbor" means.
function tileSlotOf(w) {
  if (!w) return null;
  const found = findContaining(w);
  if (!found) return null;
  const split = splitOf(found.key, found.q);
  if (found.idx < split) return null;
  const od = outputAndDesk(w);
  if (!od) return null;
  const visibleCount = found.q.length - split;
  const tiles = tilesFor(found.key, visibleCount, workArea(od.out, od.desk));
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

// Resolve the active window's slot and the neighbor slot in `direction`.
// Returns null when there's no active tiled window OR no neighbor in that
// direction — both focus/swap handlers want to no-op on either failure.
function directionTarget(direction) {
  const slot = tileSlotOf(workspace.activeWindow);
  if (!slot) return null;
  const nextVis = neighborSlot(slot.visIdx, slot.tiles, direction);
  if (nextVis === -1) return null;
  return { slot: slot, nextVis: nextVis };
}

function focusByDirection(direction) {
  const t = directionTarget(direction);
  if (!t) return;
  const target = t.slot.found.q[t.slot.split + t.nextVis];
  if (target) {
    workspace.activeWindow = target;
    log("focus " + direction + " → vis " + t.nextVis);
  }
}

function swapByDirection(direction) {
  const t = directionTarget(direction);
  if (!t) return;
  swap(t.slot.found.q, t.slot.split + t.slot.visIdx, t.slot.split + t.nextVis);
  log("swap " + direction + " → vis " + t.nextVis);
  retileKey(t.slot.found.key);
}

function cycleFocus() {
  const w = workspace.activeWindow;
  if (!w) return;
  const found = findContaining(w);
  if (!found) return;
  const split = splitOf(found.key, found.q);
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
  const existing = allWindows();
  for (const w of existing) {
    // Stale Qt dynamic property from a prior script-load — clear so
    // bindWindow actually re-connects signals against the new JS engine.
    // Same goes for the border-force flag: if the prior engine forced
    // noBorder, the window still wears the forced state but we've lost
    // the JS-side bookkeeping. Restore the saved original before re-
    // forcing on the new track() pass, so toggling BorderlessWhenTiled
    // off mid-reload doesn't strand the window borderless.
    if (w._kwiltBorderForced && typeof w.noBorder !== "undefined" &&
        typeof w._kwiltOrigNoBorder !== "undefined") {
      w.noBorder = w._kwiltOrigNoBorder;
    }
    w._kwiltBorderForced = false;
    w._kwiltBound = false;
    const key = track(w);
    if (key) bindWindow(w);
  }
  retileAll();
  log("rebuilt queues from workspace.windowList()");
}

function init() {
  log("loaded; default layout=" + CFG.layout + " cap=" + CAPS[CFG.layout]);
  // Warn about cap=0 (unlimited) fallbacks on layouts with hardcoded geometry.
  // leftTile / rightTile scale to arbitrary N and don't warn.
  if (CFG.capAutoGrid   === 0) log("CapAutoGrid=0 (unlimited) → falls back to 12 (autoGrid geometry defined for N=1..12)");
  if (CFG.capCenterTile === 0) log("CapCenterTile=0 (unlimited) → falls back to 9 (centerTile geometry defined for N=1..9)");

  // Ping the persistence helper. Fire-and-forget with a callback: if the
  // service isn't installed (or the daemon crashed), the callback fires
  // with a null / non-string reply and we log the missing-helper hint.
  // Kwilt still works either way — the state just doesn't survive reload.
  if (typeof callDBus === "function") {
    callDBus(PERSIST_BUS, PERSIST_PATH, PERSIST_IFACE, "Ping",
             function (reply) {
               if (reply === "pong") {
                 log("persistence helper reachable (" + PERSIST_BUS + ")");
               } else {
                 log("persistence helper not detected; state changes will " +
                     "NOT persist across script reload. " +
                     "Run scripts/install-persistence.sh to enable.");
               }
             });
  }

  const existing = allWindows();
  for (const w of existing) {
    // _kwiltBound is a Qt dynamic property that persists across script
    // reloads (the QObject lives in KWin), but the signal connections
    // bindWindow set up under the previous JS engine were torn down when
    // it was destroyed. Resetting here ensures we re-connect against the
    // current engine — otherwise bindWindow short-circuits and our
    // minimizedChanged / fullScreenChanged / closed listeners never fire
    // for windows that were open before the reload.
    w._kwiltBound = false;
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
  registerShortcut("KwiltCycleLayout",  "Kwilt: Cycle window layout",       "Meta+Ctrl+Shift+L", cycleLayout);
  registerShortcut("KwiltLayoutGrid",    "Kwilt: Layout — autoGrid",        "Meta+Ctrl+G",       function () { setLayout("autoGrid"); });
  registerShortcut("KwiltLayoutCenter",  "Kwilt: Layout — centerTile",      "Meta+Ctrl+C",       function () { setLayout("centerTile"); });
  registerShortcut("KwiltLayoutMonocle", "Kwilt: Layout — monocle",         "Meta+Ctrl+M",       function () { setLayout("monocle"); });
  registerShortcut("KwiltLayoutDual",    "Kwilt: Layout — dual",            "Meta+Ctrl+D",       function () { setLayout("dual"); });
  registerShortcut("KwiltLayoutLeft",    "Kwilt: Layout — leftTile",        "Meta+Ctrl+L",       function () { setLayout("leftTile"); });
  registerShortcut("KwiltLayoutRight",   "Kwilt: Layout — rightTile",       "Meta+Ctrl+T",       function () { setLayout("rightTile"); });
  registerShortcut("KwiltLayoutFloating","Kwilt: Layout — floating",        "Meta+Ctrl+F",       function () { setLayout("floating"); });

  // Master pin: pinned window claims visible[0] on its (output, virtualDesktop).
  registerShortcut("KwiltPinMaster",     "Kwilt: Toggle master pin on active window", "Meta+S",  toggleMasterPin);
  registerShortcut("KwiltToggleFloat",   "Kwilt: Toggle float on active window",      "Meta+\\", toggleFloat);

  // Manual recovery: re-snapshot the queues from workspace.windowList().
  // Use when you suspect a ghost tile slot — quicker than ./dev-reload.sh.
  registerShortcut("KwiltRebuildQueues", "Kwilt: Rebuild tile queues (ghost-slot recovery)", "Meta+Ctrl+Shift+R", rebuildQueues);

  // Focus by direction (Meta+arrows) and swap by direction (Meta+Shift+arrows).
  // Plasma's KWin defaults (Quick Tile / Move Window to Screen) claim these
  // key combos and win the dispatch. scripts/setup-shortcuts.sh disables
  // them in kglobalshortcutsrc; run it once per machine.
  registerShortcut("KwiltFocusLeft",  "Kwilt: Focus window left",  "Meta+Left",  function () { focusByDirection("left");  });
  registerShortcut("KwiltFocusRight", "Kwilt: Focus window right", "Meta+Right", function () { focusByDirection("right"); });
  registerShortcut("KwiltFocusUp",    "Kwilt: Focus window up",    "Meta+Up",    function () { focusByDirection("up");    });
  registerShortcut("KwiltFocusDown",  "Kwilt: Focus window down",  "Meta+Down",  function () { focusByDirection("down");  });
  registerShortcut("KwiltSwapLeft",   "Kwilt: Swap window left",   "Meta+Shift+Left",  function () { swapByDirection("left");  });
  registerShortcut("KwiltSwapRight",  "Kwilt: Swap window right",  "Meta+Shift+Right", function () { swapByDirection("right"); });
  registerShortcut("KwiltSwapUp",     "Kwilt: Swap window up",     "Meta+Shift+Up",    function () { swapByDirection("up");    });
  registerShortcut("KwiltSwapDown",   "Kwilt: Swap window down",   "Meta+Shift+Down",  function () { swapByDirection("down");  });

  // Focus history. Meta+Tab is claimed by KWin's Walk Through Windows
  // (alongside Alt+Tab) — setup-shortcuts.sh strips just the Meta+Tab half.
  registerShortcut("KwiltCycleFocus", "Kwilt: Cycle focus (next tile)", "Meta+Tab", cycleFocus);
  registerShortcut("KwiltFocusLast",  "Kwilt: Focus last window",       "Meta+U",   focusLast);
}

init();
