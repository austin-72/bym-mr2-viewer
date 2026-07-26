// View Yard / View Outpost popup for the MR2 viewer.
//
// Renders another player's base read-only using the web-client yard engine
// (js/baseview/*, ported from the BYM web client): real building sprites at
// the exact Flash anchors, damage states, and the composited ground tile.
// The popup takes 90% x 90% of the screen over a dimmed backdrop, closes
// with the X (or Escape), and allows ONLY pan (drag) and zoom (wheel) -
// buildings cannot be hovered or clicked.
//
// Sprites load through /imagecache/..., the viewer server's permanent asset
// cache: each image is fetched from the refitted server at most once ever,
// then served from disk for everyone.

import {
  CREEP_SPRITES,
  GameData,
  guardianInfo,
  guardianRow,
  guardianSheet,
  guardianSheetCandidates,
  loadMonsterStats,
  monsterStat,
  parseChampions,
  parseHoused,
  statAtLevel,
  baseLevelInfo,
} from "./baseview/gamedata.js";
import { YardRenderer } from "./baseview/yard.js";
import { buildBymUrl, debugLog, escapeHtml, fetchJson } from "./shared.js";

let gameDataPromise = null;

function loadGameData() {
  if (!gameDataPromise) {
    // Monster stats ride along: pen creatures need per-level speed tables.
    // A missing stats file only stills the monsters, never blocks the yard.
    gameDataPromise = Promise.all([
      GameData.load("/data/yardprops.json"),
      loadMonsterStats("/data/monsterstats.json").catch(() => ({})),
    ]).then(([gameData]) => gameData).catch((error) => {
      gameDataPromise = null; // allow a retry on the next open
      throw error;
    });
  }
  return gameDataPromise;
}

// Ported from the web client's buildPenPopulation (HOUSING.Populate +
// CHAMPIONCAGE.SpawnGuardian): housed creeps each pick a random living
// housing to wander around, and one active champion patrols the cage.
function populatePens(renderer, data) {
  const entities = [];
  const entries = Object.entries(safeObject(data?.buildingdata));
  const yardBuildings = renderer.buildings || [];
  const anchorFor = (key, record) => {
    const id = record.id ?? Number(key);
    return yardBuildings.find((b) => b.id === id);
  };

  // Housings: BUILDING15, alive (destroyed pens hold no visible monsters).
  const housings = entries
    .map(([key, record]) => ({ record, placed: anchorFor(key, record) }))
    .filter(({ record, placed }) => Number(record.t) === 15 && placed && placed.state !== "destroyed");
  const academy = safeObject(data?.academy);
  if (housings.length) {
    const housedData = parseHoused(safeObject(data?.monsters).housed);
    for (const { id: key, count } of housedData.list) {
      const sheet = CREEP_SPRITES[key];
      const stats = monsterStat(key);
      if (!sheet || !stats) continue;
      const level = Number(safeObject(academy[key]).level) || 1;
      const speed = statAtLevel(stats.props?.speed, level) || 1;
      for (let i = 0; i < count; i++) {
        const housing = housings[Math.floor(Math.random() * housings.length)];
        const home = housing.placed;
        entities.push({
          id: `${key}-${i}`,
          kind: "creep",
          sheet,
          dirs: 30, //               SPRITES fallback: angle / 12
          speed,
          home: { x: home.x, y: home.y },
          homeType: Number(housing.placed?.t ?? housing.t) || 0,
          penSize: 80, //            PointInHouse rect (40,40,80,80)
        });
      }
    }
  }

  // Champion cage: t=114, one guardian walks the pen. ONLY Normal status
  // (0) is visible in the yard - Frozen (1) champions are in stasis, Juiced
  // (2) are inside the Monster Juicer, and Destroyed/Refunded/Migrated are
  // gone. parseChampions already forces all-but-one non-Krallen champion to
  // Frozen, so at most one qualifies here.
  const champs = parseChampions(data?.champion);
  const cage = entries
    .map(([key, record]) => ({ record, placed: anchorFor(key, record) }))
    .find(({ record, placed }) => Number(record.t) === 114 && placed && placed.state !== "destroyed");
  if (cage) {
    const active = champs.find((champ) => champ.status === 0 && champ.t !== 5);
    if (active) {
      const level = Math.max(1, active.l);
      const sheet = guardianSheet(active.t, level);
      const sheets = guardianSheetCandidates(active.t, level);
      const info = guardianInfo(active.t);
      if (sheet && info) {
        const speedTable = info?.props?.speed || [1];
        const speed = speedTable[Math.min(Math.max(1, active.l), speedTable.length) - 1] || 1;
        entities.push({
          id: `G${active.t}`,
          kind: "guardian",
          sheet,
          sheets,
          dirs: 16, //               angle / 22.5
          speed,
          home: { x: cage.placed.x, y: cage.placed.y },
          homeType: Number(cage.placed?.t) || 0,
          penSize: 40, //            PointInCage rect (40,40,40,40)
          rowFn: (moving, tick) => guardianRow(active.t, Math.max(1, active.l), moving, tick),
        });
      }
    }
  }

  // Krallen (t=5) appears on MAIN bases only - never outposts - and walks
  // the CHAMPION CAGE, not the Champion Chamber (t119, the freezer that
  // holds frozen champions). CHAMPIONCAGE.SpawnGuardian places Krallen with
  // the same PointInCage rect as a basic champion, which is why both can
  // share the pen. Shown at level 5 when the Town Hall is level 6+.
  const townHall = yardBuildings.find((b) => Number(b.t) === 14 && b.state !== "destroyed");
  if (townHall && Number(townHall.l) >= 6 && cage) {
    const KRALLEN_LEVEL = 5;
    const sheet = guardianSheet(5, KRALLEN_LEVEL);
    const sheets = guardianSheetCandidates(5, KRALLEN_LEVEL);
    const info = guardianInfo(5);
    if (sheet && info) {
      const speedTable = info?.props?.speed || [1];
      const speed = speedTable[Math.min(KRALLEN_LEVEL, speedTable.length) - 1] || 1;
      entities.push({
        id: "G5",
        kind: "guardian",
        sheet,
        sheets,
        dirs: 16,
        speed,
        home: { x: cage.placed.x, y: cage.placed.y },
        homeType: Number(cage.placed?.t) || 0,
        penSize: 40, //            PointInCage rect (40,40,40,40)
        rowFn: (moving, tick) => guardianRow(5, KRALLEN_LEVEL, moving, tick),
      });
    }
  }
  renderer.setPenEntities?.(entities);
}

function safeObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function safeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Loads a foreign base through the viewer's game-API proxy, exactly like the
// web client's scouting flow: /base/load with type "view" + the base id.
async function fetchBase(token, baseid, userid, recoverToken = null) {
  const attempt = (activeToken) => fetchJson(buildBymUrl("/base/load"), {
    method: "POST",
    headers: {
      "X-Fetch-Priority": "10", //  /base/load is top priority
      Authorization: `Bearer ${activeToken}`,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body: new URLSearchParams({
      type: "view",
      baseid: String(baseid),
      userid: String(userid ?? 0),
      mapversion: "2",
    }),
  });

  try {
    return await attempt(token);
  } catch (error) {
    // The session rotates on every getinfo call, so the token captured when
    // the popup opened can already be stale by the time the base loads.
    // Recover once with the live token rather than showing a failure.
    const status = Number(error?.status);
    if ((status !== 401 && status !== 403) || typeof recoverToken !== "function") {
      throw error;
    }
    const next = String((await recoverToken()) || "").trim();
    if (!next || next === token) {
      throw error;
    }
    return attempt(next);
  }
}

const LAYOUT_PREF_KEY = "bymViewerBaseLayout";
// Small enough to fit a narrow phone in portrait (360 would overflow a
// 320px-wide device and force the window off-screen).
const MIN_WINDOW_WIDTH = 280;
const MIN_WINDOW_HEIGHT = 220;

function loadLayoutPref() {
  try {
    const raw = window.localStorage.getItem(LAYOUT_PREF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const nums = ["left", "top", "width", "height"].map((k) => Number(parsed?.[k]));
    if (nums.some((n) => !Number.isFinite(n))) return null;
    const [left, top, width, height] = nums;
    return { left, top, width, height };
  } catch {
    return null;
  }
}

function saveLayoutPref(layout) {
  try {
    window.localStorage.setItem(LAYOUT_PREF_KEY, JSON.stringify(layout));
  } catch {
    /* private mode: layout just won't persist */
  }
}

function clearLayoutPref() {
  try {
    window.localStorage.removeItem(LAYOUT_PREF_KEY);
  } catch {
    /* ignore */
  }
}

/** Default geometry: 90% of the viewport, centred. */
/** Default geometry: 90% of the viewport, centred. Touch devices get the
 *  whole screen, since a floating window is unusable at phone widths. */
function defaultLayout() {
  const touch = window.matchMedia?.("(max-width: 860px), (pointer: coarse)")?.matches;
  if (touch) {
    return { width: window.innerWidth, height: window.innerHeight, left: 0, top: 0 };
  }
  const width = Math.max(MIN_WINDOW_WIDTH, Math.round(window.innerWidth * 0.9));
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.round(window.innerHeight * 0.9));
  return {
    width,
    height,
    left: Math.round((window.innerWidth - width) / 2),
    top: Math.round((window.innerHeight - height) / 2),
  };
}

/** Keeps a layout inside the viewport and above the minimum size. */
// The frame overlay and its corner buttons live outside the window box: the
// rails overhang 12px left, 11px right and 16px bottom, and the reset button
// reaches 11px above the top edge. Clamping the border box alone let a window
// dragged flush to an edge push the carved rail - and the close button - off
// screen entirely.
// frame1's extents: topLeft reaches (-12, -10), bottomLeft's foot lands at
// h + 15, and bottomRight's right edge at w + 12.
const FRAME_OVERHANG = { top: 10, right: 12, bottom: 15, left: 12 };

// Where a shrunk window parks: the top-left of the map area, inset the same
// 12px the cell popup uses, so it tucks under the toolbar instead of sliding
// beneath it at the viewport corner. Falls back to the viewport if the map
// panel is not on the page (the base viewer does not depend on it).
const MAP_AREA_INSET = 12;

function mapAreaCorner() {
  const panel = document.getElementById("map-panel");
  const rect = panel?.getBoundingClientRect?.();
  if (!rect || !rect.width || !rect.height) {
    return { left: MAP_AREA_INSET, top: MAP_AREA_INSET };
  }
  return {
    left: Math.round(rect.left + MAP_AREA_INSET),
    top: Math.round(rect.top + MAP_AREA_INSET),
  };
}

function clampLayout(layout) {
  const maxWidth = Math.max(
    MIN_WINDOW_WIDTH, window.innerWidth - FRAME_OVERHANG.left - FRAME_OVERHANG.right);
  const maxHeight = Math.max(
    MIN_WINDOW_HEIGHT, window.innerHeight - FRAME_OVERHANG.top - FRAME_OVERHANG.bottom);
  const width = Math.min(Math.max(MIN_WINDOW_WIDTH, layout.width), maxWidth);
  const height = Math.min(Math.max(MIN_WINDOW_HEIGHT, layout.height), maxHeight);
  const maxLeft = Math.max(FRAME_OVERHANG.left,
    window.innerWidth - width - FRAME_OVERHANG.right);
  // Note: left/top are only floored at the frame overhang, so a caller can
  // place the window anywhere below the toolbar - see mapAreaCorner().
  const maxTop = Math.max(FRAME_OVERHANG.top,
    window.innerHeight - height - FRAME_OVERHANG.bottom);
  return {
    width,
    height,
    left: Math.min(Math.max(FRAME_OVERHANG.left, layout.left), maxLeft),
    top: Math.min(Math.max(FRAME_OVERHANG.top, layout.top), maxTop),
  };
}

/**
 * Makes the base-view window draggable by its header and resizable from any
 * edge or corner, persisting the geometry so the next base opens the same
 * way. The renderer's ResizeObserver picks up the new canvas size on its
 * own, so nothing here has to poke the renderer.
 */
function setupWindowLayout(windowEl, resetButton) {
  // Treat "close enough" as default: clamping and rounding can shift a
  // restored layout by a pixel, and a 1px drift should not make the reset
  // control appear.
  const isDefaultLayout = (layout) => {
    const base = clampLayout(defaultLayout());
    return ["width", "height", "left", "top"]
      .every((key) => Math.abs(Number(layout[key]) - Number(base[key])) <= 2);
  };

  const apply = (layout, { persist = true } = {}) => {
    const next = clampLayout(layout);
    windowEl.style.width = `${next.width}px`;
    windowEl.style.height = `${next.height}px`;
    windowEl.style.left = `${next.left}px`;
    windowEl.style.top = `${next.top}px`;
    if (persist) saveLayoutPref(next);
    return next;
  };

  let layout = apply(loadLayoutPref() || defaultLayout(), { persist: false });

  // Drag by the header. The close and reset buttons are siblings of the
  // header now, not children, so they cannot start a drag - the closest()
  // guard below is belt and braces for anything added to the title bar later.
  const header = windowEl.querySelector(".base-view-header");
  let drag = null;
  header?.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target.closest("button")) return;
    drag = { id: event.pointerId, x: event.clientX - layout.left, y: event.clientY - layout.top };
    windowEl.classList.add("dragging");
    header.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  header?.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    layout = apply({ ...layout, left: event.clientX - drag.x, top: event.clientY - drag.y });
    event.preventDefault();
  });
  const endDrag = (event) => {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    drag = null;
    windowEl.classList.remove("dragging");
  };
  header?.addEventListener("pointerup", endDrag);
  header?.addEventListener("pointercancel", endDrag);

  // Resize from any edge/corner. "n"/"w" move the origin as the size changes.
  let resize = null;
  for (const grip of windowEl.querySelectorAll(".base-view-resize")) {
    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      resize = { id: event.pointerId, dir: grip.dataset.dir, x: event.clientX, y: event.clientY, start: { ...layout } };
      windowEl.classList.add("resizing");
      grip.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });
    grip.addEventListener("pointermove", (event) => {
      if (!resize || event.pointerId !== resize.id) return;
      const dx = event.clientX - resize.x;
      const dy = event.clientY - resize.y;
      const { dir, start } = resize;
      const next = { ...start };
      if (dir.includes("e")) next.width = start.width + dx;
      if (dir.includes("s")) next.height = start.height + dy;
      if (dir.includes("w")) {
        next.width = start.width - dx;
        // Clamp the movement so dragging past the minimum width does not
        // keep sliding the left edge rightwards.
        next.left = start.left + Math.min(dx, start.width - MIN_WINDOW_WIDTH);
      }
      if (dir.includes("n")) {
        next.height = start.height - dy;
        next.top = start.top + Math.min(dy, start.height - MIN_WINDOW_HEIGHT);
      }
      layout = apply(next);
      event.preventDefault();
    });
    const endResize = (event) => {
      if (!resize || (event && event.pointerId !== resize.id)) return;
      resize = null;
      windowEl.classList.remove("resizing");
    };
    grip.addEventListener("pointerup", endResize);
    grip.addEventListener("pointercancel", endResize);
  }

  // The control toggles rather than only resetting: at the default (full)
  // size it shrinks the window to a 30% thumbnail in the top-left corner,
  // and from anywhere else it restores the default.
  const SHRUNK_FRACTION = 0.3;
  const syncResetButton = () => {
    if (!resetButton) return;
    const full = isDefaultLayout(layout);
    const label = full ? "Shrink base view" : "Reset to default size";
    resetButton.setAttribute("aria-label", label);
    resetButton.title = full
      ? "Shrink the window to a corner thumbnail"
      : "Reset the window to its default size and position";
  };

  resetButton?.addEventListener("click", () => {
    if (isDefaultLayout(layout)) {
      // clampLayout enforces the minimum size and keeps the frame overhang on
      // screen, so this lands flush in the top-left corner.
      // 30% of the viewport width, with the height matching it rather than
      // taking 30% of the height too - a yard is square-ish, and 30% of a
      // 16:9 viewport gave a letterboxed strip. clampLayout trims the height
      // to whatever vertical space is actually left.
      const width = Math.round(window.innerWidth * SHRUNK_FRACTION);
      const corner = mapAreaCorner();
      layout = apply({ width, height: width, left: corner.left, top: corner.top });
    } else {
      clearLayoutPref();
      layout = apply(defaultLayout(), { persist: false });
    }
    syncResetButton();
  });
  syncResetButton();

  // A smaller window (or a rotated phone) must not strand the popup.
  const onResize = () => {
    layout = apply(layout, { persist: false });
  };
  window.addEventListener("resize", onResize);
  return () => window.removeEventListener("resize", onResize);
}


let activeView = null;

export function closeBaseView() {
  if (!activeView) {
    return;
  }
  const { backdrop, renderer, keyHandler, teardownLayout, restoreFocusTo } = activeView;
  activeView = null;
  renderer?.destroy?.();
  teardownLayout?.();
  document.removeEventListener("keydown", keyHandler);
  backdrop.remove();
  if (restoreFocusTo?.isConnected && typeof restoreFocusTo.focus === "function") {
    restoreFocusTo.focus();
  }
}

/** "Name's Outpost at 400,370" - falls back gracefully as parts go missing. */
function buildBaseTitle(name, isMain, x, y, isWild = false) {
  // Wild monster camps have no owner, so they title as just "Camp at x,y".
  const kind = isWild ? "Camp" : (isMain ? "Yard" : "Outpost");
  const where = Number.isFinite(Number(x)) && Number.isFinite(Number(y))
    ? ` at ${Number(x)},${Number(y)}`
    : "";
  const owner = String(name || "").trim();
  return owner ? `${owner}'s ${kind}${where}` : `${kind}${where}`;
}


// Own-yard HUD, rebuilt at the geometry the SWF actually uses. Every number
// below is read off the PlaceObject matrices in assets.swf (UI_TOP_CLIP > mc)
// rather than eyeballed from a screenshot.
//
//   mc origin on screen = (screen.x + 10, screen.y + 8)   UI2.as:64-75 overrides
//                                                         the authoring -192,13
//   mcPoints    (0,   0)     level plate, bitmap 581 at native 217x33
//   mcR1        (0.5, 37.5)
//   mcR2        (0,   75)
//   mcR3        (0,   111)   row pitch 37 = UI_TOP._RESOURCEBAR_HEIGHT
//   mcR4        (0,   148)
//   mcOutposts  (0,   185)   same plate art as a resource row
//
// A resource row is bitmap 551 (117x33) stretched 23.079/20 = 1.15395 on X
// only (shape 552), so it renders 135x33. The outposts row is shape 590 -
// the same bitmap, same stretch - with the outpost icon and ">>" as separate
// layers on top, which is why they are separate files here.
const HUD_ASSETS = "/assets/gameui/";

const HUD_ROWS = [
  // x/y: row origin inside mc. dx/dy: icon art offset from the row origin,
  // taken from the bitmap-fill matrices of shapes 558 / 565 / 568 / 572.
  { key: "r1", label: "Twigs",   icon: "icon_twigs.png",   w: 39,  h: 42, dx: -9, dy: -4, x: 0.5, y: 37.5 },
  { key: "r2", label: "Pebbles", icon: "icon_pebbles.png", w: 40,  h: 38, dx: -6, dy: -2, x: 0,   y: 75 },
  { key: "r3", label: "Putty",   icon: "icon_putty.png",   w: 32,  h: 35, dx: -5, dy: -1, x: 0,   y: 111 },
  { key: "r4", label: "Goo",     icon: "icon_goo.png",     w: 124, h: 40, dx: -4, dy: -5, x: 0,   y: 148 },
];
const HUD_OUTPOSTS_Y = 185;

// UI_TOP.Setup: mcPoints.tName is set to KEYS uitop_backyardmonsters on your
// own yard. (Someone else's base gets uitop_yardowner{short,long} - "NAME'S
// YARD" - and an inferno yard gets uitop_backyardmonstersinferno, "INFERNO";
// neither applies here, since the HUD only renders for isOwnYard and this
// viewer has no inferno mode.)
const HUD_TITLE = "BACKYARD MONSTERS";

/**
 * UI_TOP.Setup, visiting branch: the level plate's tName becomes the owner's
 * name in caps with a possessive, picking the short form when the name
 * already ends in "s" (uitop_yardownershort "#v1#' YARD" vs
 * uitop_yardownerlong "#v1#'S YARD").
 */
function yardOwnerTitle(ownerName) {
  const name = String(ownerName || "").trim().toUpperCase();
  if (!name) return "";
  return name.endsWith("S") ? `${name}' YARD` : `${name}'S YARD`;
}

// mcPic (sprite 670) sits at (-5,-5) scaled 0.9, so its 50x50 content renders
// 45 square; shape 671 frames it one pixel further out, at (-6,-6) 47 square.
// Together they cover the star and level number entirely, which is why the
// game leaves both undriven in view mode (SetPoints is gated on BUILD) - so
// they are simply not rendered here.
const HUD_PIC_SIZE = 45;
const HUD_PIC_FRAME = 48;

// UI_TOP.UpdateTweenResourceText: mcBar.width = 90 / max * value, clamped to
// 90. It is an absolute pixel width on a 135px plate, not a percentage - a
// full bar stops well short of the right edge.
const HUD_FILL_MAX = 90;
// UI_TOP.SetPoints: mcPoints.mcBar.width = 200 / (upper - lower) * (points - lower).
const HUD_LEVEL_FILL_MAX = 200;

/**
 * GLOBAL.FormatNumber: floor, then group in threes with commas. Ported rather
 * than delegated to toLocaleString, which switches to exponential notation
 * past 1e21 - reachable in goo on a late-game base.
 */
function formatFull(value) {
  const raw = Number(value) || 0;
  if (!Number.isFinite(raw)) {
    return "0";
  }
  const n = Math.floor(raw);
  const magnitude = Math.abs(n);
  // String() switches to exponential notation at 1e21 - "1e+21" - and the
  // grouping loop below would slice that into "1e,+21". Going through BigInt
  // keeps the digits. (This was the whole reason for not using
  // toLocaleString, which has the same problem, so it would have been an
  // embarrassing thing to reintroduce.)
  let digits = magnitude >= 1e21
    ? BigInt(magnitude).toString()
    : String(magnitude);
  const groups = [];
  while (digits.length > 0) {
    const cut = Math.max(digits.length - 3, 0);
    groups.unshift(digits.slice(cut));
    digits = digits.slice(0, cut);
  }
  return (n < 0 ? "-" : "") + groups.join(",");
}

/**
 * Scrollable list of every base this player owns, anchored under the arrow.
 *
 * The main yard is always first; outposts follow by empire value, highest
 * first. The entry being viewed is highlighted and scrolled into view, so a
 * player with twenty outposts can see where they are without hunting.
 */
/**
 * Fits the picker between the outposts row and the bottom of the yard viewer.
 *
 * It opens hanging from the row, running down to the viewer's bottom edge. If
 * the list still would not fit in that space it is promoted to the viewer's
 * full height instead, which is the most room there is - only past that does
 * it scroll.
 *
 * The HUD is transform-scaled on touch, so the shell's height is read through
 * getBoundingClientRect and converted back through the same scale rather than
 * being compared against unscaled offsets.
 */
function sizeBasePicker(menu, backdrop) {
  const shell = backdrop.querySelector(".base-view-canvas-shell");
  if (!shell) return;
  const shellRect = shell.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const scale = menuRect.width ? (menuRect.width / menu.offsetWidth) : 1;
  if (!shellRect.height || !scale) return;

  const gap = 8 * scale;

  // Horizontal fit first: at 464px, opening from the right of the outposts
  // row runs past the edge of a narrow window (the 30% shrunk view is only
  // ~480px wide). Pull it back so it stays inside the viewer.
  const overflowRight = (menuRect.right - shellRect.right + gap) / scale;
  if (overflowRight > 0) {
    menu.style.marginLeft = `${Math.round(6 - overflowRight)}px`;
  }

  const belowRow = Math.max(0, shellRect.bottom - menuRect.top - gap) / scale;
  const wanted = menu.scrollHeight;

  if (wanted <= belowRow) {
    menu.style.maxHeight = `${Math.round(belowRow)}px`;
    return;
  }
  // Promote to the viewer's full height: shift the menu up so its top sits at
  // the top of the shell, and give it the whole span.
  const fullHeight = Math.max(0, shellRect.height - gap * 2) / scale;
  const lift = (menuRect.top - shellRect.top - gap) / scale;
  menu.style.marginTop = `${-Math.round(lift)}px`;
  menu.style.maxHeight = `${Math.round(fullHeight)}px`;
}

function openBasePicker(backdrop, anchor, entries, currentBaseid, currentX, currentY, onPick) {
  backdrop.querySelector(".hud-base-menu")?.remove();
  if (!Array.isArray(entries) || !entries.length) return;

  const isCurrent = (entry) => (
    (currentBaseid && String(entry.baseid) === String(currentBaseid))
    || (Number(entry.x) === Number(currentX) && Number(entry.y) === Number(currentY))
  );

  const menu = document.createElement("div");
  menu.className = "hud-base-menu";
  menu.setAttribute("role", "listbox");
  menu.innerHTML =
    `<div class="hud-base-head" aria-hidden="true">
       <span>Yard Type</span><span>Coordinates</span><span>Kit</span>
     </div>
     <div class="hud-base-list">` +
    entries.map((entry, index) => `
      <button type="button" class="hud-base-item${isCurrent(entry) ? " current" : ""}"
        role="option" data-index="${index}" aria-selected="${isCurrent(entry)}"
        title="Empire value ${escapeHtml(formatFull(entry.value))}">
        <span>${entry.isMain ? "Main Yard" : "Outpost"}</span>
        <span>${escapeHtml(`${entry.x}, ${entry.y}`)}</span>
        <span>${escapeHtml(entry.kit || (entry.isMain ? "N/A" : "None"))}</span>
      </button>`).join("") +
    `</div>`;

  (anchor?.parentElement || backdrop).appendChild(menu);
  sizeBasePicker(menu, backdrop);

  // Setting scrollTop rather than scrollIntoView: the latter scrolls every
  // scrollable ancestor to bring the element into view, which from inside a
  // popup means it can move the page behind it too.
  const list = menu.querySelector(".hud-base-list");
  const current = menu.querySelector(".hud-base-item.current");
  if (list && current) {
    list.scrollTop = Math.max(
      0, current.offsetTop - (list.clientHeight - current.offsetHeight) / 2);
  }

  const close = () => {
    menu.remove();
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  // Both handlers self-heal: the menu can leave the DOM without close() ever
  // running - the base view is closed, or a pick replaces the whole HUD - and
  // without this check the document listeners would outlive it.
  const onOutside = (event) => {
    if (!menu.isConnected) { close(); return; }
    if (!menu.contains(event.target) && event.target !== anchor) close();
  };
  const onKey = (event) => {
    if (!menu.isConnected) { close(); return; }
    if (event.key === "Escape") {
      event.stopPropagation();   // Escape closes the menu, not the window
      close();
    }
  };
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);

  menu.addEventListener("click", (event) => {
    const item = event.target.closest(".hud-base-item");
    if (!item) return;
    const entry = entries[Number(item.dataset.index)];
    close();
    if (entry) onPick(entry);
  });
}

/** Own-yard HUD: level plate, four resource rows, then the outposts row. */
function renderOwnYardHud(backdrop, data, outpostList, onNextOutpost) {
  const hud = backdrop.querySelector(".base-view-hud");
  if (!hud) return;
  const resources = safeObject(data?.resources);
  // data.outposts is frequently absent from a base load, so the caller passes
  // the list the map cache already knows about.
  // Only ever the normalized shape now. The old fallback dropped raw
  // [x, y, baseid] arrays from the save straight into the picker, which
  // renders objects - every column would have come out undefined.
  const outposts = Array.isArray(outpostList) ? outpostList : [];
  // The list always leads with the main yard, so the plate's number and the
  // button's enabled state both key off the outposts alone - otherwise a
  // player with none would still get a live control opening a one-row menu.
  const outpostCount = outposts.filter((entry) => !entry?.isMain).length;

  const lvl = baseLevelInfo(data?.points, data?.basevalue);
  const levelFill = Math.max(0, Math.min(
    HUD_LEVEL_FILL_MAX,
    (HUD_LEVEL_FILL_MAX / Math.max(1, lvl.upper - lvl.lower)) * (lvl.points - lvl.lower),
  ));

  const rows = HUD_ROWS.map(({ key, label, icon, w, h, dx, dy, x, y }) => {
    const value = Number(resources[key]) || 0;
    const max = Number(resources[key + "max"]) || 0;
    const fill = max > 0 ? Math.min(HUD_FILL_MAX, (HUD_FILL_MAX / max) * value) : 0;
    const title = `${label}: ${formatFull(value)}${max ? " / " + formatFull(max) : ""}`;
    return `
      <div class="hud-row" style="left:${x}px;top:${y}px" title="${escapeHtml(title)}">
        <span class="hud-fill" style="width:${fill.toFixed(2)}px"></span>
        <span class="hud-num">${escapeHtml(formatFull(value))}</span>
        <span class="hud-icon" style="background-image:url('${HUD_ASSETS}${icon}');left:${dx}px;top:${dy}px;width:${w}px;height:${h}px"></span>
        <span class="hud-plus" aria-hidden="true"></span>
      </div>`;
  }).join("");

  hud.innerHTML = `
    <div class="hud-level" title="Level ${escapeHtml(String(lvl.level))} &middot; ${escapeHtml(formatFull(lvl.points))} points">
      <span class="hud-level-fill" style="width:${levelFill.toFixed(2)}px"></span>
      <span class="hud-level-title">${escapeHtml(HUD_TITLE)}</span>
      <span class="hud-level-star"></span>
      <span class="hud-level-num">${escapeHtml(String(lvl.level))}</span>
    </div>
    ${rows}
    <div class="hud-outposts" style="top:${HUD_OUTPOSTS_Y}px">
      <span class="hud-outpost-icon"></span>
      <span class="hud-outpost-count">${escapeHtml(formatFull(outpostCount))}</span>
      <button type="button" class="hud-next-outpost" title="Choose a base to view"
        ${outpostCount ? "" : "disabled"}></button>
    </div>`;
  hud.hidden = false;

  const next = hud.querySelector(".hud-next-outpost");
  if (next && outpostCount && typeof onNextOutpost === "function") {
    next.addEventListener("click", () => onNextOutpost(outposts, next));
  }
}


/** Visitor HUD: the level plate showing whose yard it is, plus their avatar. */
function renderVisitorHud(backdrop, data, ownerName, ownerPic) {
  const hud = backdrop.querySelector(".base-view-hud");
  if (!hud) return;
  const title = yardOwnerTitle(ownerName);
  if (!title) {
    hud.hidden = true;
    hud.innerHTML = "";
    return;
  }
  const pic = String(ownerPic || "").trim();
  const image = pic.startsWith("http://") || pic.startsWith("https://")
    ? `<img class="hud-visitor-photo" src="${escapeHtml(pic)}" alt="" referrerpolicy="no-referrer">`
    : "";
  hud.innerHTML = `
    <div class="hud-level" title="${escapeHtml(title)}">
      <span class="hud-level-title">${escapeHtml(title)}</span>
    </div>
    <div class="hud-visitor-pic">${image}</div>
    <div class="hud-visitor-frame"></div>`;
  hud.hidden = false;
  // A dead avatar link should leave the empty plate, not a broken-image icon.
  // The listener can miss a failure that already happened - a cached 404
  // resolves before this line runs - so the settled case is checked too.
  const photo = hud.querySelector(".hud-visitor-photo");
  if (photo) {
    photo.addEventListener("error", () => photo.remove());
    if (photo.complete && photo.naturalWidth === 0) {
      photo.remove();
    }
  }
}

export async function openBaseView({ token, baseid, userid, name, isMain, isWild, isOwnYard, outpostList, ownerPic, x, y, prepare, prepareFor, baseListFor, recoverToken }) {
  // Opening a second base while one is already showing updates the existing
  // window in place: the user keeps the size and position they chose, and
  // there is no close/reopen flicker. Each open bumps a generation counter so
  // an in-flight load for the previous base knows it has been superseded and
  // bails out instead of rendering into the window.
  if (activeView) {
    const generation = activeView.generation + 1;
    activeView.generation = generation;
    activeView.renderer?.destroy?.();
    activeView.renderer = null;
    const view = activeView;
    const shell = view.backdrop.querySelector(".base-view-canvas-shell");
    const titleEl = view.backdrop.querySelector(".base-view-title");
    if (titleEl) titleEl.textContent = buildBaseTitle(name, isMain, x, y);
    // Replace the canvas outright: the old renderer's observers and cached
    // context are gone with it, so nothing from the previous base lingers.
    const staleCanvas = shell?.querySelector(".base-view-canvas");
    const freshCanvas = document.createElement("canvas");
    freshCanvas.className = "base-view-canvas";
    staleCanvas?.replaceWith(freshCanvas);
    let status = shell?.querySelector(".base-view-status");
    if (!status) {
      status = document.createElement("div");
      status.className = "base-view-status";
      shell?.appendChild(status);
    }
    status.classList.remove("error");
    setStatusMessage(status, "Loading base\u2026");
    await loadBaseIntoView({
      view, generation, backdrop: view.backdrop, status, canvas: freshCanvas,
      token, baseid, userid, name, isMain, isWild, isOwnYard, outpostList, ownerPic, x, y, prepare, prepareFor, baseListFor, recoverToken,
    });
    return;
  }

  const backdrop = document.createElement("div");
  backdrop.className = "base-view-backdrop";
  backdrop.innerHTML = `
    <div class="base-view-window game-frame frame-mr2" role="dialog" aria-modal="true" aria-label="Base viewer">
      <div class="base-view-header">
        <span class="base-view-title">${escapeHtml(buildBaseTitle(name, isMain, x, y, isWild))}</span>
      </div>
      <div class="base-view-canvas-shell">
        <canvas class="base-view-canvas"></canvas>
        <div class="base-view-hud" hidden></div>
        <div class="base-view-status">Loading base\u2026</div>
      </div>
      <div class="base-view-resize" data-dir="n"></div>
      <div class="base-view-resize" data-dir="s"></div>
      <div class="base-view-resize" data-dir="e"></div>
      <div class="base-view-resize" data-dir="w"></div>
      <div class="base-view-resize" data-dir="ne"></div>
      <div class="base-view-resize" data-dir="nw"></div>
      <div class="base-view-resize" data-dir="se"></div>
      <div class="base-view-resize" data-dir="sw"></div>
      <!-- Last in the window so they paint over the frame and the resize
           grips. frame2.Setup() hangs these off the frame, not the panel, so
           they live here rather than in the header. -->
      <button type="button" class="base-view-reset-layout frame-button-alt"
        aria-label="Reset to default size"
        title="Reset the window to its default size and position"></button>
      <button type="button" class="base-view-close frame-button-close" aria-label="Close base view" title="Close">&times;</button>
    </div>
  `;
  const keyHandler = (event) => {
    if (event.key === "Escape") {
      closeBaseView();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    // aria-modal="true" tells assistive tech the rest of the page is inert,
    // but it does nothing to Tab: without this, tabbing out of the dialog
    // walks onto the map behind it while the modal is still up.
    const focusable = [...backdrop.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select, textarea, '
      + '[tabindex]:not([tabindex="-1"])')]
      .filter((el) => el.offsetParent !== null);
    if (!focusable.length) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!backdrop.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  // Remember where focus came from so closing returns it, rather than
  // dumping the user at the top of the document.
  const restoreFocusTo = document.activeElement;
  activeView = {
    backdrop, renderer: null, keyHandler, teardownLayout: null, generation: 1,
    restoreFocusTo,
  };
  document.body.appendChild(backdrop);
  document.addEventListener("keydown", keyHandler);
  backdrop.querySelector(".base-view-close")?.focus();
  backdrop.querySelector(".base-view-close").addEventListener("click", closeBaseView);
  // Drag/resize the window, restoring the size and position last used.
  activeView.teardownLayout = setupWindowLayout(
    backdrop.querySelector(".base-view-window"),
    backdrop.querySelector(".base-view-reset-layout"),
  );
  // The backdrop is transparent to pointer events so the map stays usable
  // behind the window, which means there is no click-outside-to-close: the
  // close button and Escape are the ways out.

  const status = backdrop.querySelector(".base-view-status");
  const canvas = backdrop.querySelector(".base-view-canvas");

  await loadBaseIntoView({
    view: activeView, generation: activeView.generation, backdrop, status, canvas,
    token, baseid, userid, name, isMain, isWild, isOwnYard, outpostList, ownerPic, x, y, prepare, prepareFor, baseListFor, recoverToken,
  });
}

/**
 * Loads a base and renders it into an already-built window.
 *
 * Shared by the first open and by every in-place swap, so both paths behave
 * identically. Staleness is decided by `generation` rather than by identity of
 * the backdrop: a reused window keeps the same element, so only the counter
 * can tell whether this load is still the one the user is waiting for. Every
 * await is followed by that check, and a superseded load returns silently
 * without touching the DOM.
 */
/**
 * Status text, with an optional retry control.
 *
 * A failed load used to leave a dead sentence in the middle of the window and
 * no way forward but closing and reopening the popup - which also lost the
 * window geometry. `onRetry` re-runs the same load with the same arguments.
 */
function setStatusMessage(statusEl, message, onRetry = null) {
  if (!statusEl) return;
  statusEl.textContent = "";
  const line = document.createElement("div");
  line.textContent = message;
  statusEl.appendChild(line);
  if (typeof onRetry !== "function") return;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "secondary-button base-view-retry";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => {
    statusEl.classList.remove("error");
    setStatusMessage(statusEl, "Loading base\u2026");
    onRetry();
  });
  statusEl.appendChild(retry);
}

async function loadBaseIntoView({
  view, generation, backdrop, status, canvas,
  token, baseid, userid, name, isMain, isWild, isOwnYard, outpostList, ownerPic, x, y, prepare, prepareFor, baseListFor, recoverToken,
}) {
  // Retry re-runs the whole thing, prepare included - so it refreshes the
  // zone and re-resolves the base id rather than replaying a stale one.
  const retryArgs = {
    token, baseid, userid, name, isMain, isWild, isOwnYard, outpostList, ownerPic,
    x, y, prepare, prepareFor, baseListFor, recoverToken,
  };
  const current = () => activeView === view && view.generation === generation;

  // Optional prepare step: the caller reloads the cell's zone from the game
  // server first, then hands back the freshly observed base id + owner name.
  let resolvedBaseid = baseid;
  let resolvedName = "";
  if (typeof prepare === "function") {
    try {
      const resolved = await prepare((message) => {
        if (current()) {
          setStatusMessage(status, message);
        }
      });
      if (!current()) {
        return; // closed or superseded while refreshing
      }
      resolvedBaseid = String(resolved?.baseid || "").trim();
      resolvedName = String(resolved?.name || "").trim();
    } catch (error) {
      if (!current()) {
        return;
      }
      status.classList.add("error");
      setStatusMessage(status, error?.message || "Could not refresh this cell.",
        () => loadBaseIntoView(retryArgs));
      return;
    }
  }
  if (!resolvedBaseid || resolvedBaseid === "0") {
    if (!current()) return;
    status.classList.add("error");
    setStatusMessage(status, "No base id is available for this cell.",
      () => loadBaseIntoView(retryArgs));
    return;
  }
  setStatusMessage(status, "Loading base\u2026");

  let gameData;
  let data;
  try {
    [gameData, data] = await Promise.all([
      loadGameData(),
      fetchBase(token, resolvedBaseid, userid, recoverToken),
    ]);
  } catch (error) {
    if (!current()) {
      return; // closed or superseded while loading
    }
    status.classList.add("error");
    setStatusMessage(status, error?.message
      ? `Could not load this base: ${error.message}`
      : "Could not load this base.",
      () => loadBaseIntoView(retryArgs));
    return;
  }
  if (!current()) {
    return; // closed or superseded while loading
  }

  // Read-only renderer: pan + zoom only, sprites via the permanent
  // server-side image cache.
  const renderer = new YardRenderer(canvas, gameData, "/imagecache", {
    interactive: false,
    isOutpost: !isMain,
    isOwnYard: Boolean(isOwnYard),
    // Scouting must not reveal traps (Booby Trap, Heavy Trap, ...): every
    // props entry with type "trap" is omitted entirely.
    hideBuilding: (typeId, props) => String(props?.type || "") === "trap",
  });
  view.renderer = renderer;
  canvas.style.cursor = "grab";
  renderer.setTheme("grass");
  renderer.setResources?.(safeObject(data?.resources));
  renderer.forceTownHallAtZero = String(data?.type || "") === "main";
  renderer.setBuildings(safeObject(data?.buildingdata), {
    healthData: safeObject(data?.buildinghealthdata),
    savetime: data?.savetime,
    servertime: data?.currenttime,
    baseseed: data?.baseseed,
  });
  // Mushrooms are deliberately not drawn in the viewer.
  renderer.setEffects?.(safeArray(data?.effects));
  renderer.setLockerData?.(data?.lockerdata);
  populatePens(renderer, data);
  const hud = backdrop.querySelector(".base-view-hud");
  if (isOwnYard) {
    // The arrow opens a picker rather than cycling blindly: main yard first,
    // then outposts by empire value. Opening one goes through prepareFor, so
    // it refreshes the zone and re-resolves the base id exactly as clicking
    // View Yard on the map does.
    // /base/load carries the owner's complete outpost list; the cache only
    // has the zones this browser has fetched. Rebuild from the save when one
    // is available, and keep the list passed in as the fallback.
    const bases = typeof baseListFor === "function"
      ? baseListFor(data?.outposts, data?.homebase)
      : outpostList;
    renderOwnYardHud(backdrop, data, bases, (entries, anchor) => {
      openBasePicker(backdrop, anchor, entries, resolvedBaseid, x, y, (entry) => {
        openBaseView({
          token, baseid: String(entry.baseid), userid, name,
          isMain: Boolean(entry.isMain), isOwnYard: true,
          outpostList: entries, x: entry.x, y: entry.y,
          prepare: typeof prepareFor === "function"
            ? prepareFor(entry.x, entry.y)
            : undefined,
          prepareFor, baseListFor, recoverToken,
        });
      });
    });
  } else {
    // Someone else's yard: UI_TOP frame "view" is just the level plate and
    // the owner's framed picture - no resource rows, no outposts row.
    renderVisitorHud(
      backdrop,
      data,
      String(data?.name || "").trim() || String(name || "").trim(),
      ownerPic,
    );
  }
  status.remove();
  const shown = backdrop.querySelector(".base-view-title");
  const ownerName = String(data?.name || "").trim() || resolvedName || String(name || "").trim();
  if (shown) {
    shown.textContent = buildBaseTitle(ownerName, isMain, x, y);
  }
  debugLog(`Base view open: baseid ${resolvedBaseid}, ${renderer.buildings.length} structures.`);
}
