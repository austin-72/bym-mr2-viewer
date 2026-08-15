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
  CHAMPION_NAMES,
  guardianInfo,
  guardianRow,
  guardianSheet,
  guardianSheetCandidates,
  loadMonsterStats,
  localize,
  MONSTER_NAMES,
  monsterStat,
  parseChampions,
  parseHoused,
  statAtLevel,
  baseLevelInfo,
  HARVESTER_RESOURCE,
} from "./baseview/gamedata.js";
import { YardRenderer } from "./baseview/yard.js";
import { buildBymUrl, debugLog, escapeHtml, fetchJson } from "./shared.js";

/**
 * GLOBAL.SetBuildingProps() swaps the whole props table by yard type:
 *
 *   INFERNO_YARD -> INFERNOYARDPROPS._infernoYardProps
 *   OUTPOST      -> OUTPOST_YARD_PROPS._outpostProps
 *   default      -> YARD_PROPS._yardProps
 *
 * The three tables share an id space - id 1 is a Twig Snapper in the main
 * table and a Bone Harvester in the Inferno one - so art is not a path
 * prefix, it is a different table entirely. Extracted from the client and
 * loaded lazily, since most sessions never open an Inferno base.
 */
const PROPS_TABLES = {
  main: "/data/yardprops.json",
  outpost: "/data/outpostyardprops.json",
  inferno: "/data/infernoyardprops.json",
};

const gameDataPromises = {};

function loadGameDataFor(table = "main") {
  const url = PROPS_TABLES[table] || PROPS_TABLES.main;
  if (!gameDataPromises[table]) {
    gameDataPromises[table] = Promise.all([
      GameData.load(url),
      loadMonsterStats("/data/monsterstats.json").catch(() => ({})),
    ]).then(([gameData]) => gameData).catch((error) => {
      gameDataPromises[table] = null;
      throw error;
    });
  }
  return gameDataPromises[table];
}

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

  // Housings: BUILDING15 on the overworld, alive (destroyed pens hold no
  // visible monsters).
  //
  // The Inferno yard uses a DIFFERENT type id. A real `type=ibuild` payload
  // contains zero t=15 buildings; its housing is t=128, which
  // infernoyardprops names "#bi_housing#" while yardprops calls the same id
  // "#b_housingbunker#". The three props tables share id numbering but not
  // meaning, so a single hardcoded 15 populates the overworld and leaves the
  // Compound empty - which is exactly the reported symptom.
  //
  // Only the Inferno adds 128. The overworld housing bunker may well hold
  // monsters too, but no payload here shows one, and HOUSING.Populate is not
  // available to check, so it is left out rather than guessed at.
  const isInfernoYard = String(data?.type || "") === "inferno";
  const housingTypes = isInfernoYard ? new Set([15, 128]) : new Set([15]);
  const housings = entries
    .map(([key, record]) => ({ record, placed: anchorFor(key, record) }))
    .filter(({ record, placed }) => housingTypes.has(Number(record.t)) && placed && placed.state !== "destroyed");
  const academy = safeObject(data?.academy);
  if (housings.length) {
    // Two payload shapes. An overworld yard nests the roster under
    // `monsters.housed` alongside h/hcc/hid/space/hstage; the Inferno sends
    // `monsters` as the roster itself - a flat key->count map, e.g.
    // {"IC8": 18} - with no `housed` at all. Reading only `.housed` therefore
    // found nothing in the Compound even once the housing type was right.
    // parseHoused ignores any key that is not C*/IC*, so handing it the
    // overworld wrapper by mistake yields an empty list rather than garbage.
    const monsters = safeObject(data?.monsters);
    const housedRaw = monsters.housed && typeof monsters.housed === "object"
      ? monsters.housed
      : monsters;
    const housedData = parseHoused(housedRaw);
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
/**
 * The player's own Inferno base.
 *
 * INFERNOPORTAL.ToggleYard() loads it with BASE.LoadBase(GLOBAL._infBaseURL,
 * 0, 0, "ibuild", ...) - the same /base/load endpoint, mode "ibuild", and the
 * server ignores the baseid entirely for Inferno modes (infernoModeBuild reads
 * user.infernosave, creating one if the player has never entered). So there is
 * nothing to resolve first: no zone refresh, no base id.
 */
async function fetchInfernoBase(token, userid, recoverToken = null) {
  const attempt = (activeToken) => fetchJson(buildBymUrl("/base/load"), {
    method: "POST",
    headers: {
      "X-Fetch-Priority": "10",
      Authorization: `Bearer ${activeToken}`,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body: new URLSearchParams({
      type: "ibuild",
      // BaseLoadSchema requires userid as a string and rejects the request
      // with a 500 ZodError without it, even though infernoModeBuild reads
      // the user from the session and ignores the baseid.
      userid: String(userid ?? 0),
      baseid: "0",
      mapversion: "2",
    }),
  });
  try {
    return await attempt(token);
  } catch (error) {
    const fresh = typeof recoverToken === "function" ? await recoverToken() : null;
    if (!fresh || fresh === token) throw error;
    return attempt(fresh);
  }
}

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
function buildBaseTitle(name, isMain, x, y, isWild = false, isInferno = false) {
  // Wild monster camps have no owner, so they title as just "Camp at x,y".
  if (isInferno) return "Inferno Base";
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

// The Inferno yard reuses the same plate geometry with its own resources.
// Harvester ids map to resource slots identically (HARVESTER_RESOURCE), and
// the Inferno props name them bone / coal / sulfur / magma, so r1..r4 are
// Bones, Coal, Sulfur and Magma rather than Twigs, Pebbles, Putty and Goo.
//
// Confirmed from real payloads rather than assumed: an overworld base reports
// `resources` with r1max 193,050,000 and `iresources` with r1max 19,210,000,
// while the Inferno base reports `resources` with r1max 19,210,000 - the same
// figure. So a yard's own `resources` field is already the right one to read
// in both cases; only the labelling was wrong.
//
// The icon art is a separate set that is NOT in this repo yet. Each row lists
// the Inferno icon first and the overworld icon second: CSS paints multiple
// background layers front-to-back and simply skips one that fails to load, so
// until the Inferno icons are extracted these fall back to the overworld art
// instead of rendering blank squares.
const HUD_ROWS_INFERNO = HUD_ROWS.map((row, index) => ({
  ...row,
  label: ["Bones", "Coal", "Sulfur", "Magma"][index],
  icon: `inferno/${row.icon}`,
  iconFallback: row.icon,
}));

// UI_TOP.Setup: KEYS uitop_backyardmonstersinferno.
const HUD_TITLE_INFERNO = "INFERNO";

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
        title="${entry.isInferno ? "Inferno Yard"
          : `Empire value ${escapeHtml(formatFull(entry.value))}`}">
        <span>${entry.isInferno ? "Inferno Yard" : (entry.isMain ? "Main Yard" : "Outpost")}</span>
        <span>${escapeHtml(`${entry.x}, ${entry.y}`)}</span>
        <span>${escapeHtml(entry.kit || (entry.isMain || entry.isInferno ? "N/A" : "None"))}</span>
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

// ── Inferno Cavern ─────────────────────────────────────────────────────
// INFERNOPORTAL.AddPortal() synthesises the building rather than reading it
// from the save - the cavern is never in buildingdata - so the viewer has to
// do the same. Verbatim from the client:
//
//   Point(-1200, -150), BASE.addBuildingC(127), Setup({X, Y, t: 127, l})
//
// AddPortal(5) is the level used once the descent is passed, which is the
// state any player who can reach their Inferno base is in.
/**
 * Ground texture, from BASE.as's own decision:
 *
 *   var terrainType = "grass";
 *   if (!isInMapRoom3 && _currentCell &&
 *       (isOutpostOrInfernoOutpost || mode == WMATTACK || mode == WMVIEW))
 *     terrainType = (_currentCell as MapRoomCell).terrain;
 *   if (isInfernoMainYardOrOutpost) terrainType = "lava";
 *
 * So only outposts and wild monster cells take their ground from the map;
 * a main yard is always grass, and Inferno overrides everything.
 *
 * MapRoomCell derives .terrain from the cell's height, and the height is the
 * `i` field getarea returns - userCell.ts and wildMonsterCell.ts both emit
 * `i: cell.terrainHeight`. Its thresholds, collapsed from the run of
 * gotoAndStop branches:
 *
 *   < 110  sand      (sand1, sand2)
 *   < 170  grass     (land1 .. land4)
 *   else   rock      (land5, land6)
 */
// MAP.swapIntBG's own mapping, index = ExtraTilesReward.value.
// ExtraTilesReward is the D.A.V.E. club (subscription) reward: its `value`
// picks the ground for your own main yard, and the reward's canBeApplied() is
// GLOBAL.isAtHome(), so it applies there and nowhere else. Confirmed against a
// live /base/load: rewards.extraTiles = {"id":"extraTiles","value":3} -> the
// crater ground. Rewards that are unlocked but unset carry no `value` at all
// (e.g. {"id":"daveStatue"}), which reads as NaN and falls through to grass.
//
// The order is the client's, not alphabetical or by rarity - do not re-sort.
const MAP_TYPE_TEXTURE = ["grass", "rock", "sand", "crater", "lava"];

// MapRoomCell.Update()'s height bands, in full. The names are the frame labels
// it calls gotoAndStop with; the numbers match the server's Terrain enum.
//
//   i < 80    water1    80..90   water2    90..100  water3   (_water, no terrain)
//   100..105  sand1     105..110 sand2                       -> sand
//   110..120  land1     120..140 land2
//   140..160  land3     160..170 land4                       -> grass
//   170..175  land5     i >= 175 land6                       -> rock
//
// SETTLED: the bounds are EXCLUSIVE upper bounds, so a height of exactly 170
// is land5, i.e. rock. This was previously flagged here as unresolved, on the
// grounds that the server's water test `terrainHeight <= Terrain.WATER3` reads
// as inclusive. It is not the same kind of constant: RESERVED = 100 is a
// PRE-offset value, and the generator's `+= 10` step means i == 110 can never
// be emitted at all, while i == 100 occurs freely and renders as sand1.
//
// Bases never sit on water: createCellData short-circuits `terrainHeight <=
// WATER3` to a bare {i}, so only the sand/grass/rock arm is reachable here.
const WATER_TERRAIN_BELOW = 100; // _water = _height < 100
const TERRAIN_SAND_BELOW = 110;  // Terrain.SAND2
const TERRAIN_GRASS_BELOW = 170; // Terrain.LAND4

function extraTilesTexture(data) {
  const value = Number(data?.rewards?.extraTiles?.value);
  return Number.isFinite(value) ? MAP_TYPE_TEXTURE[value] : undefined;
}

/**
 * BASE.Build()'s two passes, in order.
 *
 * Pass 1 (BASE.as:1726-1735) starts at "grass" and only consults cell height
 * when the yard is an outpost OR the mode is wmattack/wmview - then Inferno
 * overrides everything to lava:
 *
 *   var terrainType = "grass";
 *   if (!isInMapRoom3 && _currentCell &&
 *       (isOutpostOrInfernoOutpost || mode == WMATTACK || mode == WMVIEW))
 *      terrainType = (_currentCell as MapRoomCell).terrain;
 *   if (isInfernoMainYardOrOutpost) terrainType = "lava";
 *
 * A wild tribe cell (b == 1) loads as MAIN_YARD but in wmview mode, so it
 * passes the gate on the MODE; an outpost (b == 3) passes on the yard type.
 * Another player's main yard (b == 2) passes neither, so height NEVER affects
 * it - main yards are grass regardless of the ground they stand on.
 *
 * Pass 2 is ExtraTilesReward, applied later from RewardHandler.initialize().
 * canBeApplied() is GLOBAL.isAtHome() - build mode on your own main yard - and
 * RewardHandler bails on Inferno, so it reaches your own main yard and nothing
 * else. A subscriber's yard is genuinely built as grass and then rebuilt.
 */
function terrainFor({ isInferno, isMain, isWild, isOwnYard, terrainHeight, data }) {
  if (isInferno) return "lava";
  if (isMain) {
    // Only your own home yard: the reward is yours, and a base you are
    // visiting carries its owner's rewards in the payload, which the game
    // does not apply.
    return (isOwnYard && extraTilesTexture(data)) || "grass";
  }
  const height = Number(terrainHeight);
  // Height unknown (a cell this browser has not cached): Pass 1's own starting
  // value, which is what a null _currentCell would have left in place.
  if (!Number.isFinite(height)) return "grass";
  // Water. MapRoomCell._terrain is declared with no initialiser and the
  // height < 100 branch of Update() never assigns it, so it stays null.
  // MakeTile then matches no texture, leaves tileCount at 0, and returns a
  // fully transparent tile - the yard renders with no ground at all. Bases
  // are never placed on water (findFreeCell and createCellData both reject
  // terrainHeight <= WATER3), so this is unreachable in practice; it is
  // reproduced rather than papered over with grass.
  if (height < WATER_TERRAIN_BELOW) return null;
  if (height < TERRAIN_SAND_BELOW) return "sand";
  if (height < TERRAIN_GRASS_BELOW) return "grass";
  return "rock";
}

const INFERNO_PORTAL_TYPE = 127;
const INFERNO_PORTAL_POS = { x: -1200, y: -150 };
const INFERNO_PORTAL_LEVEL = 5;

function withInfernoCavern(buildingData) {
  const data = { ...(buildingData || {}) };
  // A key the save can never contain, so it cannot collide with a real record.
  data["inferno-portal"] = {
    t: INFERNO_PORTAL_TYPE,
    X: INFERNO_PORTAL_POS.x,
    Y: INFERNO_PORTAL_POS.y,
    l: INFERNO_PORTAL_LEVEL,
    id: "inferno-portal",
  };
  return data;
}

/**
 * The cavern popup, rebuilt from popup_infernoentice_CLIP.
 *
 * The clip is mcFrame (frame3_CLIP) + a 490x400 art panel + tDesc + a
 * Button_CLIP labelled btn_entercavern. INFERNO_DESCENT_POPUPS.ShowEnticePopup
 * fills tDesc from KEYS "entercavern_direct_popup" and the button from
 * "btn_entercavern"; the title comes from "entercavern_direct_popup_title".
 */
function openInfernoPopup(backdrop, onEnter) {
  backdrop.querySelector(".inferno-popup")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "inferno-popup game-frame frame-inferno";
  wrap.setAttribute("role", "dialog");
  // Strings come from the game's own language table, exactly as
  // ShowEnticePopup reads them; the English text is only a fallback for when
  // the table has not loaded. These were hardcoded before, so a non-English
  // client still got English here, and the title - which the clip has - was
  // missing entirely.
  const title = localize("entercavern_direct_popup_title", "Inferno Cavern");
  const desc = localize("entercavern_direct_popup",
    "Conquer Inferno! Defeat the evil overlord Moloch to claim your own "
    + "Inferno base. Use it to boost the power of your backyard war machine!");
  const enter = localize("btn_entercavern", "Enter Cavern");
  wrap.innerHTML = `
    <h2 class="inferno-title"></h2>
    <img class="inferno-art" src="/assets/ui/inferno_entice.png" alt="" width="420" height="343">
    <p class="inferno-desc"></p>
    <div class="inferno-actions">
      <button type="button" class="secondary-button inferno-enter"></button>
    </div>
    <button type="button" class="frame-button-close inferno-close"
      aria-label="Close">&times;</button>`;
  // textContent, not interpolation: these strings come from a fetched table.
  wrap.querySelector(".inferno-title").textContent = title;
  wrap.querySelector(".inferno-desc").textContent = desc;
  wrap.querySelector(".inferno-enter").textContent = enter;
  wrap.setAttribute("aria-label", title);
  backdrop.appendChild(wrap);

  const close = () => {
    wrap.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (event) => {
    if (!wrap.isConnected) { close(); return; }
    if (event.key === "Escape") { event.stopPropagation(); close(); }
  };
  document.addEventListener("keydown", onKey, true);
  wrap.querySelector(".inferno-close").addEventListener("click", close);
  wrap.querySelector(".inferno-enter").addEventListener("click", () => {
    close();
    onEnter();
  });
  wrap.querySelector(".inferno-enter").focus();
}

/** Own-yard HUD: level plate, four resource rows, then the outposts row. */
function renderOwnYardHud(backdrop, data, outpostList, onNextOutpost, isInferno = false) {
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
  // The Inferno yard is listed in the picker but is NOT an outpost: counting
  // it here would inflate the plate's number by one for every player.
  const outpostCount = outposts
    .filter((entry) => !entry?.isMain && !entry?.isInferno).length;
  // The arrow must still open when the only other entry is the Inferno yard,
  // otherwise a player with no outposts has no way to reach it from the HUD.
  const pickable = outposts.length > 1;

  const lvl = baseLevelInfo(data?.points, data?.basevalue);
  const levelFill = Math.max(0, Math.min(
    HUD_LEVEL_FILL_MAX,
    (HUD_LEVEL_FILL_MAX / Math.max(1, lvl.upper - lvl.lower)) * (lvl.points - lvl.lower),
  ));

  const rows = (isInferno ? HUD_ROWS_INFERNO : HUD_ROWS)
    .map(({ key, label, icon, iconFallback, w, h, dx, dy, x, y }) => {
    const value = Number(resources[key]) || 0;
    const max = Number(resources[key + "max"]) || 0;
    const fill = max > 0 ? Math.min(HUD_FILL_MAX, (HUD_FILL_MAX / max) * value) : 0;
    const title = `${label}: ${formatFull(value)}${max ? " / " + formatFull(max) : ""}`;
    return `
      <div class="hud-row" style="left:${x}px;top:${y}px" title="${escapeHtml(title)}">
        <span class="hud-fill" style="width:${fill.toFixed(2)}px"></span>
        <span class="hud-num">${escapeHtml(formatFull(value))}</span>
        <span class="hud-icon" style="background-image:${iconFallback
          ? `url('${HUD_ASSETS}${icon}'),url('${HUD_ASSETS}${iconFallback}')`
          : `url('${HUD_ASSETS}${icon}')`};left:${dx}px;top:${dy}px;width:${w}px;height:${h}px"></span>
        <span class="hud-plus" aria-hidden="true"></span>
      </div>`;
  }).join("");

  hud.innerHTML = `
    <div class="hud-level" title="Level ${escapeHtml(String(lvl.level))} &middot; ${escapeHtml(formatFull(lvl.points))} points">
      <span class="hud-level-fill" style="width:${levelFill.toFixed(2)}px"></span>
      <span class="hud-level-title">${escapeHtml(isInferno ? HUD_TITLE_INFERNO : HUD_TITLE)}</span>
      <span class="hud-level-star"></span>
      <span class="hud-level-num">${escapeHtml(String(lvl.level))}</span>
    </div>
    ${rows}
    <div class="hud-outposts" style="top:${HUD_OUTPOSTS_Y}px">
      <span class="hud-outpost-icon"></span>
      <span class="hud-outpost-count">${escapeHtml(formatFull(outpostCount))}</span>
      <button type="button" class="hud-next-outpost" title="Choose a base to view"
        ${pickable ? "" : "disabled"}></button>
    </div>`;
  hud.hidden = false;

  const next = hud.querySelector(".hud-next-outpost");
  if (next && pickable && typeof onNextOutpost === "function") {
    next.addEventListener("click", () => onNextOutpost(outposts, next));
  }
}


// ── Visitor action bar: UI_VISITOR (assets.swf symbol 530) ───────────────
// mcBG (shape 526, gameui/attack/visitor_bg.png) behind one standard Button
// (sprite 13) at (10, 10) scaled 1.2307739 -> 81.2 x 31. The game's
// single-button states set mcBG.width = 100, and Resize() pins the clip to
// the bottom-right: x = right - width - 10, y just above the bottom HUD.
// This viewer has no bottom HUD, so the plate sits 10px off both edges.
//
// One deliberate change of purpose: the viewer cannot launch real attacks,
// so bAttack reads "Simulate Attack" and starts a purely cosmetic,
// never-saved simulation. It shows on EVERY yard - your own included. Per
// spec, bReturn's "Open Map" state is not rendered; in attack mode the same
// button art carries "btn_endattack", exactly as
// `mc.bReturn.SetupKey("btn_endattack"); mc.bAttack.visible = false` does.
const ATK_ASSETS = "/assets/gameui/attack/";

function removeVisitorBar(backdrop) {
  backdrop.querySelector(".base-view-visitor-bar")?.remove();
}

function renderVisitorBar(backdrop, view, mode = "view") {
  removeVisitorBar(backdrop);
  const shell = backdrop.querySelector(".base-view-canvas-shell");
  if (!shell) return;

  const bar = document.createElement("div");
  bar.className = "base-view-visitor-bar";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "game-button visitor-action";
  if (mode === "attack") {
    button.classList.add("visitor-end-attack");
    button.textContent = localize("btn_endattack", "End Attack");
    button.addEventListener("click", () => exitSimulatedAttack(backdrop, view));
  } else {
    button.classList.add("visitor-attack");
    button.textContent = "Attack (fake)";
    button.addEventListener("click", () => enterSimulatedAttack(backdrop, view));
  }
  const shot = document.createElement("button");
  shot.type = "button";
  shot.className = "game-button hl visitor-screenshot";
  shot.textContent = "Screenshot";
  shot.addEventListener("click", () => {
    shot.disabled = true;
    captureBaseViewScreenshot(backdrop, view)
      .finally(() => { shot.disabled = false; });
  });
  bar.appendChild(shot);
  bar.appendChild(button);

  shell.appendChild(bar);
}

// ── Screenshot ───────────────────────────────────────────────────────────
// Captures the yard exactly as shown - canvas, DOM HUD, visitor bar,
// message strip - stamps maproom2.com in the bottom-right and downloads a
// PNG. The DOM layer travels through an SVG <foreignObject>: the shell is
// cloned, every node carries its computed style inline, and every <img> and
// url() reference is converted to a data URL, so the vector snapshot needs
// no network and paints identically. Browsers that taint foreignObject
// canvases fall back to a canvas-only capture, still watermarked.

const screenshotDataUrlCache = new Map();

async function fetchAsDataUrl(url) {
  if (screenshotDataUrlCache.has(url)) return screenshotDataUrlCache.get(url);
  const request = fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.blob();
    })
    .then((blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    }))
    .catch((error) => { screenshotDataUrlCache.delete(url); throw error; });
  screenshotDataUrlCache.set(url, request);
  return request;
}

// Pairs source and clone subtrees by traversal order (identical by
// construction) and freezes every computed style inline, so the snapshot
// doesn't depend on the stylesheet.
function inlineComputedStyles(source, clone) {
  const src = [source, ...source.querySelectorAll("*")];
  const dst = [clone, ...clone.querySelectorAll("*")];
  for (let i = 0; i < src.length && i < dst.length; i += 1) {
    const computed = window.getComputedStyle(src[i]);
    let css = "";
    for (const prop of computed) {
      css += `${prop}:${computed.getPropertyValue(prop)};`;
    }
    dst[i].setAttribute("style", css);
  }
}

// Rewrites every <img> src and every url(...) in the frozen styles (loot
// bars, the visitor plate's border-image, backgrounds) to data URLs.
async function inlineScreenshotResources(clone) {
  await Promise.all([...clone.querySelectorAll("img")].map(async (img) => {
    const src = img.getAttribute("src") || "";
    if (!src || src.startsWith("data:")) return;
    try {
      img.setAttribute("src", await fetchAsDataUrl(src));
    } catch {
      img.remove();
    }
  }));
  for (const el of [clone, ...clone.querySelectorAll("*")]) {
    let style = el.getAttribute("style") || "";
    const urls = [...style.matchAll(/url\("?([^")]+)"?\)/g)]
      .map((match) => match[1])
      .filter((url) => url && !url.startsWith("data:"));
    for (const url of [...new Set(urls)]) {
      try {
        const data = await fetchAsDataUrl(url);
        style = style.split(url).join(data);
      } catch {
        /* leave the reference; that one texture just won't paint */
      }
    }
    el.setAttribute("style", style);
  }
}

// The HUD's display face (Grobold and its aliases) has to travel inside the
// SVG: an image document cannot reach the page's @font-face rules, and
// without this the HUD numbers would silently fall back to a default serif.
const SCREENSHOT_FONTS = [
  ["Groboldov", "/assets/fonts/groboldov-bold.ttf"],
  ["Grobold", "/assets/fonts/grobold.ttf"],
  ["GROBOLD", "/assets/fonts/grobold.ttf"],
  ["GROBOLDpro", "/assets/fonts/groboldov-bold.ttf"],
];

async function buildEmbeddedFontStyle() {
  const rules = [];
  for (const [family, path] of SCREENSHOT_FONTS) {
    try {
      const data = await fetchAsDataUrl(path);
      rules.push(
        `@font-face{font-family:"${family}";src:url("${data}") `
        + `format("truetype");font-weight:700;}`);
    } catch {
      /* the family just falls back, matching a client without the file */
    }
  }
  return rules.join("");
}

async function rasterizeShellUi(shell, width, height, scale) {
  const clone = shell.cloneNode(true);
  inlineComputedStyles(shell, clone);
  clone.querySelector("canvas")?.remove();
  await inlineScreenshotResources(clone);
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  // The outer size carries the capture scale while the viewBox keeps CSS-px
  // layout, so text and vector chrome rasterize crisply at full resolution.
  const fontStyle = await buildEmbeddedFontStyle();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" `
    + `width="${width * scale}" height="${height * scale}" `
    + `viewBox="0 0 ${width} ${height}">`
    + (fontStyle ? `<style>${fontStyle}</style>` : "")
    + `<foreignObject width="100%" height="100%">`
    + new XMLSerializer().serializeToString(clone)
    + `</foreignObject></svg>`;
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("SVG snapshot failed to load"));
    image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
  return image;
}

// Re-renders the yard into its own canvas at the capture scale, copies the
// buffer, then restores the on-screen resolution. Camera and framing are
// untouched: draw() divides the buffer by ratio, so scaling both together
// reproduces the exact viewport at higher density. Falls back to the live
// buffer if anything about the renderer looks unfamiliar.
function snapshotYardAtScale(view, canvas, width, height, scale) {
  const renderer = view?.renderer;
  const snapshot = document.createElement("canvas");
  snapshot.width = width * scale;
  snapshot.height = height * scale;
  const sctx = snapshot.getContext("2d");
  if (!renderer || typeof renderer.draw !== "function") {
    sctx.drawImage(canvas, 0, 0, snapshot.width, snapshot.height);
    return snapshot;
  }
  const prevWidth = canvas.width;
  const prevHeight = canvas.height;
  const prevRatio = renderer.ratio;
  let rendered = false;
  try {
    canvas.width = width * scale;
    canvas.height = height * scale;
    renderer.ratio = scale;
    renderer.draw();
    sctx.drawImage(canvas, 0, 0);
    rendered = true;
  } catch (error) {
    debugLog("High-res yard render failed; using live buffer", error);
  } finally {
    canvas.width = prevWidth;
    canvas.height = prevHeight;
    renderer.ratio = prevRatio;
    renderer.invalidate();
    try { renderer.draw(); } catch { /* the rAF loop will repaint */ }
  }
  if (!rendered) {
    sctx.clearRect(0, 0, snapshot.width, snapshot.height);
    sctx.drawImage(canvas, 0, 0, snapshot.width, snapshot.height);
  }
  return snapshot;
}

async function captureBaseViewScreenshot(backdrop, view) {
  const shell = backdrop.querySelector(".base-view-canvas-shell");
  const canvas = backdrop.querySelector(".base-view-canvas");
  if (!shell || !canvas) return;
  const shellRect = shell.getBoundingClientRect();
  const width = Math.max(1, Math.round(shellRect.width));
  const height = Math.max(1, Math.round(shellRect.height));
  // At least 2x, or the screen's own density if higher (capped at 3x so a
  // huge window doesn't allocate a monster buffer).
  const ratio = Math.min(Math.max(2, window.devicePixelRatio || 1), 3);

  // The plate mirrors the loot pill, bottom-left where nothing anchors.
  const drawWatermark = (ctx) => {
    ctx.font = "700 12px Verdana, Geneva, 'DejaVu Sans', Tahoma, sans-serif";
    const text = "maproom2.com";
    const plateW = ctx.measureText(text).width + 12;
    const plateH = 20;
    const x = 8;
    const y = height - plateH - 8;
    ctx.fillStyle = "rgba(20, 16, 8, 0.72)";
    ctx.beginPath();
    ctx.roundRect(x, y, plateW, plateH, 4);
    ctx.fill();
    ctx.fillStyle = "#ffd97a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + plateW / 2, y + plateH / 2);
  };

  const yardLayer = snapshotYardAtScale(view, canvas, width, height, ratio);

  const compose = (uiLayer) => {
    const out = document.createElement("canvas");
    out.width = width * ratio;
    out.height = height * ratio;
    const ctx = out.getContext("2d");
    ctx.scale(ratio, ratio);
    // Both layers were produced at exactly width*ratio, so these draws are
    // 1:1 buffer copies - no resampling anywhere in the pipeline.
    ctx.drawImage(yardLayer, 0, 0, width, height);
    if (uiLayer) ctx.drawImage(uiLayer, 0, 0, width, height);
    drawWatermark(ctx);
    return out;
  };

  let dataUrl = null;
  try {
    const uiLayer = await rasterizeShellUi(shell, width, height, ratio);
    dataUrl = compose(uiLayer).toDataURL("image/png");
  } catch (error) {
    debugLog("Screenshot UI layer failed; falling back to canvas-only", error);
  }
  if (!dataUrl) {
    try {
      dataUrl = compose(null).toDataURL("image/png");
    } catch (error) {
      debugLog("Screenshot capture failed", error);
      showYardMessage(backdrop, "Screenshot failed");
      return;
    }
  }

  const title = backdrop.querySelector(".base-view-title")?.textContent || "base";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const link = document.createElement("a");
  link.download = `maproom2-${title.replace(/[^\w.-]+/g, "_").slice(0, 60)}-${stamp}.png`;
  link.href = dataUrl;
  link.click();
  showYardMessage(backdrop, "Screenshot saved");
}

// GLOBAL.Message stand-in: one line of display-font text, centred at the top
// of the yard, that fades itself away. Only ever one at a time - a second
// message replaces the first, as the game's single message field does.
function showYardMessage(backdrop, text) {
  const shell = backdrop.querySelector(".base-view-canvas-shell");
  if (!shell) return;
  shell.querySelector(".base-view-message")?.remove();
  const strip = document.createElement("div");
  strip.className = "base-view-message";
  strip.setAttribute("role", "status");
  strip.textContent = text;
  shell.appendChild(strip);
  void strip.offsetWidth; // force layout so the fade-in transition runs
  strip.classList.add("visible");
  window.setTimeout(() => {
    if (!strip.isConnected) return;
    strip.classList.remove("visible");
    strip.addEventListener("transitionend", () => strip.remove(), { once: true });
    window.setTimeout(() => strip.remove(), 600); // reduced-motion fallback
  }, 3800);
}

// ── Simulated attack mode ────────────────────────────────────────────────
// Cosmetic port of the game's WMATTACK top UI, geometry and art taken
// directly from assets.swf (all coordinates below are the SWF's own
// placements). Nothing talks to a server, nothing is saved.
//
// UI_TOP.setupAttackMode / updateAttackMode:
//   - level plate keeps the target's name; the owner's picture stays on it
//     (the wmattack branch of the loader in UI_TOP loads BASE._ownerPic);
//   - the four resource rows become LOOT counters: tR = ATTACK._loot,
//     mcBar.visible = false;
//   - flingerLevel (symbol 2160) at y = 3*60 with inner _mc at (2, -6):
//     top panel shape 2150 (200x28) holding _txtContainer at (3.5, 3) -
//     parchment strip 570 at 192.05 x 21.5, the red mcBar (shape 2154)
//     growing with used/capacity, flinger_txt (Verdana 10 bold black) and
//     tA ("NN%") at x 127.95;
//   - champion buttons first, then creatures, each at x 14, y 34 + i*53
//     (GUARDIANBUTTON_CLIP 2140 / CREATUREBUTTON_CLIP 2102): _bg shapes
//     2095-2098 at 2.3530731 x 0.59954834 -> 200 x 53.96, alternating
//     bg1/bg2 and flipping to full1/full2 when spent; _bottomBar (200x8)
//     under the last row;
//   - CATAPULTPOPUP at (350, 20): collapsed _imageContainer at (-348, 52)
//     -> hud (2, 72), the 99x99 iconbg (shape 1733), the bomb image 60x60
//     at (20.55, 9) URL-loaded from bombbuttons/, txtName at (17.65, 78.45);
//     clicking opens _mc with the eleven CATAPULTITEM slots at the SWF's
//     own coordinates. Hidden on Inferno yards, as in game;
//   - SIEGEWEAPONPOPUP at (442, 20): _iconbg at (-338.55, 52) -> hud
//     (103.45, 72), weapon image from siegebuttons/<id>.png, txtName at
//     (16.8, 71) rel. Hidden on Inferno yards.
//
// Cosmetic stand-ins until the sim gets real inputs: max-level Flinger, 999
// of every creature at its own max academy level, all five champions at
// level 6, and the Jars as the available chaos weapon.

const SIM_ROSTER_MAIN = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9",
  "C10", "C11", "C12", "C13", "C14", "C15", "C16", "C17", "C19"];
const SIM_ROSTER_INFERNO = ["IC1", "IC2", "IC3", "IC4", "IC5", "IC6", "IC7", "IC8"];
const SIM_CHAMPIONS = [1, 2, 3, 4, 5]; // Gorgo, Drull, Fomor, Korath, Krallen

// A champion's level count is the length of its per-level stat arrays in
// CHAMPIONCAGE's tables (health/speed/damage all agree): 6 for Gorgo,
// Drull, Fomor and Korath - but only FIVE for Krallen, whose arrays stop at
// L5. Hardcoding 6 for everyone invented a Krallen level that does not
// exist.
function championMaxLevel(t) {
  const health = guardianInfo(t)?.props?.health;
  return Array.isArray(health) && health.length ? health.length : 6;
}
const SIM_STOCK = 999;

// ResourceBombs._bombs, verbatim FROM THE LIVE REFITTED CLIENT
// (bym-refitted/bymr-client-versions ResourceBombs.as) - the refitted
// project rebalanced the whole table one tier down from the classic
// values (tw: 2200/7000/50000 vs the old 7000/50000/150000, pebbles and
// putty radii likewise), so porting the older decompile made every sim
// bomb hit like the game's next tier up. Putty rows carry the enrage
// fields (damageMult/speed/speedlength) for when monsters can be slowed.
// Images are URL-loaded through the permanent /imagecache proxy exactly as
// ImageCache.GetImageWithCallBack(props.image) does. Slot positions are the
// named placeholders inside CATAPULTPOPUP_view's _mc.
const SIM_BOMBS = [
  { id: "tw0", x: 359.6, y: 42.65,  name: "bomb_tw0_name", fallback: "Small",  image: "bombbuttons/twigs1.png",  resource: 1, radius: 200, damage: 2200,  particles: 200, dropTarget: 2 },
  { id: "tw1", x: 288.1, y: 42.65,  name: "bomb_tw1_name", fallback: "Large",  image: "bombbuttons/twigs2.png",  resource: 1, radius: 200, damage: 7000,  particles: 200, dropTarget: 2 },
  { id: "tw2", x: 210.8, y: 42.65,  name: "bomb_tw2_name", fallback: "Huge",   image: "bombbuttons/twigs3.png",  resource: 1, radius: 200, damage: 50000, particles: 200, dropTarget: 2 },
  { id: "pb0", x: 359.6, y: 140.15, name: "bomb_pb0_name", fallback: "Small",  image: "bombbuttons/pebbles1.png", resource: 2, radius: 200, damage: 2400,  particles: 200, dropTarget: 2 },
  { id: "pb1", x: 288.1, y: 140.15, name: "bomb_pb1_name", fallback: "Large",  image: "bombbuttons/pebbles2.png", resource: 2, radius: 300, damage: 9000,  particles: 200, dropTarget: 2 },
  { id: "pb2", x: 210.8, y: 140.15, name: "bomb_pb2_name", fallback: "Huge",   image: "bombbuttons/pebbles3.png", resource: 2, radius: 350, damage: 30000, particles: 200, dropTarget: 2 },
  { id: "pb3", x: 134.6, y: 140.15, name: "bomb_pb3_name", fallback: "Giant",  image: "bombbuttons/pebbles4.png", resource: 2, radius: 400, damage: 75000, particles: 200, dropTarget: 2 },
  { id: "pu0", x: 359.6, y: 236.15, name: "bomb_pu0_name", fallback: "Small",  image: "bombbuttons/putty1.png",  resource: 3, radius: 150, damage: 0, particles: 25, dropTarget: 3, damageMult: 0.8, speed: 1.2, speedlength: 10 },
  { id: "pu1", x: 288.1, y: 236.15, name: "bomb_pu1_name", fallback: "Large",  image: "bombbuttons/putty2.png",  resource: 3, radius: 150, damage: 0, particles: 37, dropTarget: 3, damageMult: 0.6, speed: 1.4, speedlength: 15 },
  { id: "pu2", x: 210.8, y: 236.15, name: "bomb_pu2_name", fallback: "Huge",   image: "bombbuttons/putty3.png",  resource: 3, radius: 300, damage: 0, particles: 43, dropTarget: 3, damageMult: 0.3, speed: 1.8, speedlength: 30 },
  { id: "pu3", x: 134.6, y: 236.15, name: "bomb_pu3_name", fallback: "Giant",  image: "bombbuttons/putty4.png",  resource: 3, radius: 500, damage: 0, particles: 50, dropTarget: 3, damageMult: 0.1, speed: 2, speedlength: 40 },
];

// SiegeWeapons._weaponsList: weaponID -> image "siegebuttons/<id>.png",
// name KEYS "#w_<id>#". The game surfaces only availableWeapon (whatever the
// player's siege factory holds); the sim offers the full trio to pick from.
const SIM_SIEGE_WEAPONS = [
  { id: "jars",   nameKey: "#w_jars#",   fallback: "Jars" },
  { id: "decoy",  nameKey: "#w_decoy#",  fallback: "Decoy" },
  { id: "vacuum", nameKey: "#w_vacuum#", fallback: "Vacuum" },
];

// GLOBAL._buildingProps[flinger].capacity - id 5 ("#b_flinger#") in the
// extracted props: [250, 850, 1500, 2500, 3500, 3500, 3500]. Read from the
// live table so a rebalanced server changes the sim too.
function flingerCapacityFrom(gameData) {
  const capacity = gameData?.get?.(5)?.capacity;
  if (Array.isArray(capacity) && capacity.length) {
    return Number(capacity[capacity.length - 1]) || 3500;
  }
  return 3500;
}

// ImageCache paths, through the viewer's permanent image cache.
function attackImageUrl(path) {
  return `/imagecache/assets/${path}`;
}

function creatureIconUrl(id) {
  return attackImageUrl(`monsters/${encodeURIComponent(id)}-small.png`);
}

// CHAMPIONBUTTON: "monsters/G<t>_L<level>-small.png", level capped at 6.
// Krallen (G5) has only the L5 icon in the asset tree, so every Krallen
// level shows that one - a blank row is worse than a fixed portrait.
function championIconUrl(t, level) {
  const iconLevel = Number(t) === 5 ? 5 : Math.min(6, level);
  return attackImageUrl(`monsters/G${t}_L${iconLevel}-small.png`);
}

// Bomb and siege button art ships WITH the viewer (assets/gameui/attack/
// bombbuttons + siegebuttons) rather than through /imagecache: the refitted
// CDN does not reliably carry these two folders, and a missing icon left
// the widgets as bare plates. Same treatment the zoom/close chrome already
// gets, for the same reason.
function weaponArtUrl(path) {
  return `${ATK_ASSETS}${path}`;
}

function creatureMaxLevel(id) {
  // Academy levels = base level + one per trainingCosts entry. The health
  // array is NOT a level count: Bolt, Fang, Zafreeti and Vorg have
  // level-independent health (a single entry) while still levelling
  // normally, so counting health collapsed their rows. The longest props
  // array still wins if it exceeds the training table.
  const stat = monsterStat(id);
  if (!stat) return 1;
  let levels = Array.isArray(stat.trainingCosts) ? stat.trainingCosts.length + 1 : 1;
  for (const arr of Object.values(stat.props || {})) {
    if (Array.isArray(arr) && arr.length > levels) levels = arr.length;
  }
  return Math.max(1, levels);
}

function creatureBucketCost(key) {
  const id = String(key).split(":")[0]; // "C1:L3" rows share C1's cost
  if (id[0] === "G") {
    // CHAMPIONCAGE.GetGuardianProperty(id, level, "bucket")
    const bucket = guardianInfo(Number(id.slice(1)))?.bucket;
    return Math.max(1, Number(Array.isArray(bucket) ? bucket[0] : bucket) || 200);
  }
  const bucket = monsterStat(id)?.props?.bucket;
  return Math.max(1, Number(Array.isArray(bucket) ? bucket[0] : bucket) || 1);
}

// Button.as's five frames: 1 up, 2 over, 3 disabled, 4/5 green highlight.
// CSS drives up/over/disabled off these classes; width comes from the SWF
// placement scale of each instance.
function gameButton(className, label, widthPx) {
  return `<button type="button" class="game-button ${className}"
    style="width:${widthPx}px">${escapeHtml(label)}</button>`;
}

function creatureRowHtml(entry, index) {
  // Two "columns" inside the dropdown where the game has two dimensions:
  // Feed champions get Level x Feed (feed only exists at 6), the ten
  // Monster Lab monsters get every Level x Ability 0..3 pairing, and
  // everything else is a plain level list.
  const options = [];
  if (entry.feed && entry.maxLevel === 6) {
    options.push(`<option disabled>Lv &middot; Feed</option>`);
    for (let n = 1; n <= 5; n++) {
      options.push(`<option value="L${n}">${n} &middot; &ndash;</option>`);
    }
    for (let f = 0; f <= 3; f++) {
      options.push(`<option value="L6F${f}">6 &middot; ${f}</option>`);
    }
  } else if (entry.ability) {
    const label = ABILITY_NAME[entry.id];
    options.push(`<option disabled>Lv &middot; ${escapeHtml(label)}</option>`);
    for (let n = 1; n <= entry.maxLevel; n++) {
      for (let a = 0; a <= 3; a++) {
        options.push(`<option value="L${n}A${a}">${n} &middot; ${a}</option>`);
      }
    }
  } else {
    for (let n = 1; n <= entry.maxLevel; n++) {
      options.push(`<option value="L${n}">Level ${n}</option>`);
    }
  }
  return `
    <div class="atk-row ${index % 2 ? "alt" : ""}" data-creature="${escapeHtml(entry.id)}"
      data-max="${entry.maxLevel}" style="top:${index * 53}px">
      <span class="atk-row-icon${entry.flush ? " flush" : ""}"
        style="background-image:url('${entry.icon}')"></span>
      <span class="atk-row-name">${escapeHtml(entry.name)}</span>
      <select class="atk-row-level"
        title="${escapeHtml(entry.ability ? `Level / ${ABILITY_NAME[entry.id]}` : entry.feed ? "Level / Feed" : "Level")}"
        >${options.join("")}</select>
      ${gameButton("atk-less", "-", 30.5)}
      ${gameButton("atk-more", "+", 30.5)}
      <span class="atk-row-count"><b>0 / &infin;</b></span>
    </div>`;
}

// ONE row per creature now, with a dropdown choosing the level - and,
// through the same dropdown, ability tiers for monsters (max level +
// ability 0..3) and Feed tiers for Gorgo/Drull/Fomor/Korath (their level
// 6 splits into Feed 0..3). Stock is infinite. Row keys are the BASE id;
// the bucket key ("C1:L3") is resolved from the dropdown at click time.
// Ability names are not in the stats data - the table below carries the
// label per monster and is trivially editable.
// MONSTERLAB._powerupProps, verbatim: exactly these ten monsters have an
// ability, nobody else (no Pokey, no Ichi, no Inferno monster - Balthazar
// included). Brain's localises as "Brain's Cloak Delay".
const ABILITY_NAME = {
  C3: "Blink Range",     C4: "Extra Target(s)",  C7: "Whirlwind",
  C8: "Venom Damage",    C5: "Airburst Bonus",   C9: "Cloak Delay",
  C11: "Acid Damage",    C12: "Rocket Range",    C13: "Splash Damage",
  C14: "Fireball Bounces",
};
const FEED_CHAMPS = new Set([1, 2, 3, 4]);   // Gorgo, Drull, Fomor, Korath

function flingerDisplayName(name) {
  return name === "King Wormzer" ? "K. Wormzer" : name;
}

function buildSimRoster(isInferno) {
  const rows = [];
  for (const t of SIM_CHAMPIONS) {
    if (!guardianInfo(t)) continue;
    const name = CHAMPION_NAMES[t] || guardianInfo(t)?.name || `G${t}`;
    rows.push({ id: `G${t}`, name: flingerDisplayName(name),
      maxLevel: championMaxLevel(t), feed: FEED_CHAMPS.has(t),
      icon: championIconUrl(t, championMaxLevel(t)), flush: true });
  }
  // On an Inferno yard the Inferno family leads, matching whose flinger it
  // notionally is; the whole roster is present either way.
  const families = isInferno
    ? [...SIM_ROSTER_INFERNO, ...SIM_ROSTER_MAIN]
    : [...SIM_ROSTER_MAIN, ...SIM_ROSTER_INFERNO];
  for (const id of families) {
    if (!monsterStat(id)) continue;
    const name = flingerDisplayName(MONSTER_NAMES[id] || id);
    rows.push({ id, name, maxLevel: creatureMaxLevel(id), feed: false,
      ability: Boolean(ABILITY_NAME[id]), icon: creatureIconUrl(id),
      flush: false });
  }
  return rows;
}


// ── Catapult bombs: ResourceBomb + ResourceBombParticle, ported ──────────
// Firing is real now (cosmetically): an armed bomb shows the game's drop
// zone under the cursor, a click rains the particle shower onto the yard,
// each landing particle deals damage/particles to every building the blast
// touched, buildings pass through their damaged/destroyed art exactly as
// buildinghealthdata would drive them, and the debris stays on the ground
// for the rest of the attack. Nothing is saved: End Attack puts every
// building's health back.
//
// Particle sheets (effects/*.png, bundled): twigs 24x30, 5 variations, row
// 2 is the landed art; pebble 27x17 x18 in flight, swapping to the 80x85
// pebblehit animation (20 frames, 4 variations) on impact; putty one 81x52
// blob. Flight is the SWF tween: spawn at (land.x + 100, land.y - stage),
// delay 1 + rand*(dropTarget*2) (putty a flat 1s), duration 0.3 + rand*0.5,
// Sine.easeIn.
const BOMB_SHEETS = {
  twigs:     { file: "effects/twigs.png",     w: 24, h: 30, variations: 5,  ox: -12, oy: -15 },
  spurtzp:   { file: "effects/spurtz_projectile.png" },  // the flying Spurtz itself
  // FIREBALL_CLIP, exported from the game SWF: the 3-frame flame every
  // TYPE_FIREBALL / TYPE_MAGMA projectile plays (magma adds an orange
  // GlowFilter in game). 18x18 per frame at the export's 2x zoom.
  fireball:  { file: "effects/fireball.png",  w: 18, h: 18, frames: 3, ox: -9, oy: -9 },
  // ParticlesObject_CLIP: the dirt chunk EFFECTS.Dig/Burrow scatter.
  dirt:      { file: "effects/dirt.png" },
  pebble:    { file: "effects/pebble.png",    w: 27, h: 17, variations: 18, ox: -13, oy: -9 },
  pebblehit: { file: "effects/pebblehit.png", w: 80, h: 85, variations: 4,  frames: 20, ox: -40, oy: -42 },
  putty:     { file: "effects/putty.png",     w: 81, h: 52, variations: 4,  frames: 15, ox: -40, oy: -26 },
};
const BOMB_ISO_ANGLE = 0.5;      // BASE._angle: the yard's ellipse squash
const BOMB_SPAWN_HEIGHT = 700;   // GLOBAL.StageHeight stand-in, world px
const PEBBLE_HIT_FRAME_MS = 50;

let bombSheetCache = null;
function bombSheets() {
  if (!bombSheetCache) {
    bombSheetCache = {};
    for (const [key, def] of Object.entries(BOMB_SHEETS)) {
      const img = new Image();
      img.src = weaponArtUrl(def.file);
      bombSheetCache[key] = { ...def, img };
    }
  }
  return bombSheetCache;
}

// BASE.EllipseEdgeDistanceSqrd, verbatim: params are FULL axes (the
// function halves them itself), and the return value is the SQUARED
// distance from the ellipse centre to its edge along the angle.
function ellipseEdgeSqrd(theta, w, h) {
  const a = w / 2;
  const b = h / 2;
  const t = Math.tan(theta);
  const x = Math.pow(Math.pow(a, -2) + t * t * Math.pow(b, -2), -0.5);
  const y = t * x;
  return x * x + y * y;
}

// ResourceBomb's target sweep, exact: every live building except traps,
// decorations, enemies and immovables, hit when
//   dist^2 < edgeSqrd(bomb) + edgeSqrd(building)
// with the bomb ellipse built from (radius, radius * 0.8) and the building
// from (_size * 0.5, _size * 0.5 * 0.8), _angle being 0.8 - and BOTH pairs
// halved again inside EllipseEdgeDistanceSqrd. The effective reach is
// therefore roughly sqrt((r/2)^2 + (size/4)^2): compact, nothing like the
// e1 + e2 sum the first cut used, which swept ~3x too far.
//
// The distance falloff you might expect per target does not exist in the
// shipped client: ResourceBomb's `dist` field is never assigned before the
// weight is computed, so weight is always 1 and every target takes the full
// damage-per-particle. Ported as shipped.
function bombTargets(renderer, gameData, center, radius) {
  const targets = [];
  for (const b of renderer?.buildings || []) {
    const props = gameData?.get?.(b.t);
    const cls = String(props?.type || "");
    if (cls === "trap" || cls === "decoration" || cls === "enemy" || cls === "immovable") continue;
    if (b.state === "destroyed" || !b.maxHp) continue;
    const size = Number(props?.size) || renderer.gameData.footprint(b.t);
    const mid = { x: b.x, y: b.y + size * 0.5 };
    const dx = center.x - mid.x;
    const dy = center.y - mid.y;
    const distSq = dx * dx + dy * dy;
    const e1 = ellipseEdgeSqrd(Math.atan2(dy, dx), radius, radius * 0.8);
    const e2 = ellipseEdgeSqrd(Math.atan2(-dy, -dx), size * 0.5, size * 0.5 * 0.8);
    if (distSq >= e1 + e2) continue;
    targets.push({ building: b, factor: 1 });
  }
  return targets;
}

// One particle's worth of splash: Damage()'s multipliers, verbatim - walls
// take 6%, towers 90%, type 6 ignores falloff and scales with its level,
// type 114 shrugs it off entirely. Health snapshots lazily so End Attack
// can undo everything.
function bombApplyDamage(view, bombFx) {
  const sim = view.attackSim;
  const renderer = view.renderer;
  if (!sim || !renderer) return;
  for (const { building: b, factor } of bombFx.targets) {
    if (b.state === "destroyed") continue;
    let dmg = b.t !== 6 ? Math.trunc(factor * bombFx.dpp) : bombFx.dpp;
    if (b.t === 6) dmg *= Math.max(1, b.l);
    const cls = String(view.simContext?.gameData?.get?.(b.t)?.type || "");
    if (cls === "wall") dmg *= 0.06;
    if (cls === "tower") dmg *= 0.9;
    if (b.t === 114) dmg = 0;
    dmg = Math.floor(dmg);
    if (dmg <= 0) continue;
    if (!sim.origHealth.has(b.id)) {
      sim.origHealth.set(b.id, { hp: b.hp, state: b.state });
    }
    const hp = Math.max(0, (b.hp ?? b.maxHp) - dmg);
    b.hp = hp;
    // BFOUNDATION's own thresholds, same as setBuildings applies them.
    b.state = hp <= 0 ? "destroyed" : (hp < b.maxHp * 0.5 ? "damaged" : "");
  }
  // Bomb rubble opens routes too.
  renderer.buildBlockGrid?.();
  renderer.invalidate();
}

// CATAPULTPOPUP.BombDrop + ResourceBomb constructor.
function fireBomb(backdrop, view, worldPoint) {
  const sim = view?.attackSim;
  const renderer = view?.renderer;
  const bomb = SIM_BOMBS.find((entry) => entry.id === sim?.bombArmed);
  if (!sim || !renderer || !bomb) return false;

  const sheets = bombSheets();
  const kind = bomb.resource === 1 ? "twigs" : bomb.resource === 2 ? "pebble" : "putty";
  // Putty is the odd one out (ResourceBomb's else-branch): it sweeps
  // MONSTERS, not buildings - every creep within radius * 0.5 of the drop,
  // measured as a plain circle in cartesian space - and its landings enrage
  // rather than damage.
  const fx = {
    bomb,
    kind,
    center: worldPoint,
    dpp: bomb.damage / bomb.particles,
    targets: bomb.resource === 3 ? []
      : bombTargets(renderer, view.simContext?.gameData, worldPoint, bomb.radius),
    monsterTargets: bomb.resource === 3
      ? puttyTargets(renderer, worldPoint, bomb.radius) : [],
    particles: [],
  };
  const now = performance.now();
  for (let i = 0; i < bomb.particles; i++) {
    const angle = Math.random() * Math.PI * 2;
    const spread = Math.random() * bomb.radius * 0.5;
    const land = {
      x: worldPoint.x + Math.sin(angle) * spread,
      y: worldPoint.y + Math.cos(angle) * spread * 0.5,
    };
    const delay = kind === "putty" ? 1 : 1 + Math.random() * (bomb.dropTarget * 2);
    fx.particles.push({
      land,
      start: { x: land.x + 100, y: land.y - BOMB_SPAWN_HEIGHT },
      startAt: now + delay * 1000,
      duration: (0.3 + Math.random() * 0.5) * 1000,
      variation: Math.floor(Math.random() * sheets[kind].variations),
      landed: false,
    });
  }
  sim.activeBombs.push(fx);

  // The game's BombDrop spends the whole resource family after one throw on
  // a main yard - deliberately NOT ported. The sim charges nothing and saves
  // nothing, so every bomb stays live for as many firings as the attacker
  // feels like: re-arm from the panel and rain it down again.

  // fired(): the armed state clears and the label goes back to "Catapult".
  sim.bombArmed = null;
  if (view.renderer?.canvas) view.renderer.canvas.style.cursor = "grab";
  if (sim.catapultLabel) {
    sim.catapultLabel.textContent = "Catapult";
    sim.catapultLabel.classList.remove("armed");
  }
  startBombLoop(view);
  return true;
}

// ── The Flinger: ATTACK.Spawn, ported (no pathing yet) ───────────────────
// With monsters in the bucket the yard shows the GROUND drop zone
// (BucketUpdate: radius = bucketUsed / 8, floored at 200), and a click
// flings the whole load: every bucketed monster spawns around the landing
// point - angle random, distance rand * (size/2)/2, full circle exactly as
// Spawn() rolls it - then the bucket empties and the zone goes away.
// Spawned monsters have no pathing or combat yet: they join the renderer's
// entity list and wander aimlessly around where they landed, the same
// stepPens walk the pen monsters use. End Attack sweeps them all away.
const FLING_WANDER = 240; // cart px: the aimless-roam box around the landing

function flingZoneSize(sim) {
  const used = simBucketUsed(sim);
  if (used <= 0) return 0;
  return Math.max(200, used / 8);
}

function spawnFlungMonsters(backdrop, view, point) {
  const sim = view?.attackSim;
  const renderer = view?.renderer;
  const ctx = view?.simContext;
  if (!sim || !renderer || !ctx) return false;
  const zoneSize = flingZoneSize(sim);
  if (zoneSize <= 0) return false;
  const spawnRadius = zoneSize / 2; // DROPZONE.Drop passes _size / 2

  const landing = () => {
    // Spawn(): angle rand*360deg, dist rand*(param2/2), FULL circle - the
    // fling scatter is round, unlike the squashed bomb scatter.
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * spawnRadius / 2;
    return { x: point.x + Math.sin(angle) * dist, y: point.y + Math.cos(angle) * dist };
  };

  let flungCount = 0;
  const stamp = Date.now();
  for (const [key, count] of Object.entries(sim.bucket)) {
    const loaded = Number(count) || 0;
    if (loaded <= 0) continue;
    const [baseId, levelTag] = key.split(":");
    const level = Math.max(1, Number(String(levelTag || "").replace(/^L/, "")) || 1);
    const loadout = sim.loadout?.[baseId] || null;
    for (let i = 0; i < loaded; i++) {
      const at = landing();
      let spec = null;
      if (baseId[0] === "G") {
        const t = Number(baseId.slice(1));
        const sheetLevel = Math.min(level, championMaxLevel(t));
        const sheet = guardianSheet(t, sheetLevel);
        const info = guardianInfo(t);
        if (!sheet || !info) continue;
        const speedTable = info?.props?.speed || [1];
        spec = {
          kind: "guardian",
          sheet,
          sheets: guardianSheetCandidates(t, sheetLevel),
          dirs: 16,
          speed: speedTable[Math.min(level, speedTable.length) - 1] || 1,
          rowFn: (moving, tick) => guardianRow(t, sheetLevel, moving, tick),
        };
      } else {
        const sheet = CREEP_SPRITES[baseId];
        const stats = monsterStat(baseId);
        if (!sheet || !stats) continue;
        spec = {
          kind: "creep",
          sheet,
          dirs: 30,
          speed: statAtLevel(stats.props?.speed, level) || 1,
        };
      }
      // Health for the towers to chew on: creatures from their per-level
      // stat (single-entry tables like Bolt's are level-independent),
      // champions from the guardian health arrays.
      const maxHp = baseId[0] === "G"
        ? (guardianInfo(Number(baseId.slice(1)))?.props?.health?.[
            Math.min(level, championMaxLevel(Number(baseId.slice(1)))) - 1] || 1000)
        : (statAtLevel(monsterStat(baseId)?.props?.health, level) || 100);
      const aStats = monsterStat(baseId);
      renderer.penEntities.push({
        ...spec,
        id: `flung-${stamp}-${key}-${i}`,
        flung: true,
        // Fight-back kit, per-level from the SAME stat tables the towers
        // read: swing damage, ranged reach (Teratorn/Rezghul/Sabnox...),
        // Eye-ra's explode and Balthazar's targetGroup-6 triple.
        attackDamage: baseId[0] === "G"
          ? (guardianInfo(Number(baseId.slice(1)))?.props?.damage?.[
              Math.min(level, championMaxLevel(Number(baseId.slice(1)))) - 1] || 500)
          : (statAtLevel(aStats?.props?.damage, level) || 50),
        atkRange: statAtLevel(aStats?.props?.range, level) || 0,
        attackDelayTicks: statAtLevel(aStats?.props?.attackDelay, level) || 80,
        explodes: statAtLevel(aStats?.props?.explode, level) === 1,
        targetGroup: statAtLevel(aStats?.props?.targetGroup, level) || 1,
        tripleVsMonsters: statAtLevel(aStats?.props?.targetGroup, level) === 6,
        baseId,
        level,
        abilityLevel: loadout?.ability ?? null,
        feedLevel: loadout?.feed ?? null,
        // Lab powerups that live in the spawn stats: DAVERockets grants
        // range 100 + 40/level (unpowered D.A.V.E. has range 1: melee);
        // Whirlwind divides Bandito's attack delay by 1 + 0.5/level.
        ...(baseId === "C12" && (loadout?.ability || 0) > 0
          ? { atkRange: 100 + 40 * (loadout.ability || 0) } : {}),
        ...(baseId === "C7" && (loadout?.ability || 0) > 0
          ? { attackDelayTicks: Math.max(8, Math.round(
              (statAtLevel(aStats?.props?.attackDelay, level) || 80)
              / (1 + 0.5 * (loadout.ability || 0)))) } : {}),
        hp: maxHp,
        maxHp,
        baseSpeed: spec.speed,
        home: at,
        penSize: FLING_WANDER,
        penOffset: -FLING_WANDER / 2, // wander box centred on the landing
        x: at.x,
        y: at.y,
        target: renderer.pointInPen(at, FLING_WANDER, -FLING_WANDER / 2),
        rotation: Math.random() * 360,
        frame: 0,
        moving: true,
      });
      flungCount++;
    }
  }
  if (!flungCount) return false;

  // Spawn()'s epilogue: the bucket empties, the log gets its "Flung in"
  // line, and the drop zone leaves with the load.
  sim.bucket = Object.create(null);
  const hud = backdrop.querySelector(".base-view-hud");
  if (hud) {
    for (const row of hud.querySelectorAll(".atk-row")) {
      const countEl = row.querySelector(".atk-row-count");
      if (countEl) countEl.innerHTML = `<b>0 / &infin;</b>`;
    }
    simRefreshBar(sim, hud);
  }
  showYardMessage(backdrop,
    flungCount === 1 ? "Flung in 1 monster!" : `Flung in ${flungCount} monsters!`);
  renderer.hasAnimations = true;
  renderer.invalidate();
  startEffectsLoop(view);
  return true;
}

// ── Monster effects: putty enrage + champion auras ───────────────────────
// Enrage(speedMult, armorMult), as the live client wires it: move speed
// multiplied, attack delay divided, armor modified, and a magenta
// GlowFilter (0xFF33FF, alpha 0.6) on the sprite while it lasts. In the
// sim - no combat yet - the tangible half is the movement speed, painted
// with the same magenta glow; the armor/damage multipliers ride along on
// the entity for when fighting arrives.
//
//   Putty (ResourceBomb putty branch): each landing gives every swept
//   monster Enrage(bomb.speed, bomb.damageMult) for bomb.speedlength
//   seconds, guarded so an already-raged monster is not re-stacked - a
//   Small jar is 1.2x speed for 10s at 0.8 armor, the Giant 2x for 40s at
//   a tenth.
//
//   Fomor (AOEEnrage(250, 1 + buff*2, buff)): a rolling aura - friendly
//   monsters within 250 of Fomor hold Enrage(1 + 2*buff, buff) while they
//   stay in range, buff by level (0.1 .. 0.6). The game refreshes the
//   sweep every 30 ticks; the sim uses the same half-second cadence.
//
//   Krallen (ProximityLootBuff): monsters within buffRadius (250 .. 350 by
//   level) carry LootingMultiplier(1 + buff) (1.2x .. 1.3x) with its own
//   GlowFilter(0x55FF21, ...) - the bright green glow. Looting itself does
//   not exist here yet, so the multiplier sits on the entity while the
//   green glow marks carriers, exactly as in game.
const AURA_CHECK_MS = 375;      // AOEEnrage's 30-tick cadence at 80 ticks/s
const FOMOR_AURA_RADIUS = 250;  // AOEEnrage's hardcoded first argument
// CHAMPIONCAGE buff-feed ("bonusFeeds") stat tables, indexed foodBonus-1
// (tiers 1..3, GetGuardianProperty clamps past the end). Krallen gains
// nothing from buff feeding - his power comes from the KOTH powerLevel.
const CHAMPION_FEED_BONUS = {
  G1: { hp: [12500, 27500, 50000], dmg: [150, 330, 600],
    spd: [0.1, 0.2, 0.4], rng: [0, 0, 0], buff: [0, 0, 0] },
  G2: { hp: [2500, 5500, 10000], dmg: [400, 880, 1600],
    spd: [0.1, 0.2, 0.4], rng: [0, 0, 0], buff: [0, 0, 0] },
  G3: { hp: [1000, 2200, 4000], dmg: [3, 6, 10],
    spd: [0.1, 0.2, 0.4], rng: [3, 6, 10], buff: [0.03, 0.06, 0.15] },
  G4: { hp: [1000, 2200, 4000], dmg: [300, 600, 1000],
    spd: [0.1, 0.2, 0.4], rng: [0, 0, 0], buff: [0, 0, 0] },
  G5: { hp: [0, 0, 0], dmg: [0, 0, 0],
    spd: [0, 0, 0], rng: [0, 0, 0], buff: [0, 0, 0] },
};
function championFeedBonus(baseId, foodBonus) {
  const t = CHAMPION_FEED_BONUS[baseId];
  const fb = Math.max(0, Math.min(3, Number(foodBonus) || 0));
  if (!t || fb < 1) return null;
  const i = fb - 1;
  return { hp: t.hp[i], dmg: t.dmg[i], spd: t.spd[i],
    rng: t.rng[i], buff: t.buff[i] };
}

function guardianBuffAt(t, level) {
  const buffs = guardianInfo(t)?.props?.buffs;
  if (!Array.isArray(buffs) || !buffs.length) return 0;
  return Number(buffs[Math.min(level, buffs.length) - 1]) || 0;
}

function krallenBuffRadiusAt(level) {
  const radii = guardianInfo(5)?.props?.buffRadius;
  if (!Array.isArray(radii) || !radii.length) return 250;
  return Number(radii[Math.min(level, radii.length) - 1]) || 250;
}

// ResourceBomb's putty sweep: FromISO both points, plain circle of
// radius * 0.5. Only flung monsters count - the pen dwellers are scenery,
// not CREEPS._creeps.
function puttyTargets(renderer, center, radius) {
  const c = YardRenderer.fromIso(center.x, center.y);
  const reach = radius * 0.5;
  const out = [];
  for (const ent of renderer?.penEntities || []) {
    if (!ent.flung) continue;
    const p = YardRenderer.fromIso(ent.x, ent.y);
    const dx = c.x - p.x;
    const dy = c.y - p.y;
    if (dx * dx + dy * dy < reach * reach) out.push(ent);
  }
  return out;
}

// ResourceBomb.Damage's putty branch: TemporaryComponent(Enrage(...)) with
// the k_PUTTY_BOMB_ENRAGE guard - one rage at a time per monster.
function bombApplyEnrage(view, bombFx) {
  const bomb = bombFx.bomb;
  const now = performance.now();
  let touched = false;
  for (const ent of bombFx.monsterTargets) {
    if (!ent || ent.dead) continue;
    if (ent.puttyEnrage && now < ent.puttyEnrage.until) continue;
    // The table's damageMult IS the effective multiplier (1 - m): the SWF
    // stores m = 0.2/0.4/0.7/0.9 and modifyHealth scales by (1 - armor).
    ent.puttyEnrage = {
      speedMult: Number(bomb.speed) || 1,
      dmgMult: Number(bomb.damageMult) || 1,
      until: now + (Number(bomb.speedlength) || 0) * 1000,
    };
    touched = true;
  }
  if (touched) {
    startEffectsLoop(view);
    view.renderer?.invalidate();
  }
}

// ── Defensive towers: BTOWER, cosmetically ported ────────────────────────
// Live towers return fire at the flung horde. Stats come straight from the
// props table's per-level `stats` rows (range/damage/rate/speed/splash),
// the same GLOBAL._buildingProps[type].stats[lvl-1] BTOWER.Props() reads.
// Rate is in ticks of the game's 80/s logic loop (rate 40 = a shot every
// 1.0s at the base rate*2 cadence);
// range and splash are map-pixel distances measured in cartesian space.
// attackgroup gates targets: 1 ground only (cannons), 2 air only (flak),
// 3 or absent both (sniper, railgun, laser, tesla). Monster bunkers
// (types 22/128) hold defenders rather than shooting, so they sit this
// out. A tower the catapult has knocked out (or left destroyed) stays
// silent; a damaged one keeps firing, as in game.
//
// Fliers: the viewer's stat table carries no movement field, so the
// flying set is named in FLYING_MONSTERS/entIsFlying - Teratorn (C14),
// Zafreeti (C15), Vorg (C16), and Fomor (G3) at evolution stage 3.
//
// Deliberately NOT combat-complete: monsters do not shoot back or take
// buildings apart yet. Putty/Fomor armor IS folded into damage taken now,
// with the client's real formula: modifyHealth scales every hit by
// (1 - armor), armor composing as 1 - PRODUCT(1 - m) across enrages. Projectile and beam art here is descriptive
// (family-coloured shots and beams), not the game's effect sprites.
// The game's combat logic does NOT run at the render frame rate: GLOBAL's
// main loop banks fixed-timestep iterations at 2 per 25ms - EIGHTY logic
// ticks per second - and each iteration runs CREEPS.Tick, every
// BTOWER.TickAttack, the traps and the bunkers. Independent confirmation:
// the classic wiki lists the sniper's DPS as exactly half its DPShot,
// which its rate of 80 only produces at 160 ticks = 2.0s, i.e. 12.5ms a
// tick. So: cannon volleys every 1.0s, sniper every 2.0s, railgun every
// 4.0s, tesla's 72-tick cycle in 0.9s, and projectiles at speed * 0.5 *
// 80 px/s (a sniper round covers 400px/s).
const TOWER_TICK_MS = 1000 / 80;
// ...but the fireStage machines (tesla, and the railgun's fade) do NOT
// live in that loop: BFOUNDATION.TickFast is an ENTER_FRAME listener, so
// it runs at the STAGE frame rate - and the SWF header says frameRate=40,
// not the GLOBAL.k_STAGE_FPS=24 constant (which nothing timing-critical
// actually consumes). The tesla's charge is therefore 32 frames = 0.8s,
// with bolts every 4th frame = 100ms apart.
const STAGE_TICK_MS = 1000 / 40;
const TOWER_BUNKERS = new Set([22, 128]);   // monster bunkers do not shoot
// RebalancedCreatures: C14 Teratorn, C15 Zafreeti and C16 Vorg carry
// "movement":"fly". Champions come from CHAMPIONCAGE's movement arrays:
// G3 Fomor is ["ground","ground","fly"] - it only takes wing at evolution
// stage 3; every other champion stays grounded at all stages.
const FLYING_MONSTERS = new Set(["C14", "C15", "C16"]);
// "movement":"burrow" in RebalancedCreatures/CREATURELOCKER: C13 Wormzer,
// IC4 Valgos and IC8 King Wormzer. Burrow movement means BOTH things the
// game derives from it: direct pathing (tunnel under walls and buildings
// instead of walking around them - findTarget's burrow branch waypoints
// straight to a random footprint side, no A*) and renderBurrow's
// underground travel (hidden and untargetable while moving).
const BURROWERS = new Set(["C13", "IC4", "IC8"]);
const DIRECT_PATHERS = BURROWERS;
// CREATURELOCKER antiHeal: the healers themselves can never be healed.
const ANTI_HEAL = new Set(["C15", "C16"]);

// Korath's Fists of Doom quake: LinearAEDamage over range x 2.5 with a
// full-damage core at range x 1.5, striking enemy GROUND monsters - the
// k_TARGETS_INVISIBLE flag means even a cloaked Brain is caught - and,
// when Korath is ATTACKING (not _friendly), the yard's buildings too.
function korathQuake(view, sim, d, dmg, now) {
  const inner = (Number(d.atkRange) || 35) * 1.5;
  const outer = (Number(d.atkRange) || 35) * 2.5;
  const kp = YardRenderer.fromIso(d.x, d.y);
  for (const m4 of view.renderer.penEntities || []) {
    if (m4.dead || (!m4.flung && !m4.defender)) continue;
    if (Boolean(m4.flung) === Boolean(d.flung)) continue;   // enemies only
    if (entIsFlying(m4)) continue;   // ground flag; invisibility ignored
    const mp4 = YardRenderer.fromIso(m4.x, m4.y);
    const d4 = Math.hypot(kp.x - mp4.x, kp.y - mp4.y);
    if (d4 >= outer) continue;
    const f4 = d4 <= inner ? 1 : (outer - d4) / (outer - inner);
    if (m4.defender) hurtDefender(view, sim, m4, dmg * f4, now);
    else dealDamage(view, sim, m4, dmg * f4, now);
  }
  if (d.flung) {
    for (const b4 of view.renderer.buildings || []) {
      if (b4.state === "destroyed") continue;
      const ty4 = String(view.simContext?.gameData?.get?.(b4.t)?.type || "");
      if (["decoration", "enemy", "trap", "immovable",
        "placeholder"].includes(ty4)) continue;
      const bp4 = YardRenderer.fromIso(b4.x, b4.y);
      const d4 = Math.hypot(kp.x - bp4.x, kp.y - bp4.y);
      if (d4 >= outer) continue;
      const f4 = d4 <= inner ? 1 : (outer - d4) / (outer - inner);
      damageBuilding(view, sim, b4, dmg * f4, now, d);
    }
  }
  // G4QuakeGraphic: three concentric hairline ellipses (0xF28800, alpha
  // 0.5) under an orange glow, tweened from radius 20 out to range*2.5
  // over 1s while fading - drawn in the overlay, no bitmap involved.
  sim.shots.push({ kind: "korath-ring", at: { x: kp.x, y: kp.y },
    outer, bornAt: now, done: true, hitAt: now, until: now + 1000 });
  view.renderer.hasAnimations = true;
}

// Monster-lab powerups, straight from each creep class's poweredUp()
// branch. The flinger dropdown's ability tier is the powerUpLevel().
function pw(ent) {
  // Attackers carry the flinger dropdown's tier; defenders carry the
  // yard owner's researched powerup from the save's academy field.
  return ent ? Math.max(0, Number(ent.abilityLevel) || 0) : 0;
}

// AOEDamage.dealAOEDamage -> Targeting.DealLinearAEDamage: full damage at
// radiusInner, linear falloff to radiusOuter, optionally capped to the N
// closest targets, buildings and/or enemy ground monsters.
function labSplash(view, sim, src, primary, dmg, now, opts) {
  const at = YardRenderer.fromIso(src.x, src.y);
  const hits = [];
  if (opts.buildings) {
    for (const b of view.renderer.buildings || []) {
      if (b === primary || b.state === "destroyed") continue;
      const ty = String(view.simContext?.gameData?.get?.(b.t)?.type || "");
      if (["decoration", "enemy", "trap", "immovable", "placeholder"].includes(ty)) continue;
      const bp = YardRenderer.fromIso(b.x, b.y);
      const d = Math.hypot(at.x - bp.x, at.y - bp.y);
      if (d < opts.outer) hits.push({ kind: "b", ref: b, d });
    }
  }
  if (opts.monsters) {
    for (const m of view.renderer.penEntities || []) {
      if (m === src || m === primary || m.dead) continue;
      if (!m.flung && !m.defender) continue;   // combatants only, no pen decor
      if (Boolean(m.flung) === Boolean(src.flung)) continue;   // enemies only
      if (entIsFlying(m) || (Number(m.altitude) || 0) > 0.5) continue;
      const mp2 = YardRenderer.fromIso(m.x, m.y);
      const d = Math.hypot(at.x - mp2.x, at.y - mp2.y);
      if (d < opts.outer) hits.push({ kind: "m", ref: m, d });
    }
  }
  if (opts.includeInitial && primary) {
    hits.push({ kind: primary.t !== undefined ? "b" : "m", ref: primary, d: 0 });
  }
  hits.sort((a2, b2) => a2.d - b2.d);
  const cap = opts.maxTargets || Infinity;
  for (const h of hits.slice(0, cap)) {
    const inner = opts.inner || 0;
    const f = h.d <= inner ? 1 : Math.max(0, (opts.outer - h.d) / (opts.outer - inner));
    const amt = dmg * f;
    if (amt <= 0) continue;
    if (h.kind === "b") {
      damageBuilding(view, sim, h.ref, amt, now,
        src && src.flung && !src.dead ? src : null);
    }
    else if (h.ref.defender) hurtDefender(view, sim, h.ref, amt, now);
    else dealDamage(view, sim, h.ref, amt, now);
  }
}
function entIsFlying(ent) {
  if (FLYING_MONSTERS.has(ent.baseId)) return true;
  return ent.baseId === "G3" && (ent.level || 1) >= 3;
}
// BTOWER._targetFlyerMode, verbatim - the authoritative per-tower gate
// (0 ground only, 1 both, 2 air only). Note it disagrees with the props
// attackgroup in places: the laser (23) and railgun (118) are GROUND-only.
// The table has NO entry for the spurtz cannons (136/137), and FindTargets
// treats a missing key as 0 - so spurtz fire never touches a flyer.
const TOWER_FLYER_MODE = { 20: 0, 21: 1, 23: 0, 25: 1, 115: 2, 118: 0,
  129: 0, 130: 0, 132: 1 };
// Behavior per subclass, from the client (BUILDING20/21/23/25/115/118,
// INFERNOQUAKETOWER, INFERNO_MAGMA_TOWER, SpurtzCannon):
//   20 cannon     - shell, splash 30 (the "hits a cluster" tower)
//   21 sniper     - single bullet, no splash, long range, slow
//   23 laser      - instant beam + splash 40 around the target
//   25 tesla      - burst of single-target bolts, then recharges
//   115 flak      - missile BURST every 4th tick, rotating across its
//                   locked targets (shotsFired % targets)
//   118 railgun   - full-screen LINE: every monster intersecting the ray
//                   takes full damage; 320-tick recharge
//   129 quake     - winds up on the LOGIC clock (a frame every 6 ticks,
//                   the last 4 frames every tick), slams at the END of
//                   the strip: everything in range takes damage/range *
//                   (range - dist), floored at damage/3, capped at the
//                   target's health - and, uniquely, NO health scaling
//                   (DelayedFire hard-codes its multiplier to 1)
//   132 magma     - homing FIREBALL; locked target takes FULL damage,
//                   bystanders damage * 0.75 * falloff with no floor and
//                   no armor mult; the splash plane follows the victim
//                   (a flying target means air-only splash). The
//                   FlameEffect burn is DEAD CODE in this client build:
//                   onProjectileCollision exists but no addEventListener
//                   ever wires it to FIREBALL.COLLIDED, so no burn lands
//   136/137 spurtz- barrel sweeps 1 deg/tick; fires only within 20 deg of
//                   the target (2 deg switches to the next of <=10 locks),
//                   a shot every 5th tick AT A POINT along the barrel at
//                   the target's distance +- 20% scatter; the AoE radius
//                   is the randomly-scaled projectile art (w+h), and a
//                   50% roll drops a defending Spurtz (IC1) at the impact
// In INFERNO yards, ids 20 and 21 resolve to the Blast Tower and the
// Sharpshooter via that yard's own props table - cannon and sniper clones
// per the wiki, so the same styles serve both worlds. The Stronghold
// (138) is deliberately absent: it is a Map Room 3 defence and this is an
// MR2 viewer, so one appearing in a save simply stays silent.
const TOWER_STYLE = {
  20: "shot", 21: "shot", 23: "beam-red", 25: "beam-tesla",
  115: "flak", 118: "rail", 129: "quake", 130: "shot",
  132: "magma", 136: "spurtz", 137: "spurtz",
};
// BUILDING115 gates its salvo on _frameNumber % 4 - and, unlike the
// tesla's, ITS _frameNumber increments inside TickAttack, the 80/s LOGIC
// loop. Missiles leave 4 logic ticks = 50ms apart; a 16-missile salvo
// empties in 0.8s.
const FLAK_BURST_EVERY = 4;   // logic ticks, not stage frames
// BUILDING115._targetArray = [4,4,6,8,10,12,14,16], live client verbatim:
// missiles per salvo by level.
const FLAK_SALVO = [4, 4, 6, 8, 10, 12, 14, 16];
// Champion cage: ChampionBase sweeps getCreepsInRange(800, ...) for its
// defence aggro - a flat 800, straight from source (the wiki's "30 blocks
// growing to 40" was close but the code says 800 outright).
const CAGE_TRIGGER = 800;
// BUILDING22's anti-air roster, release priority order: D.A.V.E., Eye-ra,
// Balthazar, Sabnox - the only housed types a flyer sighting sends out.
const AA_DEFENDERS = new Set(["C12", "C5", "IC5", "IC7"]);
// CreepBase.findDefenseTargets: a deployed defender ACQUIRES targets only
// within a flat 200px of itself (chasing a live victim has no leash).
const DEFENDER_AGGRO = 200;
// Quake wind-up, INFERNOQUAKETOWER.TickAttack: while _shouldAnimate, the
// strip advances one frame per 6 LOGIC ticks - except the final 4 frames,
// which advance every tick (the slam visibly accelerates) - and
// DelayedFire (the damage) only runs when the strip ENDS. For the
// 33-frame strip: (33-4)*6 + 4 = 178 ticks = 2.225s of wind-up. There is
// no separate reload constant: _fireTick was reset to rate*2 at Fire and
// only resumes counting after the animation, so the cycle is wind-up +
// rate*2 ticks.
const QUAKE_FRAMES = 33;
const QUAKE_WINDUP_TICKS = (QUAKE_FRAMES - 4) * 6 + 4;
// EFFECTS.Laser -> LASER: lives 100 logic ticks (power ramps a tenth per
// tick, fading past tick 80) and pulses LASER.Splash every 8TH tick -
// ~12 pulses, each dealing damage * 0.5 * (splash - dist)/splash at the
// WHIP POINT, with NO damage/5 floor and NO _damageMult. (BUILDING23's
// "damage * 25" only appears in the jar/vacuum branches.) Every 16th tick
// it drops an EFFECTS.Burn scorch at the whip point.
const LASER_BEAM_MS = 1250;  // LASER lives 100 ticks (80/s), fading after 80
const LASER_PULSE_TICKS = 8;
const LASER_SCORCH_TICKS = 16;
// SpurtzCannon, live source: barrel turns _barrelRotationSpeed = 1 deg per
// logic tick; shooting starts within 20 deg (or once already firing) and
// the lock hops to the next target within 2 deg; shots gate on
// _fireTick % 5 == 0; scatter is +-(dist * 0.2); the impact AoE radius is
// graphic.width + graphic.height after a random 0.4..1.0 scale (the art
// is 45x40, so 34..85px); a Math.random() > 0.5 roll spawns a defending
// Spurtz (IC1) that killSpurts() culls after ~100 frames.
const SPURTZ_EVERY = 5;       // SpurtzCannon: _fireTick % 5 == 0
const SPURTZ_MAX_TARGETS = 10;
const SPURTZ_TURN_DEG_PER_TICK = 1;
const SPURTZ_START_DEG = 20;   // _ANGLE_THRESHOLD_TO_START_SHOOTING
const SPURTZ_SWITCH_DEG = 2;   // _ANGLE_THRESHOLD_TO_SWITCH_TARGETS
const SPURTZ_SPREAD = 0.2;
const SPURTZ_AOE_BASE = 45 + 40;   // spurtz_projectile.png w + h
const SPURTZ_SPAWN_CHANCE = 0.5;
const SPURTZ_LIFE_TICKS = 100;
// BUILDING118.Fire: the ray is 50 segments of 32px = exactly 1600px, the
// candidate sweep is getCreepsInRange(1600, ...), and lineIntersectCircle
// runs in RAW STAGE (iso/world) coordinates with its default radius of 20
// for every creep, big or small.
const RAIL_RAY_LEN = 1600;
const RAIL_HIT_RADIUS = 20;

function towerStats(gameData, b) {
  const props = gameData?.get?.(b.t);
  if (!props || props.type !== "tower" || TOWER_BUNKERS.has(b.t)) return null;
  if (b.t === 138) return null; // Stronghold: MR3-only, outside this sim's scope
  const stats = Array.isArray(props.stats)
    ? props.stats[Math.max(0, Math.min(props.stats.length - 1, (b.l || 1) - 1))]
    : null;
  if (!stats) return null;
  return { ...stats, attackgroup: props.attackgroup };
}

// Where each tower's fire leaves from, per the subclass Spawn calls:
// the laser ignites at (_mc.x, _mc.y + 35) - its dish sits low - and the
// tesla arcs from (_mc.x, _mc.y - 50), the top of the coil. Everything
// else fires from (_mc.x, _mc.y + _top), the barrel height; the sim
// derives that from the tower's own art - the upper third of its turret
// (anim) frame, or of the top art when no turret sheet ships.
function towerMuzzle(view, b) {
  // Laser: Fire passes (x, y + 35) but LASER.Tick lifts the drawn beam
  // base by its _height of 60 - the visible origin is ~25px above the
  // building origin, off the top of the dish.
  if (b.t === 23) return { x: b.x, y: b.y - 25 };
  if (b.t === 25) return { x: b.x, y: b.y - 50 };
  // Railgun: _top = +15 - the rails sit LOW, the shot leaves 15px below
  // the building origin, not from a turret head.
  if (b.t === 118) return { x: b.x, y: b.y + 15 };
  const images = view.simContext?.gameData?.imagesForLevel?.(b.t, b.l || 1);
  const entry = images?.entry;
  const spec = entry?.anim || entry?.top;
  if (Array.isArray(spec) && Array.isArray(spec[1])) {
    const [, rect] = spec;
    const ry = Number(rect[1]) || 0;
    const fh = Number(rect[3]) || Number(rect[1]) * -1 || 40;
    return { x: b.x, y: b.y + ry + Math.abs(fh) * 0.3 };
  }
  return { x: b.x, y: b.y - 24 };
}

function towerCanTarget(towerType, ent) {
  // FindTargets: `if(_targetFlyerMode[_type]) mode = ...` - a missing (or
  // zero) entry means GROUND ONLY. The old `?? 1` default here let spurtz
  // cannons shoot down Teratorns, which the game never allows.
  const mode = TOWER_FLYER_MODE[towerType] ?? 0;
  const flying = entIsFlying(ent);
  if (mode === 0) return !flying;
  if (mode === 2) return flying;
  return true;
}

// TickAttack's FindTargets reset: 30 ticks flat, PLUS creepCount / 15
// extra ticks once more than 150 monsters crowd the yard (the client's
// pathing-load throttle).
function findTargetsDelayMs(renderer) {
  const n = (renderer.penEntities || []).filter((e) => e.flung && !e.dead && !e.invisible).length;
  return (30 + (n > 150 ? n / 15 : 0)) * TOWER_TICK_MS;
}

// SpurtzCannon's continuous machine - the one tower that does NOT fit the
// lock-and-volley template. Its barrel turns 1 degree per logic tick; it
// only opens fire once within 20 degrees of the current target (or if the
// burst already started), hops to the next of its <=10 locked targets when
// within 2 degrees, and fires every 5th tick AT A POINT along the barrel
// at the target's distance, scattered by +-20% of that distance. Bursts of
// stats.shots reset on the rate*2 Fire cadence.
function spurtzTick(view, sim, b, state, stats, now) {
  const renderer = view.renderer;
  const last = state.spLast ?? now;
  state.spLast = now;
  const dtTicks = Math.min(16, Math.max(0, (now - last) / TOWER_TICK_MS));
  const size = Number(view.simContext?.gameData?.get?.(b.t)?.size)
    || renderer.gameData.footprint(b.t);
  const from = YardRenderer.fromIso(b.x, b.y + size * 0.5);
  const inRange = (ent) => {
    const p = YardRenderer.fromIso(ent.x, ent.y);
    return Math.hypot(from.x - p.x, from.y - p.y) <= stats.range;
  };
  const legal = () => (renderer.penEntities || []).filter((ent) =>
    ent.flung && !ent.dead && !ent.invisible && !ent.burrowed && !ent.retreating
    && towerCanTarget(b.t, ent) && inRange(ent))
    .map((ent) => {
      const p = YardRenderer.fromIso(ent.x, ent.y);
      return { ent, dist: Math.hypot(from.x - p.x, from.y - p.y) };
    })
    .sort((a2, b2) => a2.dist - b2.dist)
    .slice(0, SPURTZ_MAX_TARGETS)
    .map((x) => x.ent);
  // Fire() cadence: a fresh burst (and a fresh FindTargets(10)) every
  // rate*2 logic ticks.
  if (now >= (state.spNextBurst ?? 0)) {
    state.spNextBurst = now + (Number(stats.rate) || 30) * 2 * TOWER_TICK_MS;
    state.spLocks = legal();
    state.spShots = 0;
    state.spIdx = 0;
    state.spFirePot = 0;
  }
  // Drop dead/absconded locks; hasValidTarget() bails when the head dies.
  state.spLocks = (state.spLocks || []).filter((ent) =>
    !ent.dead && renderer.penEntities.includes(ent) && inRange(ent));
  if (!state.spLocks.length) { b.simRot = state.spRot ?? null; return; }
  if (state.spIdx >= state.spLocks.length) state.spIdx = 0;
  const target = state.spLocks[state.spIdx];
  // setAngleToTarget: atan2(y + |_top| - t.y, x - t.x) - the angle from
  // TARGET to TOWER; the muzzle direction is that + 180.
  const angleTo = Math.atan2((b.y + 32) - target.y, b.x - target.x)
    * 180 / Math.PI;
  let rot = state.spRot ?? angleTo;
  let diff = angleTo - rot;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  const turn = Math.min(Math.abs(diff), SPURTZ_TURN_DEG_PER_TICK * dtTicks);
  rot += Math.sign(diff) * turn;
  if (rot > 180) rot = -(180 - rot);
  else if (rot < -180) rot = 180 - (180 - rot);
  state.spRot = rot;
  b.simRot = rot;   // renderRotation: _animTick = int((rot + 180) / 11.25)
  let aligned = Math.abs(angleTo - rot);
  if (aligned > 180) aligned = 360 - aligned;
  // updateTarget: within 2 degrees and holding more than one lock, hop on.
  if (aligned <= SPURTZ_SWITCH_DEG && state.spLocks.length > 1) {
    state.spIdx = (state.spIdx + 1) % state.spLocks.length;
  }
  const shotsPerFire = Math.max(1, Number(stats.shots) || 10);
  state.spFirePot = (state.spFirePot || 0) + dtTicks;
  const healthScale = 0.5 + 0.5 * Math.max(0, Math.min(1,
    (b.hp ?? b.maxHp) / (b.maxHp || 1)));
  while (state.spFirePot >= SPURTZ_EVERY) {
    state.spFirePot -= SPURTZ_EVERY;
    if (state.spShots >= shotsPerFire) continue;
    if (!(aligned <= SPURTZ_START_DEG || state.spShots > 0)) continue;
    state.spShots++;
    // shoot(): a point along the barrel at the target's distance, plus
    // getSpreadFromDistance(dist * 0.2) on each axis; the projectile is
    // FIREBALLS.Spawn2(..., null, ...) - it flies to the POINT, not the
    // monster, and its impact AoE radius is the randomly-scaled art.
    const dist = Math.hypot(b.x - target.x, b.y - target.y);
    const rad = (rot + 180) * Math.PI / 180;
    const spread = (r) => Math.random() * (r * 2) - r;
    const dest = {
      x: b.x + Math.cos(rad) * dist + spread(dist * SPURTZ_SPREAD),
      y: b.y + Math.sin(rad) * dist + spread(dist * SPURTZ_SPREAD),
    };
    const scale = 0.4 + Math.random() * 0.6;   // scaleDisplayObjectRandomly
    const muzzle = { x: b.x, y: b.y - 32 };    // _top = -32
    sim.shots.push({ kind: "shot", spurtz: true, from: muzzle,
      dest, target: null, bornAt: now, hitAt: Infinity,
      tmp: { ...muzzle }, aim: null, aimAge: Infinity,
      speed: Math.max(1, Number(stats.speed) || 5),
      damage: stats.damage * healthScale,
      splash: SPURTZ_AOE_BASE * scale, spScale: scale, towerType: b.t });
  }
}

// One tower's tick, following TickAttack: a tower LOCKS its target and
// keeps firing it until it dies or leaves range - it does not hop to
// whoever is momentarily nearest. On a volley the cooldown is _rate * 2
// ticks (a cannon's rate 40 = a shell every 1.0s at 80 ticks/s); losing
// the target costs the FindTargets delay (30 ticks + a crowd surcharge)
// before the next lock, picking the nearest legal monster (priority 1
// sorts by distance).
function towerFire(view, sim, b, now) {
  const renderer = view.renderer;
  const stats = towerStats(view.simContext?.gameData, b);
  if (!stats || b.state === "destroyed" || (b.hp ?? 1) <= 0) return;
  const state = sim.towers.get(b.id) || { nextFire: 0, target: null };
  sim.towers.set(b.id, state);
  // The spurtz cannon never enters the lock-and-volley template: its
  // barrel and burst run continuously on their own machine.
  if ((TOWER_STYLE[b.t] || "shot") === "spurtz") {
    spurtzTick(view, sim, b, state, stats, now);
    return;
  }
  if (now < state.nextFire) return;
  const size = Number(view.simContext?.gameData?.get?.(b.t)?.size)
    || renderer.gameData.footprint(b.t);
  const from = YardRenderer.fromIso(b.x, b.y + size * 0.5);

  const inRange = (ent) => {
    const p = YardRenderer.fromIso(ent.x, ent.y);
    const dx = from.x - p.x;
    const dy = from.y - p.y;
    return Math.sqrt(dx * dx + dy * dy) <= stats.range;
  };
  // Locked target still valid? (health > 0 / present / in range)
  if (state.target && (state.target.dead || state.target.burrowed
    || !renderer.penEntities.includes(state.target) || !inRange(state.target))) {
    state.target = null;
    b.simAim = null;   // barrel rests until the next lock
    state.nextFire = now + findTargetsDelayMs(renderer);  // FindTargets delay
    return;
  }
  if (!state.target) {
    let best = null;
    let bestDist = Infinity;
    for (const ent of renderer.penEntities || []) {
      if (!ent.flung || ent.dead) continue;
      if (!towerCanTarget(b.t, ent)) continue;
      if (ent.invisible || ent.burrowed || ent.retreating) continue;
      const p = YardRenderer.fromIso(ent.x, ent.y);
      const dx = from.x - p.x;
      const dy = from.y - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= stats.range && dist < bestDist) { best = ent; bestDist = dist; }
    }
    if (!best) return;
    state.target = best;
  }

  state.nextFire = now + (Number(stats.rate) || 30) * 2 * TOWER_TICK_MS;
  const style = TOWER_STYLE[b.t] || "shot";
  const muzzle = towerMuzzle(view, b);
  // Every subclass Fire() scales by 0.5 + 0.5 * health/maxHealth: a beaten
  // tower hits for as little as half - EXCEPT the quake, whose DelayedFire
  // hard-codes the multiplier to 1. (The 1.25x overdrive buff is not
  // simulated - there is no shiny here to buy it with.)
  const healthScale = style === "quake" ? 1
    : 0.5 + 0.5 * Math.max(0, Math.min(1,
      (b.hp ?? b.maxHp) / (b.maxHp || 1)));
  const scaledDamage = stats.damage * healthScale;
  // BTOWER.Rotate: the barrel swings to face the locked target - the sim
  // aim overrides the viewer's cursor-following while the battle runs.
  // That orientation IS the firing animation for the turret family whose
  // classes actually call Rotate (sniper 21, inferno cannon 130, magma
  // 132) or roll their own (flak 115, railgun 118, laser 23 via Track).
  // BUILDING20 - the main-yard Cannon Tower - calls none of them: its
  // turret NEVER tracks, so it gets no sim aim either.
  if (b.t !== 20) b.simAim = { x: state.target.x, y: state.target.y };
  const legal = (renderer.penEntities || []).filter((ent) =>
    ent.flung && !ent.dead && !ent.invisible && !ent.burrowed && !ent.retreating
    && towerCanTarget(b.t, ent) && inRange(ent));
  // PROJECTILE.Move(), verbatim: the round advances _maxSpeed * 0.5 per
  // tick, re-aims at the (moving) target every 5th frame, and impacts as
  // soon as the remaining distance drops inside one _maxSpeed. No flight
  // time is precomputed - the effects loop integrates it.
  const shotAt = (target, delayMs, extra = {}) => {
    sim.shots.push({ kind: "shot", from: muzzle, target,
      bornAt: now + delayMs, hitAt: Infinity,
      tmp: { ...muzzle }, aim: null, aimAge: Infinity,
      speed: Math.max(1, Number(stats.speed) || 5),
      damage: scaledDamage, splash: stats.splash,
      towerType: b.t, ...extra });
  };
  if (style === "shot") {
    // PROJECTILE-backed rounds (cannon 20/130, sniper 21): PROJECTILE.Tick
    // REMOVES the round the instant its target dies - it never detonates.
    shotAt(state.target, 0, { vanish: true });
  } else if (style === "magma") {
    // FIREBALL-backed: homes on the creep every tick (targetType 1) and,
    // because the dead-creep check is only `!this._targetCreep`, it flies
    // on to the corpse and still detonates there. NO burn: the client
    // never wires onProjectileCollision, so FlameEffect is dead code.
    shotAt(state.target, 0,
      { magma: true, airSplash: entIsFlying(state.target) });
  } else if (style === "beam-red") {
    // LASER.Tick's sweeping whip: pointB orbits the origin, the angle
    // starting 150/sqrt(dist) degrees short and advancing (4/sqrt(dist))/2
    // per tick with a breathing radius, whipping across the victim. The
    // beam is autonomous once fired: it holds NO reference to the monster
    // and lives its full 100 ticks even if the target dies. Damage pulses
    // from LASER.Splash every 8th tick at the whip point (handled in the
    // stepping loop). The whip lives entirely in world (draw) space:
    // orbit centre is the muzzle, the starting angle points at the
    // target; the damage check converts to cartesian like
    // getCreepsInRange does.
    const dist0 = Math.max(20, Math.hypot(state.target.x - muzzle.x,
      state.target.y - muzzle.y));
    const baseAng = Math.atan2(state.target.y - muzzle.y,
      state.target.x - muzzle.x) * 180 / Math.PI;
    sim.shots.push({ kind: style, from: muzzle,
      bornAt: now, hitAt: Infinity, until: now + LASER_BEAM_MS,
      nextTick: now, nextScorch: now, damage: scaledDamage,
      splash: stats.splash, towerType: b.t,
      sweep: { dist: dist0, angle0: baseAng - 150 / Math.sqrt(dist0) } });
  } else if (style === "beam-tesla") {
    // BUILDING25.TickFast, the COMPLETE stage machine on the 40fps stage
    // clock: fireStage 1 = 32 frames of CHARGE (0.8s); fireStage 2 = a
    // bolt every 4th frame (100ms) until _shotsFired reaches _rate, the
    // strip LOOPING frames 32..40 while it fires; fireStage 3 = WIND-DOWN,
    // advancing every 2ND frame through 41..55 (28 stage frames, 0.7s)
    // with no bolts. TickAttack's _fireTick keeps counting DURING the
    // cycle, so the next charge starts at the first rate*2 boundary after
    // the wind-down - the cooldown runs concurrently, not stacked on top.
    const bolts = Math.max(1, Number(stats.rate) || 8);
    const stageFrames = 32 + bolts * 4 + 28;   // charge + firing + wind-down
    const stageMs = stageFrames * STAGE_TICK_MS;
    const cdMs = (Number(stats.rate) || 8) * 2 * TOWER_TICK_MS;
    state.nextFire = now + Math.ceil(stageMs / cdMs) * cdMs;
    b.simAnim = { startedAt: now, durationMs: stageMs, phases: [
      { ms: 32 * STAGE_TICK_MS, f0: 0, f1: 31 },
      { ms: bolts * 4 * STAGE_TICK_MS, f0: 32, f1: 40, loopMs: STAGE_TICK_MS },
      { ms: 28 * STAGE_TICK_MS, f0: 41, f1: 54 },
    ] };
    // A shared burst handle: if a bolt discharges into an empty yard the
    // burst is cancelled - the real tower plays lightningend and drops to
    // wind-down instead of dry-firing the rest.
    const burst = { cancelled: false, newTarget: null };
    for (let i = 0; i < bolts; i++) {
      const at = now + (32 + i * 4) * STAGE_TICK_MS;
      sim.shots.push({ kind: style, from: muzzle, target: state.target,
        bornAt: at, hitAt: at, damage: scaledDamage, splash: 0,
        towerType: b.t, burst, range: stats.range, towerAt: from });
    }
  } else if (style === "flak") {
    // BUILDING115: burst size from _targetArray[lvl-1]; FindTargets locks
    // that many nearest monsters and _shotsFired % _targetCreeps.length
    // rotates the missiles across the LOCKED list. _frameNumber counts in
    // TickAttack (80/s), so missiles leave 4 LOGIC ticks = 50ms apart.
    const burst = FLAK_SALVO[Math.max(0, Math.min(FLAK_SALVO.length - 1, (b.l || 1) - 1))];
    const locks = legal
      .map((ent) => {
        const p = YardRenderer.fromIso(ent.x, ent.y);
        return { ent, dist: Math.hypot(from.x - p.x, from.y - p.y) };
      })
      .sort((a2, b2) => a2.dist - b2.dist)
      .slice(0, burst)
      .map((x) => x.ent);
    for (let i = 0; i < burst; i++) {
      shotAt(locks[i % Math.max(1, locks.length)] || state.target,
        i * FLAK_BURST_EVERY * TOWER_TICK_MS, { vanish: true });
    }
  } else if (style === "rail") {
    // BUILDING118.Fire, in RAW STAGE coordinates: a unit segment of 32px
    // toward the target, drawn 50 times = a 1600px ray, tested with
    // lineIntersectCircle radius 20 against every creep found within
    // getCreepsInRange(1600, muzzle).
    const len = Math.max(1, Math.hypot(state.target.x - muzzle.x,
      state.target.y - muzzle.y));
    const seg = { x: (state.target.x - muzzle.x) / len,
      y: (state.target.y - muzzle.y) / len };
    sim.shots.push({ kind: "rail", from: muzzle, target: state.target,
      rayFromW: { x: muzzle.x, y: muzzle.y },
      rayEndW: { x: muzzle.x + seg.x * RAIL_RAY_LEN,
        y: muzzle.y + seg.y * RAIL_RAY_LEN },
      towerAt: from, bornAt: now, hitAt: now,
      damage: scaledDamage, splash: 0, towerType: b.t });
  } else if (style === "quake") {
    // Charge-then-slam, all on the 80/s LOGIC clock: the strip advances a
    // frame every 6 ticks, its final 4 frames every tick, and the slam
    // lands only when the strip ENDS - 178 ticks = 2.225s for the
    // 33-frame strip. No separate reload: _fireTick (reset to rate*2 at
    // Fire) resumes counting after the animation.
    const windupMs = QUAKE_WINDUP_TICKS * TOWER_TICK_MS;
    state.nextFire = now + windupMs
      + (Number(stats.rate) || 15) * 2 * TOWER_TICK_MS;
    sim.shots.push({ kind: "quake", from: { x: b.x, y: b.y + size * 0.5 },
      bornAt: now, hitAt: now + windupMs,
      damage: scaledDamage, range: stats.range, towerType: b.t });
    b.simAnim = { startedAt: now, durationMs: windupMs, phases: [
      { ms: (QUAKE_FRAMES - 4) * 6 * TOWER_TICK_MS, f0: 0, f1: QUAKE_FRAMES - 5 },
      { ms: 4 * TOWER_TICK_MS, f0: QUAKE_FRAMES - 4, f1: QUAKE_FRAMES - 1 },
    ] };
  }
}

// Armor, decoded from source: Enrage(speed, m) adds ArmorPropertyModifier(m)
// to armorProperty, which composes as armor = 1 - PRODUCT(1 - m_i), and
// MonsterBase.modifyHealth then scales EVERY incoming hit by (1 - armor)
// = PRODUCT(1 - m_i). (The _damageMult field the towers multiply by is a
// plain `= 1` that nothing in this build ever writes - a no-op.) So:
// - armor applies to ALL damage paths, splash and direct alike;
// - putty (guarded by k_PUTTY_BOMB_ENRAGE) and the Fomor aura (its own
//   component name) COEXIST and their reductions multiply.
// puttyEnrage/auraEnrage store the EFFECTIVE multiplier (1 - m) directly:
// putty 0.8/0.6/0.3/0.1 by jar size, Fomor 1 - buff = 0.9 down to 0.4.
function entArmor(ent) {
  let mult = 1;
  if (ent.puttyEnrage) mult *= Number(ent.puttyEnrage.dmgMult) || 1;
  if (ent.auraEnrage) mult *= Number(ent.auraEnrage.dmgMult) || 1;
  return mult;
}

// The floating damage readout, verbatim from ATTACK.damage(): a rolling
// 400ms window keeps a per-monster counter - the first hit's number sits
// centred on the monster (minus altitude for flyers), the second shifts
// RIGHT by 10px per digit, the third LEFT by the same, and anything past
// three is simply not shown. ParticleText additionally caps the whole
// yard at 20 live numbers. Each ParticleDamageItem rises 25px over 0.5s
// on a Cubic.easeInOut tween and is removed - no fade, no stacking.
const POPUP_WINDOW_MS = 400;   // m_lastAttackTime reset
const POPUP_LIFE_MS = 500;     // TweenLite.to(_mc, 0.5, ...)
const POPUP_RISE_PX = 25;      // "y": param1.y - 25
const POPUP_MAX_LIVE = 20;     // ParticleText._currentMax
function pushPopup(sim, ent, amount, now, opts = {}) {
  if (now - (sim.popupWindowAt || 0) > POPUP_WINDOW_MS) {
    sim.popupWindowAt = now;
    sim.popupSlots = new Map();
  }
  if (!sim.popupSlots) sim.popupSlots = new Map();
  const key = ent.id ?? ent;
  const slot = sim.popupSlots.get(key) || 0;
  sim.popupSlots.set(key, slot + 1);
  if (slot > 2) return;
  const live = (sim.popups || [])
    .filter((p) => now - p.bornAt < POPUP_LIFE_MS).length;
  if (live >= POPUP_MAX_LIVE) return;
  const amt = Math.round(amount);
  let x = ent.x;
  const digits = String(amt).length;
  if (slot === 1) x += 10 * digits;
  else if (slot === 2) x -= 10 * digits;
  sim.popups.push({
    at: { x, y: ent.y - (Number(ent.altitude) || 0) },
    amount: amt, bornAt: now, heal: Boolean(opts.heal),
    // Loot popups carry a resource colour and an explicit sign; damage
    // popups may carry the armor-absorbed remainder, which the game
    // appends as "(-N)" after the landed number.
    color: opts.color || null, sign: opts.sign || null,
    absorbed: Math.round(Number(opts.absorbed) || 0) || 0,
  });
}

// ATTACK.Loot's popup colours by resource slot (inferno slots are +4).
const LOOT_COLORS = { 1: "#723228", 2: "#999999", 3: "#FF00FF",
  4: "#00FF00", 5: "#3F3B36", 6: "#F0E6C5", 7: "#EEED71", 8: "#D95300" };
function lootPopup(view, sim, b, amount, slot, now, stackY = -35) {
  if (!(amount >= 1)) return;
  const shown = view.simContext?.isInferno ? slot + 4 : slot;
  pushPopup(sim, { id: "loot" + b.id + ":" + slot + ":" + Math.floor(now),
    x: b.x, y: b.y + stackY },
  Math.floor(amount), now,
  { color: LOOT_COLORS[shown] || "#FFFF00", sign: "+" });
}

// One hit's worth of looting, per BFOUNDATION.modifyHealth ->
// ILootable.Loot: the request is damage x the attacker's Krallen
// lootingMultiplier. Harvesters (BRESOURCE) pay from uncollected
// production - the viewer's base load doesn't carry that figure, so the
// yard pool of their own resource stands in - at full value; storages,
// the Town Hall and the inferno core (BSTORAGE) pick a RANDOM non-empty
// pool and the attacker banks x0.5 on a Map Room 2 outpost, x0.9
// anywhere else. (No level<20 bonus: the viewer doesn't know the
// attacker's player level, so it assumes 20+.)
const STORAGE_TYPES = new Set([6, 14, 112]);
function lootFromBuilding(view, sim, b, request, now) {
  if (!(request > 0)) return;
  const ctx = view.simContext;
  const props = ctx?.gameData?.get?.(b.t) || {};
  const ty = String(props.type || "");
  const pool = sim.lootPool;
  const rKey = HARVESTER_RESOURCE[b.t];
  if (ty === "resource" && rKey) {
    const take = Math.min(Math.ceil(request), pool[rKey] || 0);
    if (take <= 0) { b.looted = true; return; }
    pool[rKey] -= take;
    if (pool[rKey] <= 0) b.looted = true;   // tg3 stops caring about it
    lootPopup(view, sim, b, take, Number(rKey[1]), now);
    return;
  }
  if (ty === "storage" || ty === "townhall" || STORAGE_TYPES.has(b.t)) {
    const candidates = [1, 2, 3, 4].filter((i) => (pool["r" + i] || 0) > 0);
    if (!candidates.length) return;
    const slot = candidates[Math.floor(Math.random() * candidates.length)];
    const key = "r" + slot;
    const take = Math.min(Math.ceil(request), pool[key]);
    pool[key] -= take;
    const isMr2Outpost = !ctx?.isMain && !ctx?.isInferno;
    const gain = Math.floor(take * (isMr2Outpost ? 0.5 : 0.9));
    lootPopup(view, sim, b, gain, slot, now);
  }
}

// BSTORAGE.Destroyed: cracking a store dumps a fraction of EVERY pool -
// 4% base (silos capped at 4,000,000 per resource), 10% for the Town
// Hall, 5% for the inferno outpost core - one stacked popup per
// resource at y + 20 - slot*10.
function lootDestructionDump(view, sim, b, now) {
  const pool = sim.lootPool;
  const pct = b.t === 14 ? 0.10 : b.t === 112 ? 0.05 : 0.04;
  for (let slot = 1; slot <= 4; slot++) {
    let amt = Math.floor((pool["r" + slot] || 0) * pct);
    if (b.t === 6) amt = Math.min(amt, 4000000);
    if (amt < 1) continue;
    pool["r" + slot] -= amt;
    lootPopup(view, sim, b, amt, slot, now, 20 - slot * 10);
  }
}

// Buildings take hits exactly as the catapult path does - same origHealth
// snapshot for End Attack restore, same BFOUNDATION thresholds (damaged
// below half, destroyed at zero) - plus what monster combat needs on top:
// a damage popup on the structure, a path-grid rebuild the moment a state
// flips (rubble is passable), silent towers via the existing state gate,
// and BUILDING22.Destroyed's ledger: an undeployed bunker load dies with
// the bunker, only the monsters already outside fight on.
function damageBuilding(view, sim, b, raw, now, attacker = null) {
  const dmg = Math.floor(Number(raw) || 0);
  if (dmg <= 0 || b.state === "destroyed") return 0;
  if (!sim.origHealth.has(b.id)) {
    sim.origHealth.set(b.id, { hp: b.hp, state: b.state });
  }
  // BFOUNDATION.modifyHealth loots BEFORE the health change, only for
  // monster-attributed hits (Boolean(param2)), scaled by the attacker's
  // Krallen lootingMultiplier.
  if (attacker) {
    lootFromBuilding(view, sim, b,
      dmg * (Number(attacker.lootMult) || 1), now);
  }
  const maxHp = b.maxHp || 1000;
  if (b.hp == null || !Number.isFinite(b.hp)) b.hp = maxHp;
  b.hp = Math.max(0, b.hp - dmg);
  pushPopup(sim, { id: "b" + b.id, x: b.x, y: b.y - 10 }, dmg, now);
  const prev = b.state;
  b.state = b.hp <= 0 ? "destroyed" : (b.hp < maxHp * 0.5 ? "damaged" : "");
  if (b.state === "destroyed" && prev !== "destroyed") {
    const props = view.simContext?.gameData?.get?.(b.t) || {};
    if (String(props.type) === "storage" || String(props.type) === "townhall"
      || STORAGE_TYPES.has(b.t)) {
      lootDestructionDump(view, sim, b, now);
    }
  }
  if (b.state !== prev) {
    view.renderer.buildBlockGrid?.();
    if (b.state === "destroyed") {
      const st = sim.bunkers?.get(b.id);
      if (st) {
        for (const id of Object.keys(st.housed)) {
          st.housed[id] = Math.min(st.housed[id], st.dispatched[id] || 0);
        }
        st.targets = [];
        st.flyers = [];
      }
    }
  }
  view.renderer.invalidate();
  return dmg;
}

// MonsterBase.findTarget's building preferences, by targetGroup:
// 2 -> walls, 3 -> unlooted resource buildings, 4 -> towers (and stocked
// bunkers), anything else -> the nearest of everything attackable. The
// pick is the closest with an occasional second-closest, which is what
// spreads a horde across a wall line instead of stacking on one block.
function pickBuildingTarget(view, sim, ent) {
  const tg = Number(ent.targetGroup) || 1;
  const propsOf = (b) => view.simContext?.gameData?.get?.(b.t) || {};
  const attackable = (b) => {
    if (b.state === "destroyed") return false;
    const ty = String(propsOf(b).type || "");
    return !["decoration", "immovable", "placeholder", "mushroom",
      "taunt", "enemy", "trap"].includes(ty);
  };
  const everything = (view.renderer.buildings || []).filter(attackable);
  // _buildingsMain excludes walls: only Eye-ra's group (2) seeks them
  // out; everyone else touches a wall only when the route says to chew.
  const all = everything.filter((b) => String(propsOf(b).type) !== "wall");
  let pool = all;
  if (tg === 2) pool = everything.filter((b) => String(propsOf(b).type) === "wall");
  else if (tg === 3) {
    // findTarget group 3: unlooted resource buildings only - a drained
    // harvester stops drawing Bolt's crew.
    pool = all.filter((b) => String(propsOf(b).type) === "resource" && !b.looted);
  }
  else if (tg === 4) {
    pool = all.filter((b) => {
      if (String(propsOf(b).type) !== "tower") return false;
      if (b.t === 22 || b.t === 128) {
        const st = sim.bunkers?.get(b.id);
        return !st || Object.values(st.housed).some((n) => n > 0) || st.out > 0;
      }
      return true;
    });
  }
  if (!pool.length) {
    // findTarget's fallback scan of _buildingsMain - and the monster's
    // targetGroup PERMANENTLY becomes 1 afterwards (except group 4).
    pool = all;
    if (tg !== 4 && tg !== 1) ent.targetGroup = 1;
  }
  if (!pool.length) {
    // Nothing left to attack and nothing to fight: changeModeRetreat -
    // the monster walks off the yard.
    ent.retreating = true;
    return null;
  }
  const at = YardRenderer.fromIso(ent.x, ent.y);
  const ranked = pool.map((b) => {
    const c = YardRenderer.fromIso(b.x, b.y);
    // findTarget ranks by distance to centre minus _middle (the true
    // cart half-footprint), so big buildings pull in from farther out.
    const half = YardRenderer.pathFootprint(b.t) / 2;
    return { b, dist: Math.hypot(at.x - c.x, at.y - c.y) - half };
  }).sort((x, y) => x.dist - y.dist);
  // findTarget issues WaypointTo for the closest AND the second-closest
  // back to back; whichever path resolves last wins the queue race, so
  // the pick genuinely splits between the two - which is what fans a
  // horde across a wall line.
  // findTarget WaypointTo's BOTH the closest and the second-closest;
  // setWaypoints then adopts the later-arriving path only if it has
  // FEWER waypoints than the one already held - and refuses to switch
  // onto a wall unless the target group is 2. So the pick is a
  // deterministic "go for the gap", not a coin toss. Flyers never path,
  // so they simply take the closest.
  if (ranked.length < 2 || entIsFlying(ent)) return ranked[0].b;
  const c1 = ranked[0].b;
  const c2 = ranked[1].b;
  const r1 = view.renderer.findPath(ent, { x: c1.x, y: c1.y });
  const r2 = view.renderer.findPath(ent, { x: c2.x, y: c2.y });
  const n1 = r1?.waypoints?.length ?? Infinity;
  const n2 = r2?.waypoints?.length ?? Infinity;
  if (n2 < n1 && (String(propsOf(c2).type) !== "wall" || tg === 2)) return c2;
  return c1;
}

// Defenders and champions are damageable too: same modifyHealth shape
// (they carry no putty/aura enrages in the sim, so no armor factor), same
// popup, and a death that settles the books - a killed bunker defender is
// PERMANENTLY removed from the bunker's stock (CreepBase death handler:
// _monsters[id]-- AND _monstersDispatched[id]--), never re-housed.
function hurtDefender(view, sim, d, raw, now) {
  const dealt = Number(raw) || 0;
  if (dealt <= 0 || d.dead) return;
  d.hp = Math.max(0, (d.hp ?? d.maxHp ?? 1) - dealt);
  pushPopup(sim, d, dealt, now);
  if (d.hp <= 0) killDefender(view, sim, d, now);
}
function killDefender(view, sim, d, now) {
  if (d.dead) return;
  d.dead = true;
  sim.deaths.push({ at: { x: d.x, y: d.y }, bornAt: now });
  onMonsterDeath(view, sim, d, now);
  if (d.homeBunkerId != null) {
    const st = sim.bunkers?.get(d.homeBunkerId);
    if (st) {
      st.housed[d.baseId] = Math.max(0, (st.housed[d.baseId] || 0) - 1);
      st.dispatched[d.baseId] = Math.max(0, (st.dispatched[d.baseId] || 0) - 1);
      st.out = Math.max(0, st.out - 1);
    }
  }
  view.renderer.penEntities =
    view.renderer.penEntities.filter((e) => e !== d);
}

// CreepBase.explode(), both directions. The bomber deals FULL damage to
// its locked target (within DEFENSE_RANGE 30), a 90px linear-falloff
// splash to the OPPOSING side's other ground fighters... with one
// faithful quirk kept: the creep loop in the source only sweeps
// defend/bunker-behaviour creeps, so a DEFENDING Eye-ra friendly-fires
// its fellow defenders. A scorch is left behind and the bomber dies.
function creepExplode(view, sim, src, prey, now, targetBuilding = null) {
  const at = YardRenderer.fromIso(src.x, src.y);
  // Airburst: CreepBase.explode() scales EVERYTHING by 1.1 + 0.1 x
  // powerUpLevel - damage, the 60px building ring, the 90px creep ring -
  // and Eye-ra leaps 40 + 20 x (level - 1) before bursting. A FLYING
  // victim takes only the 0.01 x airburst fraction ("partial damage to
  // air units").
  const lvl15 = 1.1 + 0.1 * pw(src);
  const dmg = (Number(src.explodeDamage ?? src.meleeDamage ?? src.attackDamage) || 0) * lvl15;
  const rB2 = (60 * lvl15) ** 2;
  const rC2 = (90 * lvl15) ** 2;
  if (pw(src) > 0) src.altitude = 40 + 20 * Math.max(0, pw(src) - 1);
  if (prey && !prey.dead) {
    const pp = YardRenderer.fromIso(prey.x, prey.y);
    const dd2 = (at.x - pp.x) ** 2 + (at.y - pp.y) ** 2;
    const airFactor = (entIsFlying(prey) || (Number(prey.altitude) || 0) > 0.5)
      ? 0.01 : 1;
    if (dd2 < rC2) {
      if (prey.defender) hurtDefender(view, sim, prey, dmg * airFactor, now);
      else dealDamage(view, sim, prey, dmg * airFactor, now);
    }
  }
  for (const other of view.renderer.penEntities || []) {
    if (other === src || other === prey || other.dead) continue;
    if (!other.defender) continue;   // the source's defend/bunker sweep
    if (entIsFlying(other) || other.altitude > 0.5) continue;
    const op = YardRenderer.fromIso(other.x, other.y);
    const dd2 = (at.x - op.x) ** 2 + (at.y - op.y) ** 2;
    const r2 = other.baseId[0] === "G" ? rB2 : rC2;  // guardian 60px ring, creeps 90px
    if (dd2 < r2) {
      hurtDefender(view, sim, other, dmg * ((r2 - dd2) / r2), now);
    }
  }
  // The building loop runs ONLY for an ATTACKING bomber - the source
  // gates it on k_sBHVR_ATTACK, so a defending Eye-ra never cracks the
  // owner's own walls. Everything within the ring takes linear falloff.
  if (src.flung) {
    // The locked target takes FULL damage (the source's direct
    // modifyHealth), and the ring loop skips it.
    if (targetBuilding && targetBuilding.state !== "destroyed") {
      damageBuilding(view, sim, targetBuilding, dmg, now, src);
    }
    for (const b of view.renderer.buildings || []) {
      if (b === targetBuilding || b.state === "destroyed") continue;
      const bp = YardRenderer.fromIso(b.x, b.y);
      const bd2 = (at.x - bp.x) ** 2 + (at.y - bp.y) ** 2;
      if (bd2 < rB2) {
        damageBuilding(view, sim, b, dmg * ((rB2 - bd2) / rB2), now, src);
      }
    }
  }
  if (view.renderer.effects && view.renderer.effects.length < 200) {
    view.renderer.effects.push({ kind: "scorch", x: src.x, y: src.y,
      scale: 1.1, bornAt: now });
  }
  // setHealth(0): the bomber dies in its own blast.
  if (src.defender) killDefender(view, sim, src, now);
  else if (!src.dead) {
    src.dead = true;
    sim.deaths.push({ at: { x: src.x, y: src.y }, bornAt: now });
    onMonsterDeath(view, sim, src, now);   // corpse for Rezghul et al.
    view.renderer.penEntities =
      view.renderer.penEntities.filter((e) => e !== src);
  }
  view.renderer.hasAnimations = true;
}

// Every point where a monster takes a hit funnels through here, exactly as
// every game path funnels through modifyHealth: armor scales the raw
// amount, the popup stacks, the death ring fires once.
// CreepBase's heal behaviour with the LIVE (CREATURELOCKER) profiles:
// both healers stand off at range 150 (break-off hysteresis x1.25),
// Zafreeti pulsing every 20 ticks for 400-1000, Vorg every 10 ticks for
// 60-110. Patients: nearest damaged friendly within 600 - champions
// included, antiHeal (C15/C16) excluded - kept until dead or read full
// (the full check only runs every 100 ticks), idle rescan every 120.
// With everyone healthy they shadow the nearest healable friendly; with
// no attackable building left they retreat off the map.
function healerTick(view, sim, ent, flung, now) {
  const gd = view.simContext?.gameData;
  const anyBuilding = (view.renderer.buildings || []).some((b) =>
    b.state !== "destroyed"
    && !["decoration", "immovable", "placeholder", "mushroom",
      "taunt", "enemy", "trap"].includes(String(gd?.get?.(b.t)?.type || "")));
  if (!anyBuilding) ent.retreating = true;
  if (ent.retreating) {
    ent.patient = null;
    ent.moving = true;
    ent.target = { x: ent.x, y: -60 };
    if (ent.y < -30) {
      ent.dead = true;   // flew off; no corpse, no death ring
      view.renderer.penEntities =
        view.renderer.penEntities.filter((e) => e !== ent);
    }
    return;
  }
  const side = Boolean(ent.flung);
  const antiHeal = (m) => m.baseId === "C15" || m.baseId === "C16";
  const healable = (m) => !m.dead && m !== ent && !antiHeal(m)
    && Boolean(m.flung) === side;
  let pat = ent.patient;
  if (pat && (pat.dead || !view.renderer.penEntities.includes(pat)
    || Boolean(pat.flung) !== side)) pat = null;
  if (pat && (pat.hp ?? 0) >= (pat.maxHp ?? 1)
    && now >= (ent.nextFullCheck || 0)) {
    ent.nextFullCheck = now + 100 * TOWER_TICK_MS;
    pat = null;
  }
  if (!pat && now >= (ent.nextHealScan || 0)) {
    ent.nextHealScan = now + 120 * TOWER_TICK_MS;
    const hp0 = YardRenderer.fromIso(ent.x, ent.y);
    let follow = null;
    let followDist = Infinity;
    let bestDist = Infinity;
    for (const m of view.renderer.penEntities || []) {
      if (!healable(m) || (!m.flung && !m.defender)) continue;
      const mp = YardRenderer.fromIso(m.x, m.y);
      const d = Math.hypot(hp0.x - mp.x, hp0.y - mp.y);
      if (d > 600) continue;
      if (d < followDist) { follow = m; followDist = d; }
      if ((m.hp ?? 0) < (m.maxHp ?? 1) && d < bestDist) {
        pat = m; bestDist = d;
      }
    }
    ent.followTarget = follow;
  }
  ent.patient = pat;
  const goal = pat || ((f) => (f && !f.dead
    && view.renderer.penEntities.includes(f)) ? f : null)(ent.followTarget);
  if (!goal) { ent.moving = false; return; }
  const a = YardRenderer.fromIso(ent.x, ent.y);
  const g = YardRenderer.fromIso(goal.x, goal.y);
  const dist = Math.hypot(a.x - g.x, a.y - g.y);
  const inReach = dist <= (ent.healing ? 150 * 1.25 : 150);
  ent.healing = Boolean(pat) && inReach;
  if (inReach) {
    ent.moving = false;
  } else {
    ent.moving = true;
    ent.target = { x: goal.x, y: goal.y };
  }
  if (ent.healing && now >= (ent.nextHealAt || 0)) {
    const cadence = ent.baseId === "C16" ? 10 : 20;
    ent.nextHealAt = now + cadence * TOWER_TICK_MS;
    const amount = Math.abs(Number(ent.healerDamage))
      || (ent.baseId === "C16" ? 60 : 400);
    // fireCreepBall's negative payload IS the game's flow: FIREBALL
    // negates on collision (modifyHealth(-damage)), speed 25, green +N.
    fireCreepBall(view, sim, ent, pat, -amount, now);
    ent.attackingUntil = now + 200;
  }
}

function dealDamage(view, sim, ent, raw, now) {
  const dealt = (Number(raw) || 0) * entArmor(ent);
  if (dealt <= 0) return 0;
  ent.hp = Math.max(0, (ent.hp ?? ent.maxHp ?? 1) - dealt);
  // modifyHealth reports the armor-absorbed remainder, and the popup
  // appends it as "(-N)" after the landed number.
  pushPopup(sim, ent, dealt, now,
    { absorbed: (Number(raw) || 0) - dealt });
  if (ent.hp <= 0 && !ent.dead) {
    ent.dead = true;
    sim.deaths.push({ at: { x: ent.x, y: ent.y }, bornAt: now });
    onMonsterDeath(view, sim, ent, now);
  }
  return dealt;
}

// Shared death hook, both sides: leaves a corpse Rezghul can raise (radius
// 300, ground friendlies only, 15s shelf life) and runs Slimeattikus's
// split - props.splits minis (2..5 by level) burst out where it fell,
// fighting for the same side it did.
function onMonsterDeath(view, sim, ent, now) {
  // (No acid puddle: AcidOnDeath belongs to ProjectXv2 and
  // k_USE_REBALANCED_MONSTERS is false - the LIVE ProjectX only has the
  // AOEDamageOnDeath splash, which Acid Spores already models. The
  // sim.acids plumbing stays, idle, in case a build enables it.)
  // A champion at 0 HP is INJURED, not dead - tickBDefend logs the
  // injury and changeModeRetreat()s. It leaves no corpse and can never
  // be raised (RezghulResurrectAttack respawns CreepBase only).
  if (ent.baseId[0] === "G") return;
  if (!sim.corpses) sim.corpses = [];
  const flyer = entIsFlying(ent);
  if (!flyer && !ent.zombie) {
    sim.corpses.push({ baseId: ent.baseId, level: ent.level || 1,
      abilityLevel: Math.max(0, Number(ent.abilityLevel) || 0),
      x: ent.x, y: ent.y, flung: Boolean(ent.flung), at: now });
    if (sim.corpses.length > 40) sim.corpses.shift();
  }
  if (ent.baseId === "C11" && pw(ent) > 0) {
    // Acid Spores: on death, damage x (1 + 0.5 x level) splashes 60px
    // over enemy ground monsters and - for an ATTACKING Project X only
    // (the friendly strip) - the yard's buildings, linear falloff.
    labSplash(view, sim, ent, null,
      (Number(ent.attackDamage) || 50) * (1 + 0.5 * pw(ent)), now,
      { outer: 60, buildings: Boolean(ent.flung), monsters: true });
    if (view.renderer.effects && view.renderer.effects.length < 200) {
      view.renderer.effects.push({ kind: "scorch", x: ent.x, y: ent.y,
        scale: 0.9, bornAt: now });
    }
  }
  if (ent.baseId === "C17") {
    const stats = monsterStat("C17");
    const minis = statAtLevel(stats?.props?.splits, ent.level) || 2;
    for (let i = 0; i < minis; i++) {
      spawnSideCreep(view, sim, "C18", ent.level, {
        x: ent.x + (Math.random() - 0.5) * 26,
        y: ent.y + (Math.random() - 0.5) * 26,
      }, Boolean(ent.flung), now);
    }
  }
}

// Spawn a creep mid-battle on either side: Slimeattikus minis and
// Rezghul's zombies come through here with full per-level combat kit.
function spawnSideCreep(view, sim, baseId, level, at, flung, now, mods = {}) {
  const sheet = CREEP_SPRITES[baseId];
  const stats = monsterStat(baseId);
  if (!sheet || !stats) return null;
  const hp = Math.round((statAtLevel(stats.props?.health, level) || 100)
    * (mods.healthMult || 1));
  const spd = (statAtLevel(stats.props?.speed, level) || 1) * (mods.speedMult || 1);
  const ent = {
    kind: "creep", sheet, dirs: 30,
    speed: spd, baseSpeed: spd,
    id: `${flung ? "flung" : "defender"}-split-${Math.random().toString(36).slice(2)}`,
    baseId, level, hp, maxHp: hp,
    attackDamage: Math.round((statAtLevel(stats.props?.damage, level) || 50)
      * (mods.damageMult || 1)),
    meleeDamage: Math.round((statAtLevel(stats.props?.damage, level) || 50)
      * (mods.damageMult || 1)),
    atkRange: statAtLevel(stats.props?.range, level) || 0,
    attackDelayTicks: statAtLevel(stats.props?.attackDelay, level) || 80,
    explodes: statAtLevel(stats.props?.explode, level) === 1,
    targetGroup: statAtLevel(stats.props?.targetGroup, level) || 1,
    tripleVsMonsters: statAtLevel(stats.props?.targetGroup, level) === 6,
    zombie: Boolean(mods.zombie),
    abilityLevel: Math.max(0, Number(mods.abilityLevel) || 0),
    x: at.x, y: at.y, home: { x: at.x, y: at.y },
    penSize: 60, penOffset: -30,
    target: { x: at.x, y: at.y }, rotation: Math.random() * 360,
    frame: 0, moving: true,
  };
  if (flung) ent.flung = true; else ent.defender = true;
  view.renderer.penEntities.push(ent);
  view.renderer.hasAnimations = true;
  return ent;
}

// The whip's end as a pure function of beam age: angle advances
// (4/sqrt(dist))/2 per 80/s tick from its starting offset, the radius
// breathing by dist/20.
function laserSweepPoint(shot, now) {
  const sw = shot.sweep || { dist: 60, angle0: 0 };
  const ticks = Math.max(0, (now - shot.bornAt) / TOWER_TICK_MS);
  const angle = (sw.angle0 + ((4 / Math.sqrt(sw.dist)) / 2) * ticks) * Math.PI / 180;
  const wob = Math.sin((ticks / 4) / 20) * (sw.dist / 20);
  return {
    x: shot.from.x + Math.cos(angle) * (sw.dist + wob),
    y: shot.from.y + Math.sin(angle) * (sw.dist + wob),
  };
}

function towerApplyHit(view, sim, shot, now) {
  const renderer = view.renderer;
  // Railgun: full damage to every legal monster intersecting the ray
  // (lineIntersectCircle against each creep in BUILDING118).
  if (shot.kind === "rail") {
    for (const ent of renderer.penEntities || []) {
      if (!ent.flung || ent.dead) continue;
      if (!towerCanTarget(shot.towerType, ent)) continue;
      // Candidate sweep first: getCreepsInRange(1600, muzzle) measures in
      // CARTESIAN grid space...
      const pc = YardRenderer.fromIso(ent.x, ent.y);
      const dcx = shot.towerAt.x - pc.x;
      const dcy = shot.towerAt.y - pc.y;
      if (dcx * dcx + dcy * dcy > RAIL_RAY_LEN * RAIL_RAY_LEN) continue;
      // ...but lineIntersectCircle then runs on RAW STAGE (iso/world)
      // coordinates - creep._tmpPoint against the 1600px world-space ray -
      // with its DEFAULT radius of 20 for every creep, big or small.
      const a = shot.rayFromW;
      const bp = shot.rayEndW;
      const abx = bp.x - a.x;
      const aby = bp.y - a.y;
      const t = Math.max(0, Math.min(1,
        ((ent.x - a.x) * abx + (ent.y - a.y) * aby) / (abx * abx + aby * aby)));
      const dx = ent.x - (a.x + abx * t);
      const dy = ent.y - (a.y + aby * t);
      if (dx * dx + dy * dy > RAIL_HIT_RADIUS * RAIL_HIT_RADIUS) continue;
      // (BUILDING118's explicit x _damageMult is a no-op: the field is
      // always 1. The armor that counts lands in modifyHealth - once.)
      dealDamage(view, sim, ent, shot.damage, now);
    }
    renderer.penEntities = renderer.penEntities.filter((e) => !(e.flung && e.dead));
    return;
  }
  // Quake: INFERNOQUAKETOWER.Quake verbatim - damage scales down with
  // distance, floored at a third, capped at the victim's health.
  if (shot.kind === "quake") {
    const c = YardRenderer.fromIso(shot.from.x, shot.from.y);
    for (const ent of renderer.penEntities || []) {
      if (!ent.flung || ent.dead) continue;
      if (!towerCanTarget(shot.towerType, ent)) continue;
      const p = YardRenderer.fromIso(ent.x, ent.y);
      const dist = Math.hypot(c.x - p.x, c.y - p.y);
      if (dist > shot.range) continue;
      let dealt = (shot.damage / shot.range) * (shot.range - dist);
      if (dealt < shot.damage / 3) dealt = shot.damage / 3;
      // The health cap happens BEFORE modifyHealth's armor scaling.
      dealt = Math.min(dealt, ent.hp ?? ent.maxHp);
      dealDamage(view, sim, ent, dealt, now);
    }
    renderer.penEntities = renderer.penEntities.filter((e) => !(e.flung && e.dead));
    return;
  }
  const at = shot.target && !shot.target.dead
    ? { x: shot.target.x, y: shot.target.y } : shot.lastAt || shot.from;
  // Splash centre = where the round actually stopped (PROJECTILE impacts
  // inside one maxSpeed of the target, never on it); beams and instants
  // centre on the target. shot.tmp lives in world (draw) space - project
  // it to cart like everything else before measuring falloff.
  const c = shot.kind === "shot" && shot.tmp
    ? YardRenderer.fromIso(shot.tmp.x, shot.tmp.y)
    : YardRenderer.fromIso(at.x, at.y);
  const splash = Math.max(0, Number(shot.splash) || 0);
  if (shot.magma) {
    // FIREBALL.Splash, verbatim: the LOCKED TARGET takes FULL damage - no
    // falloff - while bystanders inside the radius take damage * 0.75 *
    // (splash - dist)/splash with NO floor and NO _damageMult. And the
    // splash plane is chosen by the VICTIM: a flying target means the
    // burst clips only flyers, a grounded one only ground.
    for (const ent of renderer.penEntities || []) {
      if (!ent.flung || ent.dead) continue;
      if (entIsFlying(ent) !== Boolean(shot.airSplash)) continue;
      // Everyone - the locked target included - must be inside the
      // getCreepsInRange(splash, impact) sweep to be touched at all...
      const p2 = YardRenderer.fromIso(ent.x, ent.y);
      const dd = Math.hypot(c.x - p2.x, c.y - p2.y);
      if (dd > splash) continue;
      // ...but only bystanders take falloff; the locked target's branch
      // is a flat -_damage.
      const dealt = ent === shot.target
        ? Number(shot.damage) || 0
        : (Number(shot.damage) || 0) * 0.75 * (splash - dd) / splash;
      // FIREBALL.Splash calls plain modifyHealth - armor applies there.
      dealDamage(view, sim, ent, dealt, now);
    }
    renderer.penEntities = renderer.penEntities.filter((e) => !(e.flung && e.dead));
    return;
  }
  for (const ent of renderer.penEntities || []) {
    if (!ent.flung || ent.dead) continue;
    // Splash only wounds what the tower could target in the first place: a
    // cannon shell bursting under a Teratorn does not clip its wings.
    if (!towerCanTarget(shot.towerType, ent)) continue;
    let hit = ent === shot.target;
    if (!hit && splash > 0) {
      const p = YardRenderer.fromIso(ent.x, ent.y);
      const dx = c.x - p.x;
      const dy = c.y - p.y;
      hit = dx * dx + dy * dy <= splash * splash;
    }
    if (!hit) continue;
    // Targeting.DealLinearAEDamage, verbatim: EVERY victim - the locked
    // target included - takes damage / radius * (radius - dist) measured
    // from the true impact point, floored at damage / 5, then scaled by
    // the monster's _damageMult (enrage armor). The projectile lands up to
    // one maxSpeed short of the monster, so even a stationary target takes
    // falloff - a 60-damage cannon really lands 40-52.
    let dealt = Number(shot.damage) || 0;
    if (splash > 0) {
      const p2 = YardRenderer.fromIso(ent.x, ent.y);
      const dd = Math.hypot(c.x - p2.x, c.y - p2.y);
      dealt = (dealt / splash) * (splash - dd);
      if (dealt < (Number(shot.damage) || 0) / 5) {
        dealt = (Number(shot.damage) || 0) / 5;
      }
    }
    // Armor lands in modifyHealth for direct AND splash hits alike (the
    // explicit x _damageMult in DealLinearAEDamage is always 1).
    dealDamage(view, sim, ent, dealt, now);
  }
  // collidedWithTarget: after the AoE, a Math.random() > 0.5 roll spawns a
  // live Spurtz (CREATURES.Spawn "IC1", "defend") at the impact point;
  // killSpurts() culls it after ~100 frames.
  if (shot.spurtz && Math.random() < SPURTZ_SPAWN_CHANCE) {
    const impact = shot.tmp || at;
    spawnDefender(view, sim, "IC1", 1,
      { id: `spurtz-${shot.towerType}`, x: impact.x, y: impact.y });
    const spawned = renderer.penEntities[renderer.penEntities.length - 1];
    if (spawned && spawned.defender) {
      spawned.spurtzDiesAt = now
        + (SPURTZ_LIFE_TICKS + Math.random() * 40) * TOWER_TICK_MS;
    }
  }
  const fallen = (renderer.penEntities || []).filter((e) => e.flung && e.dead);
  if (fallen.length) {
    renderer.penEntities = renderer.penEntities.filter((e) => !(e.flung && e.dead));
  }
}

// A defender stepping out of a bunker or the champion cage: same entity
// machinery as the flung attackers, chasing side flipped.
function spawnDefender(view, sim, baseId, level, b) {
  const renderer = view.renderer;
  const at = { x: b.x + (Math.random() - 0.5) * 30, y: b.y + 20 + Math.random() * 20 };
  let spec = null;
  let melee = 50;
  let hp = 1000;
  let reach = 0;
  let explodes = false;
  let triple = false;
  let delayTicks = 80;
  let power = 0;
  if (baseId[0] === "G") {
    const t = Number(baseId.slice(1));
    const lvl = Math.min(level, championMaxLevel(t));
    const sheet = guardianSheet(t, lvl);
    if (!sheet) return;
    const info = guardianInfo(t);
    melee = info?.props?.damage?.[lvl - 1] || 500;
    hp = info?.props?.health?.[lvl - 1] || 40000;
    reach = info?.props?.range?.[lvl - 1] || 35;
    spec = { kind: "guardian", sheet, sheets: guardianSheetCandidates(t, lvl),
      dirs: 16, speed: info?.props?.speed?.[lvl - 1] || 1,
      rowFn: (moving, tick) => guardianRow(t, lvl, moving, tick) };
  } else {
    const sheet = CREEP_SPRITES[baseId];
    const stats = monsterStat(baseId);
    if (!sheet || !stats) return;
    melee = statAtLevel(stats.props?.damage, level) || 50;
    // The level comes from the DEFENDER'S OWN save data (monsterupdate),
    // and every combat stat rides on it: health, damage, speed, and the
    // ability flags - explode (Eye-ra's props.explode) and targetGroup 6
    // (Balthazar's triple damage against monsters).
    hp = statAtLevel(stats.props?.health, level) || 500;
    reach = statAtLevel(stats.props?.range, level) || 0;
    // Lab powerups from the save's academy blob: DAVE's rocket range,
    // Bandito's whirlwind cadence; the rest hook into the swing below.
    power = Math.max(0, Number(
      view.simContext?.academy?.[baseId]?.powerup) || 0);
    if (baseId === "C12" && power > 0) reach = 100 + 40 * power;
    explodes = statAtLevel(stats.props?.explode, level) === 1;
    triple = statAtLevel(stats.props?.targetGroup, level) === 6;
    delayTicks = statAtLevel(stats.props?.attackDelay, level) || 80;
    if (baseId === "C7" && power > 0) {
      delayTicks = Math.max(8, Math.round(delayTicks / (1 + 0.5 * power)));
    }
    spec = { kind: "creep", sheet, dirs: 30,
      speed: statAtLevel(stats.props?.speed, level) || 1 };
  }
  const spawned = { ...spec,
    id: `defender-${b.id}-${Math.random().toString(36).slice(2)}`,
    defender: true, baseId, level, meleeDamage: melee,
    hp, maxHp: hp, atkRange: reach, explodes, tripleVsMonsters: triple,
    attackDelayTicks: delayTicks, abilityLevel: power,
    home: at, penSize: 60, penOffset: -30, x: at.x, y: at.y,
    target: { x: at.x, y: at.y }, rotation: Math.random() * 360,
    frame: 0, moving: true };
  renderer.penEntities.push(spawned);
  renderer.hasAnimations = true;
  return spawned;
}

// A creep's travelling projectile, per the FIREBALLS each rangedAttack
// spawns: Sabnox and Teratorn throw TYPE_MAGMA at speed 10, Zafreeti and
// Vorg TYPE_FIREBALL heal-balls at speed 25, Rezghul his dark fomorball.
// The ball homes on its victim (a FIREBALL follows even the corpse) and
// delivers on arrival: damage to the other side, healing (green +N) to
// its own.
function fireCreepBall(view, sim, src, victim, amount, now, opts = {}) {
  const heal = amount < 0;
  const style = heal ? "heal"
    : (src.baseId === "C19" ? "rez" : "magma");
  let sx = src.x;
  let sy = src.y - 12 - (Number(src.altitude) || 0);
  // Korath's Breath of Fire spawns at Point.interpolate(origin+50px up,
  // target, 0.8) - the ball materialises most of the way to the flyer.
  if (opts.interp > 0) {
    sy = src.y - (opts.lift || 0) - (Number(src.altitude) || 0);
    sx += (victim.x - sx) * opts.interp;
    sy += (victim.y - (Number(victim.altitude) || 0) - sy) * opts.interp;
  }
  sim.shots.push({ kind: "creep-ball", ball: style,
    from: { x: sx, y: sy },
    at: { x: sx, y: sy },
    dest: null, victim,
    speed: Number(opts.speed) || (heal ? 25 : 10),
    payload: amount, bornAt: now, done: false });
  view.renderer.hasAnimations = true;
}

// The rolling effects pass: expires putty rages, sweeps the Fomor and
// Krallen auras on the game's half-second cadence, and folds every active
// speed multiplier into the entity's live wander speed. Runs only while
// the sim holds flung monsters with something going on.
// EFFECTS.Dig (burst: radius 30, many chunks) / EFFECTS.Burrow (trail:
// radius 10, a few) - the sim draws the exported ParticlesObject chunk
// directly instead of pooling MovieClips, so counts are scaled down.
function pushDig(sim, ent, now, burst) {
  const count = burst ? 7 : 2;
  const radius = burst ? 30 : 10;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = radius * (0.2 + Math.random() * 0.8);
    sim.digs.push({
      x: ent.x + Math.cos(a) * r,
      y: ent.y + Math.sin(a) * r * 0.5,
      scale: (burst ? 1 : 0.6) * (0.7 + Math.random() * 0.6),
      bornAt: now,
      life: burst ? 500 : 350,
    });
  }
  if (sim.digs.length > 120) sim.digs.splice(0, sim.digs.length - 120);
}

function startEffectsLoop(view) {
  const sim = view.attackSim;
  if (!sim || sim.effectsRaf) return;
  let lastAura = 0;
  const step = () => {
    sim.effectsRaf = 0;
    if (view.attackSim !== sim || !view.renderer) return;
    const now = performance.now();
    // Retreat, per changeModeRetreat: a monster with nothing left walks
    // off the yard, and NOTHING shoots it on the way out - every targeting
    // sweep in the game filters behaviour "retreat".
    for (const r of view.renderer.penEntities || []) {
      if (!r.flung || r.dead || !r.retreating) continue;
      if (!r.retreatTo) {
        const rp = YardRenderer.fromIso(r.x, r.y);
        r.retreatTo = YardRenderer.toIsoPoint(rp.x < 0 ? rp.x - 900 : rp.x + 900, rp.y);
      }
      r.target = r.retreatTo;
      r.holdWander = true;
      r.moving = true;
      r.combatTarget = null;
      r.bTarget = null;
      if (Math.hypot(r.x - r.retreatTo.x, r.y - r.retreatTo.y) < 30) {
        view.renderer.penEntities =
          view.renderer.penEntities.filter((e) => e !== r);
      }
    }
    const flung = (view.renderer.penEntities || [])
      .filter((ent) => ent.flung && !ent.retreating);
    // The loop must NOT stop the instant the last monster dies: in-flight
    // rounds (a spurtz volley to fixed points, a shell already loosed)
    // still need stepping, popups and death rings need to fade, and
    // deployed defenders need to walk home. Only rest when it is all over.
    // Flight, per CreepBase.tickState: every battle tick simply sets
    // _altitude = m_altitudeMax - sin(_frameNumber / 50) * 5 - flyers
    // cruise INSTANTLY at max height (the creature's "altitude" prop, or
    // 108 by default; fly_low creatures 40) with a +/-5px sine bob about
    // 4s around. There is no climb animation for creeps; champions keep
    // their ChampionBase takeoff tween elsewhere. Popups and shots
    // subtract the same figure, so aim rides the bob like the game.
    for (const ent of view.renderer.penEntities || []) {
      if (!ent.flung && !ent.defender) continue;
      const fly = entIsFlying(ent);
      ent.flying = fly;
      if (!fly) { ent.altitude = 0; continue; }
      // Champions keep ChampionBase's takeoff: a 2s tween to 60, no bob.
      if (ent.baseId[0] === "G") {
        const cur = Number(ent.altitude) || 0;
        ent.altitude = cur >= 60 ? 60 : Math.min(60, cur + 60 / 160);
        continue;
      }
      const props = monsterStat(ent.baseId)?.props;
      const altMax = String(props?.movement) === "fly_low" ? 40
        : (Number(props?.altitude) || 108);
      ent.frame = ent.frame || 0;
      ent.altitude = altMax - Math.sin(ent.frame / 50) * 5;
    }
    // Burrowing (Wormzer, Valgos, King Wormzer), per
    // MonsterBase.renderBurrow: a battling burrower that is MOVING travels
    // fully underground - sprite hidden, untargetable, an EFFECTS.Dig
    // burst on entry and an EFFECTS.Burrow dirt trail every 5 logic ticks
    // - and surfacing plays another Dig burst plus the jump() pop (drawn
    // in the yard renderer). Retreat is walked above ground: renderBurrow
    // only burrows attack/defense.
    for (const ent of view.renderer.penEntities || []) {
      if (!BURROWERS.has(ent.baseId) || (!ent.flung && !ent.defender)) continue;
      const under = Boolean(ent.moving) && !ent.dead && !ent.retreating;
      if (under && !ent.burrowed) {
        ent.burrowed = true;
        ent.nextTrailAt = now;
        pushDig(sim, ent, now, true);
      } else if (!under && ent.burrowed) {
        ent.burrowed = false;
        ent.surfacedAt = now;
        pushDig(sim, ent, now, true);
      }
      if (ent.burrowed && now >= (ent.nextTrailAt || 0)) {
        ent.nextTrailAt = now + 62.5;   // every 5th tick at 80/s
        pushDig(sim, ent, now, false);
      }
    }
    // Acid puddles burn the opposing side's grounded monsters once a
    // second while they last.
    sim.acids = (sim.acids || []).filter((a) => now < a.until);
    for (const a of sim.acids) {
      if (now < a.nextAt) continue;
      a.nextAt = now + 1000;
      const ap = YardRenderer.fromIso(a.x, a.y);
      for (const m of view.renderer.penEntities || []) {
        if (m.dead || Boolean(m.flung) === a.side) continue;
        if (!m.flung && !m.defender) continue;
        if (entIsFlying(m) || (Number(m.altitude) || 0) > 0.5) continue;
        const mp = YardRenderer.fromIso(m.x, m.y);
        if (Math.hypot(ap.x - mp.x, ap.y - mp.y) > a.radius) continue;
        if (m.defender) hurtDefender(view, sim, m, a.dps, now);
        else dealDamage(view, sim, m, a.dps, now);
      }
    }
    const anythingLeft = flung.length
      || (sim.acids || []).length
      || (sim.shots || []).some((s) => !s.done || now < (s.until || 0))
      || (sim.popups || []).length || (sim.deaths || []).length
      || (sim.digs || []).length
      || (view.renderer.penEntities || []).some((e) => e.defender);
    if (!anythingLeft) return;

    if (now - lastAura >= AURA_CHECK_MS) {
      lastAura = now;
      const everyone = view.renderer.penEntities || [];
      for (const ent of everyone) {
        if (ent.flung || ent.defender) { ent.auraEnrage = null; ent.lootMult = null; }
      }
      // AOEEnrage targets FRIENDLIES of its owner: an attacking Fomor
      // buffs the flung horde, a DEFENDING champion Fomor buffs the
      // bunker defenders - both at radius 250 on the same 30-tick sweep.
      for (const champ of everyone) {
        if (champ.dead) continue;
        if (champ.baseId === "G3" && (champ.flung || champ.defender)) {
          // _buff = buffs[level] + bonusBuffs[foodBonus]: a buff-fed
          // defending Fomor shields harder than his level alone says.
          const fedBuff = championFeedBonus("G3", champ.foodBonus)?.buff || 0;
          const buff = guardianBuffAt(3, champ.level) + fedBuff;
          if (buff > 0) {
            const at = YardRenderer.fromIso(champ.x, champ.y);
            for (const ent of everyone) {
              if (ent === champ || ent.dead) continue;   // AOEEnrage skips its owner
              if (Boolean(ent.flung) !== Boolean(champ.flung)) continue; // friendlies only
              if (!ent.flung && !ent.defender) continue;
              const p = YardRenderer.fromIso(ent.x, ent.y);
              const dx = at.x - p.x;
              const dy = at.y - p.y;
              if (dx * dx + dy * dy < FOMOR_AURA_RADIUS * FOMOR_AURA_RADIUS) {
                // Enrage(1 + buff*2, buff): speed x (1 + 2b), damage taken
                // x (1 - b) - a level 6 Fomor shields for 40% off, not 60%.
                ent.auraEnrage = { speedMult: 1 + buff * 2, dmgMult: 1 - buff };
              }
            }
          }
        } else if (champ.baseId === "G5" && champ.flung) {
          const buff = guardianBuffAt(5, champ.level);
          const radius = krallenBuffRadiusAt(champ.level);
          const at = YardRenderer.fromIso(champ.x, champ.y);
          for (const ent of flung) {
            if (ent === champ) continue;
            const p = YardRenderer.fromIso(ent.x, ent.y);
            const dx = at.x - p.x;
            const dy = at.y - p.y;
            if (dx * dx + dy * dy < radius * radius) {
              ent.lootMult = 1 + buff;
            }
          }
        }
      }
    }

    let anyActive = false;
    for (const ent of flung) {
      if (ent.puttyEnrage && now >= ent.puttyEnrage.until) ent.puttyEnrage = null;
      let mult = 1;
      if (ent.puttyEnrage) mult *= ent.puttyEnrage.speedMult;
      if (ent.auraEnrage) mult *= ent.auraEnrage.speedMult;
      ent.speed = (ent.baseSpeed || 1) * mult;
      // The sprite's filter list, exactly as the components attach them:
      // Enrage adds GlowFilter(0xFF33FF, 0.6, 8, 8, 4, 3) - magenta - and
      // LootingMultiplier adds GlowFilter(0x55FF21, 0.6, 8, 8, 4, 3) -
      // green. A monster holding both shows both, chained: in game the
      // order is whichever component registered first; the sim fixes it as
      // enrage-inner, loot-outer.
      const filters = [];
      if (ent.puttyEnrage || ent.auraEnrage) {
        filters.push({ color: "255, 51, 255", alpha: 0.6, blur: 8, strength: 4 });
      }
      if (ent.lootMult) {
        filters.push({ color: "85, 255, 33", alpha: 0.6, blur: 8, strength: 4 });
      }
      ent.glowFilters = filters.length ? filters : null;
      if (ent.puttyEnrage || ent.auraEnrage || ent.lootMult) anyActive = true;
    }
    // (No burn pass: the magma tower's FlameEffect is dead code in this
    // client build - onProjectileCollision is never wired to
    // FIREBALL.COLLIDED - so no tower applies a damage-over-time here.)

    // ── Monster bunkers, per BUILDING22 (source, not wiki) ────────────
    // The housed load lives in EACH BUILDING'S OWN save record as `m`
    // ({C8: 4, C12: 2, ...}) - not in a yard-level blob. Detection sweeps
    // the per-level stats range for GROUND monsters, and ALSO for flyers
    // when the bunker houses an anti-air type (C12/C5/IC5/IC7): airborne
    // intruders absolutely trigger a door full of D.A.V.E.s. There is NO
    // damaged-state seal - a battered bunker keeps releasing until it is
    // destroyed. The door opens over 15 stage frames (375ms) and monsters
    // step out ONE PER 30 LOGIC TICKS (375ms), anti-air types first when
    // flyers are on the list, otherwise the last housed type in key
    // order; each release picks a RANDOM in-range target. Dispatch is
    // quota'd (dispatched[type] < housed[type]) and a defender walking
    // back in through the door refunds its slot.
    for (const b of view.renderer.buildings || []) {
      if (b.t !== 22 && b.t !== 128) continue;
      if (b.state === "destroyed") continue;
      let st = sim.bunkers?.get(b.id);
      if (!sim.bunkers) sim.bunkers = new Map();
      if (!st) {
        // Housed-load resolution, most-authoritative first. API saves
        // frequently ship these blobs as JSON STRINGS, so everything runs
        // through safeObject - the old `typeof === "object"` check failed
        // on them and fell straight to Fangs. MONSTERBUNKER.Data also
        // aliases the legacy C100 key onto C12 (D.A.V.E.).
        const housed = {};
        const takeCounts = (src) => {
          for (const [rawId, n] of Object.entries(src || {})) {
            const id = rawId === "C100" ? "C12" : rawId;
            const count = Math.floor(Number(n));
            if (monsterStat(id) && count > 0) {
              housed[id] = (housed[id] || 0) + count;
            }
          }
        };
        // 1) The building record's own `m` field (BUILDING22.Setup).
        takeCounts(safeObject(b.raw?.m));
        if (!Object.keys(housed).length) {
          const pool = safeObject(view.simContext?.bunkerData);
          // 2) monsterbunkerdata keyed by building id -> per-bunker counts.
          const mine = safeObject(pool[b.id] ?? pool[String(b.id)]);
          takeCounts(mine);
          // 3) A flat {monsterId: count} pool, split across intact doors.
          if (!Object.keys(housed).length) {
            const flat = {};
            for (const [k, v] of Object.entries(pool)) {
              if (/^I?C\d+$/.test(k === "C100" ? "C12" : k)) flat[k] = v;
            }
            if (Object.keys(flat).length) {
              const doors = Math.max(1, (view.renderer.buildings || []).filter(
                (x) => (x.t === 22 || x.t === 128) && x.state !== "destroyed").length);
              const split = {};
              for (const [id, count] of Object.entries(flat)) {
                split[id] = Math.ceil((Number(count) || 0) / doors);
              }
              takeCounts(split);
            }
          }
        }
        // 4) An EMPTY bunker is exactly that: it holds nothing, its door
        // never opens, nothing steps out. (BUILDING22 with an empty
        // _monsters dictionary can never pick a release type.) The old
        // Fang stand-in squad is gone - it was inventing defenders for
        // legitimately empty bunkers.
        let source = "record m field";
        if (!Object.keys(housed).length) {
          source = "empty bunker - releases nothing";
        } else if (!Object.keys(safeObject(b.raw?.m)).length) {
          source = "yard-level monsterbunkerdata pool";
        }
        // Diagnostic (one line per bunker per attack): exactly what this
        // door will release and where the data came from. If this ever
        // reports the Fang stand-in against a base you know holds
        // monsters, paste the line plus the /base/load buildingdata entry.
        console.info(
          `[BunkerSim] bunker id=${b.id} t=${b.t} lvl=${b.l || 1}`
          + ` housed=${JSON.stringify(housed)} (source: ${source};`
          + ` raw.m=${JSON.stringify(b.raw?.m ?? null)})`);
        st = { housed, dispatched: {}, out: 0, targets: [], flyers: [],
          nextFind: 0, nextRelease: 0, door: "closed", doorReadyAt: 0 };
        sim.bunkers.set(b.id, st);
      }
      const props = view.simContext?.gameData?.get?.(b.t);
      const stats = Array.isArray(props?.stats)
        ? props.stats[Math.max(0, Math.min(props.stats.length - 1, (b.l || 1) - 1))]
        : null;
      const radius = Number(stats?.range) || 300;
      const at = YardRenderer.fromIso(b.x, b.y);
      const hasAA = Object.keys(st.housed).some((id) => AA_DEFENDERS.has(id));
      const housedLeft = Object.entries(st.housed)
        .some(([id, n]) => (st.dispatched[id] || 0) < n);
      // FindTargets(3): every 10 ticks while empty-handed, every 60 while
      // holding a list; both lists sorted nearest-first, top three kept.
      if (now >= st.nextFind) {
        const sweep = (wantFly) => flung
          .filter((ent) => !ent.dead && entIsFlying(ent) === wantFly)
          .map((ent) => {
            const p = YardRenderer.fromIso(ent.x, ent.y);
            return { ent, dist: Math.hypot(at.x - p.x, at.y - p.y) };
          })
          .filter((x) => x.dist < radius)
          .sort((a2, b2) => a2.dist - b2.dist)
          .slice(0, 3)
          .map((x) => x.ent);
        st.targets = sweep(false);
        st.flyers = hasAA ? sweep(true) : [];
        st.nextFind = now
          + (st.targets.length || st.flyers.length ? 60 : 10) * TOWER_TICK_MS;
      } else {
        st.targets = st.targets.filter((e) => !e.dead
          && view.renderer.penEntities.includes(e));
        st.flyers = st.flyers.filter((e) => !e.dead
          && view.renderer.penEntities.includes(e));
      }
      // Door machine: opens while there is something to fight or someone
      // still outside, closes when the yard goes quiet again.
      const wantOpen = housedLeft
        && (st.targets.length || st.flyers.length || st.out > 0)
        || st.out > 0;
      if (wantOpen && st.door !== "open") {
        st.door = "open";
        // _animTick advances inside TickAttack: 15 LOGIC ticks (187.5ms)
        // to open, not 15 stage frames.
        st.doorReadyAt = now + 15 * TOWER_TICK_MS;
        b.simAnim = { startedAt: now, durationMs: 15 * TOWER_TICK_MS,
          holdLast: true, phases: [{ ms: 15 * TOWER_TICK_MS, f0: 0, f1: 14 }] };
      } else if (!wantOpen && st.door === "open") {
        st.door = "closed";
        b.simAnim = { startedAt: now, durationMs: 15 * TOWER_TICK_MS,
          phases: [{ ms: 15 * TOWER_TICK_MS, f0: 14, f1: 0 }] };
      }
      // HOUSINGBUNKER (the inferno compound, 128) has NO door gate: its
      // release condition never checks _animTick. Only the bunker waits.
      const isCompound = b.t === 128;
      if (!isCompound && (st.door !== "open" || now < st.doorReadyAt)) continue;
      if (now < st.nextRelease) continue;
      if (!st.targets.length && !st.flyers.length) continue;
      st.nextRelease = now + 30 * TOWER_TICK_MS;
      const releasable = (id) =>
        st.housed[id] > 0 && (st.dispatched[id] || 0) < st.housed[id];
      // Spawns one defender at the door edge facing its victim
      // (dispatchCreature's footprint fractions), hands the target over
      // directly, and books the dispatch. Burrowers step out already
      // underground: the compound spawns them at alpha 0.
      const spawnOne = (type, prey) => {
        const size = Number(props?.size)
          || view.renderer.gameData.footprint(b.t) || 60;
        const dxs = prey.x - b.x;
        const dys = prey.y - b.y;
        const door = {
          id: b.id,
          x: b.x + (dxs <= 0 ? -size / 3 : size / 2) * 0.8,
          y: b.y + (dys <= 0 ? size / 4 : size / 2) * 0.8,
        };
        const levels = view.simContext?.monsterLevels;
        const entry = levels?.[type];
        const owned = typeof entry === "number" ? entry : Number(entry?.level);
        const level = owned >= 1
          ? Math.min(owned, creatureMaxLevel(type)) : creatureMaxLevel(type);
        spawnDefender(view, sim, type, level, door);
        const d = view.renderer.penEntities[view.renderer.penEntities.length - 1];
        if (d && d.defender) {
          d.homeBunkerId = b.id;
          d.prey = prey;
          if (BURROWERS.has(type)) d.burrowed = true;
          st.dispatched[type] = (st.dispatched[type] || 0) + 1;
          st.out++;
        }
      };
      const aaPick = () => ["C12", "C5", "IC5", "IC7"].find(releasable) || null;
      if (isCompound) {
        // HOUSINGBUNKER pours: one anti-air interceptor per flyer target,
        // then EVERY remaining releasable creep at the nearest ground
        // target - no one-per-cycle trickle.
        for (const flyer of st.flyers) {
          const aaType = aaPick();
          if (!aaType) break;
          spawnOne(aaType, flyer);
        }
        if (st.targets.length) {
          const ground = st.targets[0];
          for (const id of Object.keys(st.housed)) {
            while (releasable(id)) spawnOne(id, ground);
          }
        }
        continue;
      }
      // Bunker: one monster per cycle. Flyers on the list pull the
      // anti-air roster in priority order; otherwise the LAST housed
      // ground type with quota, mirroring the client's for..in.
      let type = null;
      if (st.flyers.length) type = aaPick();
      if (!type && st.targets.length) {
        for (const id of Object.keys(st.housed)) {
          if (releasable(id)) type = id;
        }
      }
      if (!type) continue;
      const aa = AA_DEFENDERS.has(type);
      const list = aa && st.flyers.length ? st.flyers : st.targets;
      if (!list.length) continue;
      spawnOne(type, list[Math.floor(Math.random() * list.length)]);
    }
    // Champion cage: one-shot release at the 800px aggro, ground-gated.
    for (const b of view.renderer.buildings || []) {
      if (b.t !== 114 || b.state === "destroyed" || sim.released.has(b.id)) continue;
      const at = YardRenderer.fromIso(b.x, b.y);
      const near = flung.some((ent) => {
        if (entIsFlying(ent)) return false;
        const p = YardRenderer.fromIso(ent.x, ent.y);
        return Math.hypot(at.x - p.x, at.y - p.y) < CAGE_TRIGGER;
      });
      if (!near) continue;
      sim.released.add(b.id);
      b.simAnim = { startedAt: now, durationMs: 800 };
      const champ = (view.renderer.champions || [])[0];
      if (champ) {
        const released = spawnDefender(view, sim, `G${champ.t}`, champ.l || 1, b);
        if (released) {
          // Two SEPARATE save fields: pl (_powerLevel) is the ability
          // tier - Korath's Breath of Fire gates on pl >= 2, his stomp
          // on pl >= 3, and in this build feeding never raises it (only
          // the WOTC/KOTH event rewards do). fb (_foodBonus, 0-3) is the
          // buff-feed tier, adding CHAMPIONCAGE's flat stat bonuses on
          // top of the level stats.
          released.powerLevel = Math.max(0, Number(champ.pl) || 0);
          released.foodBonus = Math.max(0,
            Math.min(3, Number(champ.fb) || 0));
          released.feedLevel = released.powerLevel;
          const bonus = championFeedBonus(released.baseId, released.foodBonus);
          if (bonus) {
            released.maxHp = (released.maxHp || 0) + bonus.hp;
            released.hp = (released.hp || 0) + bonus.hp;
            released.meleeDamage = (released.meleeDamage || 0) + bonus.dmg;
            released.speed = (Number(released.speed) || 0) + bonus.spd;
            if (bonus.rng) {
              released.atkRange = (Number(released.atkRange) || 30) + bonus.rng;
            }
          }
        }
        sim.hiddenChampions = view.renderer.champions.splice(0, 1);
      }
    }

    // Deployed defenders, per CreepBase.findDefenseTargets: a defender
    // CHASES its current victim anywhere while it lives, but ACQUIRES
    // only within 200px of itself (nearest-first, flyers only for the
    // anti-air set and champions). With nothing near it asks its home
    // bunker for any target on the bunker's own list; and when the
    // bunker comes up empty it walks BACK THROUGH THE DOOR, refunding
    // its dispatch slot - no free-roaming across the yard.
    for (const d of (view.renderer.penEntities || [])) {
      if (!d.defender || d.dead) continue;
      // SpurtzCannon.killSpurts: spawned spurtz are disposable - past 100
      // frames they die off.
      if (d.spurtzDiesAt && now >= d.spurtzDiesAt) {
        d.dead = true;
        sim.deaths.push({ at: { x: d.x, y: d.y }, bornAt: now });
        view.renderer.penEntities =
          view.renderer.penEntities.filter((e) => e !== d);
        continue;
      }
      const canBite = (ent) => (!entIsFlying(ent)
        || AA_DEFENDERS.has(d.baseId) || d.baseId[0] === "G")
        && !ent.invisible    // a cloaked Brain walks right past them
        && !ent.burrowed;    // ...and so does a burrowed Wormzer
      let prey = (d.prey && !d.prey.dead
        && view.renderer.penEntities.includes(d.prey)) ? d.prey : null;
      // FindDefenseTargets cadence: champions rescan every 60 ticks,
      // creeps every 150 - taking the NEAREST legal monster in range even
      // while a target lives (the game just adopts the sorted head each
      // sweep). A sweep that finds nothing in range keeps the current
      // chase: _targetCreep survives until it dies.
      if (!prey || now >= (d.nextRescan || 0)) {
        d.nextRescan = now
          + (d.baseId[0] === "G" ? 60 : 150) * TOWER_TICK_MS;
        let near = null;
        let bestDist = Infinity;
        const dp = YardRenderer.fromIso(d.x, d.y);
        // Champions sweep their ChampionBase 800px; regular defenders the
        // creep-level 200px.
        const aggro = d.baseId[0] === "G" ? CAGE_TRIGGER : DEFENDER_AGGRO;
        for (const ent of flung) {
          if (ent.dead || !canBite(ent)) continue;
          // A GROUNDED champion never chases an Eye-ra:
          // FindDefenseTargets splices C5s out unless the champion flies.
          if (d.baseId[0] === "G" && !entIsFlying(d)
            && ent.baseId === "C5") continue;
          const p = YardRenderer.fromIso(ent.x, ent.y);
          const dist = Math.hypot(dp.x - p.x, dp.y - p.y);
          if (dist <= aggro && dist < bestDist) { near = ent; bestDist = dist; }
        }
        if (near) prey = near;
        if (!prey && d.homeBunkerId != null) {
          // Bunker.GetTarget: a RANDOM pick from the bunker's own top-3
          // list - the flyer list first for anyone able to hit the air.
          const st = sim.bunkers?.get(d.homeBunkerId);
          const canAA = AA_DEFENDERS.has(d.baseId) || d.baseId[0] === "G";
          const list = canAA && (st?.flyers || []).length
            ? st.flyers : (st?.targets || []);
          const pool = list.filter((e) => !e.dead && canBite(e));
          if (pool.length) prey = pool[Math.floor(Math.random() * pool.length)];
        }
        d.prey = prey;
      }
      if (prey) {
        const dp = YardRenderer.fromIso(d.x, d.y);
        const pp = YardRenderer.fromIso(prey.x, prey.y);
        const dist = Math.hypot(dp.x - pp.x, dp.y - pp.y);
        // interceptTarget's far chase: beyond 250px the game paths a
        // defender to the attacker's EIGHTH waypoint - cutting them off
        // ahead instead of tailing them. The sim's routes are corner-
        // compressed, so the corner after next stands in for
        // waypoint[7]; within 250px it charges the monster itself.
        let aim = prey;
        if (dist > 250 && Array.isArray(prey.path) && prey.path.length > 1) {
          aim = prey.path[Math.min(1, prey.path.length - 1)];
        }
        d.target = { x: aim.x, y: aim.y };
        d.moving = true;
        // Engage at DEFENSE_RANGE (30, sqrt of the 900 constant) or the
        // creature's own ranged reach (Sabnox 240 shoots flyers down).
        let reach = Math.max(30, Number(d.atkRange) || 0);
        // Korath swats the air: tickBDefend counts a FLYER within
        // m_range * 2 as at-target.
        if (d.baseId === "G4"
          && (entIsFlying(prey) || (Number(prey.altitude) || 0) > 0.5)) {
          reach = Math.max(reach, 60);
        }
        if (dist <= reach && now >= (d.nextBite || 0)) {
          d.nextBite = now + (d.attackDelayTicks || 80) * TOWER_TICK_MS;
          d.attackingUntil = now + 600;   // play the attack strip
          if (d.explodes) {
            // Eye-ra: one jump, one boom - full damage to the victim,
            // then the bomber is gone for good (its bunker slot with it).
            creepExplode(view, sim, d, prey, now);
            continue;
          }
          const dSwing = (d.meleeDamage || 50) * (d.tripleVsMonsters ? 3 : 1);
          if (d.baseId === "G4") {
            const feed = Math.max(0, Number(d.feedLevel) || 0);
            const kLvl = Number(d.level) || 1;
            if (feed >= 3 && kLvl >= 5 && (d.korathSwings || 0) >= 3) {
              // Fists of Doom: the stomp strip plays (rows 20-29) and the
              // quake lands - LinearAEDamage(range*2.5, dmg, inner
              // range*1.5), k_TARGETS_INVISIBLE included.
              d.korathSwings = 0;
              // The stomp strip is rows 20-29 at _frameNumber/8: ten
              // frames = exactly 1.0s. The quake fires when the strip
              // reaches row 26 - 0.6s in, the moment the fists land.
              d.action = "stomp";
              d.attackingUntil = now + 1000;
              setTimeout(() => { d.action = null; }, 1000);
              setTimeout(() => {
                if (view.attackSim === sim && !d.dead) {
                  korathQuake(view, sim, d, dSwing, performance.now());
                }
              }, 600);
              continue;
            }
            if (feed >= 2 && kLvl >= 4
              && (entIsFlying(prey) || (Number(prey.altitude) || 0) > 0.5)) {
              // Breath of Fire: magma ball at the flyer, damage/4, and
              // the flame DoT rides the hit.
              d.korathSwings = (d.korathSwings || 0) + 1;
              fireCreepBall(view, sim, d, prey, dSwing / 4, now,
                { speed: 8, interp: 0.8, lift: 50 });
              prey.flameDps = Math.max(prey.flameDps || 0, dSwing * 0.1);
              continue;
            }
          }
          if ((Number(d.atkRange) || 0) > 30) {
            // Ranged creeps loose a travelling FIREBALL (Sabnox and
            // Teratorn a TYPE_MAGMA ball at speed 10, Rezghul his dark
            // fomorball) that homes on the victim and lands its damage
            // on arrival, not instantly. A powered defending D.A.V.E.
            // fires his rocket pair at damage/2.
            if (d.baseId === "C12" && pw(d) > 0) {
              fireCreepBall(view, sim, d, prey, dSwing / 2, now);
              fireCreepBall(view, sim, d, prey, dSwing / 2, now);
            } else {
              fireCreepBall(view, sim, d, prey, dSwing, now);
            }
          } else {
            // Balthazar's targetGroup 6: triple damage against monsters.
            dealDamage(view, sim, prey, dSwing, now);
            // Korath's melee always brands the flame DoT (damage x 0.1)
            // and counts toward the stomp.
            if (d.baseId === "G4" && !prey.dead) {
              prey.flameDps = Math.max(prey.flameDps || 0, dSwing * 0.1);
              d.korathSwings = (d.korathSwings || 0) + 1;
            }
            // The yard owner's lab powerups bite back: Venom stacks its
            // DoT, Claws and Whirlwind splash the horde (a defender is
            // _friendly, so the AoE never touches the owner's buildings).
            if (d.baseId === "C8" && pw(d) > 0 && !prey.dead) {
              prey.venomDps = (prey.venomDps || 0) + dSwing * 0.1 * pw(d);
            }
            if (d.baseId === "C4" && pw(d) > 0) {
              labSplash(view, sim, d, prey, dSwing, now,
                { outer: 60, inner: 60, maxTargets: pw(d), monsters: true });
            }
            if (d.baseId === "C7" && pw(d) > 0) {
              labSplash(view, sim, d, prey, dSwing, now,
                { outer: 60, inner: 60, monsters: true });
              d.spinUntil = now + 700;
            }
          }
          // The aggro broadcast, from the source: a landed hit pulls the
          // victim onto its attacker (_targetCreep._targetCreep = this)
          // plus up to five nearby ground attackers within 50px.
          if (!prey.dead && !prey.explodes && !prey.combatTarget) {
            prey.combatTarget = d;
          }
          let pulled = 0;
          for (const other of flung) {
            if (pulled >= 5) break;
            if (other === prey || other.dead || other.explodes) continue;
            if ((statAtLevel(monsterStat(other.baseId)?.props?.damage,
              other.level || 1) ?? 0) < 0) continue;   // healers stay out
            if (entIsFlying(other) || other.combatTarget) continue;
            const op = YardRenderer.fromIso(other.x, other.y);
            if (Math.hypot(dp.x - op.x, dp.y - op.y) <= 50) {
              other.combatTarget = d;
              pulled++;
            }
          }
          if (prey.dead) {
            d.prey = null;
            view.renderer.penEntities =
              view.renderer.penEntities.filter((e) => !(e.flung && e.dead));
          }
        }
        continue;
      }
      // Nothing to fight: bunker defenders head home and re-enter.
      if (d.homeBunkerId != null) {
        const home = (view.renderer.buildings || [])
          .find((x) => x.id === d.homeBunkerId);
        if (home && home.state !== "destroyed") {
          d.target = { x: home.x, y: home.y + 14 };
          d.moving = true;
          if (Math.hypot(d.x - home.x, d.y - (home.y + 14)) < 24) {
            const st = sim.bunkers?.get(d.homeBunkerId);
            if (st) {
              st.dispatched[d.baseId] = Math.max(0, (st.dispatched[d.baseId] || 0) - 1);
              st.out = Math.max(0, st.out - 1);
            }
            view.renderer.penEntities =
              view.renderer.penEntities.filter((e) => e !== d);
          }
          continue;
        }
      }
      d.moving = false;
    }

    // ── Structures under attack, per tickBAttack + findTarget ─────────
    // Attacking monsters that aren't brawling with a defender pick a
    // building by their targetGroup - Eye-ra to the walls, Bolt's crew to
    // the resources, the tower-busters to the defenses, everyone else to
    // whatever is nearest - walk to its edge, and swing on their own
    // cadence. Eye-ra detonates on arrival; D.A.V.E. lobs his TWO
    // missiles at damage/2 each; Sabnox's magma hits towers for double;
    // the flyers bombard from altitude; the rest chew in melee. A dead
    // target sends them shopping again (150-frame cadence).
    for (const ent of flung) {
      if (ent.dead || ent.combatTarget) continue;
      const tg = Number(ent.targetGroup) || 1;
      if (tg === 5) continue;   // healers heal
      if (tg === 6) {
        // Hunters (Balthazar) stalk the defense first: nearest live
        // defender or champion. With no one out, findTarget's own tg6
        // branch has them siege the STOCKED BUNKERS - and with none of
        // those either, the fallback scan turns them into a permanent
        // group-1 building attacker.
        if (!ent.combatTarget) {
          let best = null;
          let bestD = Infinity;
          const hp0 = YardRenderer.fromIso(ent.x, ent.y);
          for (const d2 of view.renderer.penEntities || []) {
            if (!d2.defender || d2.dead) continue;
            const dp2 = YardRenderer.fromIso(d2.x, d2.y);
            const dd2 = Math.hypot(hp0.x - dp2.x, hp0.y - dp2.y);
            if (dd2 < bestD) { best = d2; bestD = dd2; }
          }
          if (best) { ent.combatTarget = best; continue; }
          const stocked = (view.renderer.buildings || []).filter((b2) => {
            if ((b2.t !== 22 && b2.t !== 128) || b2.state === "destroyed") return false;
            const st2 = sim.bunkers?.get(b2.id);
            return !st2 || Object.values(st2.housed).some((n) => n > 0) || st2.out > 0;
          });
          if (stocked.length) {
            if (!ent.bTarget || ent.bTarget.state === "destroyed") {
              const hp1 = YardRenderer.fromIso(ent.x, ent.y);
              ent.bTarget = stocked.sort((x2, y2) => {
                const xa = YardRenderer.fromIso(x2.x, x2.y);
                const ya = YardRenderer.fromIso(y2.x, y2.y);
                return Math.hypot(hp1.x - xa.x, hp1.y - xa.y)
                  - Math.hypot(hp1.x - ya.x, hp1.y - ya.y);
              })[0];
            }
          } else {
            ent.targetGroup = 1;
          }
          if (!ent.bTarget) continue;
        } else continue;
      }
      const hd2 = statAtLevel(monsterStat(ent.baseId)?.props?.damage, ent.level || 1);
      if (hd2 < 0) continue;    // Zafreeti/Vorg never siege
      if (ent.bTarget && (ent.bTarget.state === "destroyed"
        || !view.renderer.buildings.includes(ent.bTarget))) ent.bTarget = null;
      // tickBAttack: a WALKING monster (not attacking) re-runs findTarget
      // every 150 ticks - 300 once more than 20 attackers are afield -
      // and adopts whatever has become closest as walls fall. The sim
      // previously locked the first pick until it died.
      if (ent.bTarget && now > (ent.attackingUntil || 0)
        && now >= (ent.nextRetargetAt || 0)) {
        ent.nextRetargetAt = now
          + (flung.length > 20 ? 300 : 150) * TOWER_TICK_MS;
        const fresh = pickBuildingTarget(view, sim, ent);
        if (fresh && fresh !== ent.bTarget) {
          ent.bTarget = fresh;
          ent.path = null;
          ent.pathGoal = null;
        }
      }
      if (!ent.bTarget) {
        if (now < (ent.nextFindB || 0)) continue;
        ent.nextFindB = now + 1875;   // frameNumber % 150 at 80 ticks/s
        ent.bTarget = pickBuildingTarget(view, sim, ent);
        if (!ent.bTarget) continue;
      }
      const b = ent.bTarget;
      const mp = YardRenderer.fromIso(ent.x, ent.y);
      const bp = YardRenderer.fromIso(b.x, b.y);
      const half = YardRenderer.pathFootprint(b.t) / 2;
      // The path floods to the building's RECTANGLE, so a walker stands
      // at the FOOTPRINT EDGE on whichever side it arrived - never the
      // centre. Burrowers surface at a RANDOM side (the burrowWaypoint
      // rolls int(random()*4)). The stand point is fixed per target so
      // a horde fans out along the face instead of stacking.
      const airborne0 = entIsFlying(ent) || (Number(ent.altitude) || 0) > 0.5;
      if (!airborne0) {
        const standKey = "b" + b.id;
        if (ent.standKey !== standKey) {
          ent.standKey = standKey;
          let ang;
          if (DIRECT_PATHERS.has(ent.baseId)) {
            ang = Math.floor(Math.random() * 4) * (Math.PI / 2)
              + (Math.random() - 0.5) * 0.6;
          } else {
            ang = Math.atan2(mp.y - bp.y, mp.x - bp.x)
              + (Math.random() - 0.5) * 0.7;   // spread along the face
          }
          const sx = bp.x + Math.cos(ang) * (half + 8);
          const sy = bp.y + Math.sin(ang) * (half + 8);
          ent.standPoint = YardRenderer.toIsoPoint(sx, sy);
        }
        ent.target = { x: ent.standPoint.x, y: ent.standPoint.y };
      } else {
        ent.target = { x: b.x, y: b.y };
      }
      ent.holdWander = true;
      ent.moving = true;
      // Flyers bombard from the findTarget standoff: _atTarget within 170
      // of the building centre (Balthazar closes to 50); walkers close to
      // the footprint edge plus their reach.
      const airborne = entIsFlying(ent) || (Number(ent.altitude) || 0) > 0.5;
      const gap = airborne
        ? Math.hypot(mp.x - bp.x, mp.y - bp.y)
        : Math.hypot(mp.x - bp.x, mp.y - bp.y) - half;
      const reach = airborne
        ? (ent.baseId === "IC5" ? 50 : 170)
        : Math.max(30, Number(ent.atkRange) || 0);
      if (gap > reach) continue;
      ent.moving = gap > 4;
      if (now < (ent.nextSwing || 0)) continue;
      ent.nextSwing = now + (ent.attackDelayTicks || 80) * TOWER_TICK_MS;
      ent.attackingUntil = now + 600;
      const dmg = Number(ent.attackDamage) || 50;
      if (ent.explodes) {
        // Full damage to the wall he jumped, the scaled ring for the rest.
        creepExplode(view, sim, ent, null, now, b);
        continue;
      }
      // Splash Damage: a powered Wormzer's FIRST strike on each new
      // target pops up with an AoE - damage x level, radius 100, linear
      // falloff (AOEDamageOnAttackOncePerTarget).
      if (ent.baseId === "C13" && pw(ent) > 0 && ent.lastSplashTarget !== b) {
        ent.lastSplashTarget = b;
        labSplash(view, sim, ent, null, dmg * pw(ent), now,
          { outer: 100, buildings: true, monsters: true });
      }
      // Whirlwind fires on ANY attack: a swing at a building still
      // splashes every enemy ground monster within 60px (never buildings).
      if (ent.baseId === "C7" && pw(ent) > 0) {
        labSplash(view, sim, ent, null, dmg, now,
          { outer: 60, inner: 60, monsters: true });
        ent.spinUntil = now + 700;
      }
      // Claws splash their full swing onto neighbours of the building too.
      if (ent.baseId === "C4" && pw(ent) > 0) {
        labSplash(view, sim, ent, b, dmg, now,
          { outer: 60, inner: 60, maxTargets: pw(ent),
            buildings: true, monsters: true });
      }
      if (ent.baseId === "C12" && (Number(ent.atkRange) || 0) > 30) {
        // Rockets (powered only - an unpowered D.A.V.E. has range 1 and
        // chews in melee): FIREBALLS.Spawn TWICE, TYPE_MISSILE, damage/2.
        for (let m2 = 0; m2 < 2; m2++) {
          sim.shots.push({ kind: "creep-ball", ball: "magma",
            from: { x: ent.x + Math.random() * 10 - 5, y: ent.y - 14 },
            at: { x: ent.x + Math.random() * 10 - 5, y: ent.y - 14 },
            dest: null, building: b, speed: 10, src: ent,
            payload: dmg / 2, bornAt: now, done: false });
        }
        view.renderer.hasAnimations = true;
        continue;
      }
      if ((Number(ent.atkRange) || 0) > 30) {
        // Sabnox: damage x2 when the victim's class is "tower".
        const vsTower = ent.baseId === "IC7"
          && String(view.simContext?.gameData?.get?.(b.t)?.type) === "tower";
        // Ricochet: a powered Teratorn's fireball carries <level> glaives.
        sim.shots.push({ kind: "creep-ball", ball: "magma",
          from: { x: ent.x, y: ent.y - 12 - (Number(ent.altitude) || 0) },
          at: { x: ent.x, y: ent.y - 12 - (Number(ent.altitude) || 0) },
          dest: null, building: b,
          // FIREBALLS.Spawn for a Teratorn's building shot flies at 6;
          // the rest keep the standard 10.
          speed: ent.baseId === "C14" ? 6 : 10, src: ent,
          glaives: ent.baseId === "C14" ? pw(ent) : 0,
          payload: dmg * (vsTower ? 2 : 1), bornAt: now, done: false });
        view.renderer.hasAnimations = true;
        continue;
      }
      {
        // findTarget-preference bonuses (tickBAttack _loc8_): group 2
        // MELEE deals x2 to walls, group 4 x2 to towers. Ranged attacks
        // never carry the bonus - _loc8_ only multiplies the direct
        // modifyHealth swings.
        const bTy = String(view.simContext?.gameData?.get?.(b.t)?.type || "");
        const tgB = Number(ent.targetGroup);
        const mult = (tgB === 2 && bTy === "wall") ? 2
          : (tgB === 4 && bTy === "tower") ? 2 : 1;
        damageBuilding(view, sim, b, dmg * mult, now, ent);
      }
    }

    // ── Lab powerups that live on the clock ───────────────────────────
    // Venom ticks its stacked dps every second; Bolt blinks when the goal
    // is close; Brain cloaks while travelling and stays cloaked <level>
    // seconds after arriving (Invisibility).
    for (const v of view.renderer.penEntities || []) {
      if (v.dead) continue;
      // Two separate DoT clocks: Korath's FlameEffect fires _dps every
      // _MAX_TICKS = 40 (0.5s); the _damagePerSecond pool (venom) fires
      // on _frameNumber % 60 (0.75s at 80 ticks/s, its name predating
      // the tick rate).
      const flame = Number(v.flameDps) || 0;
      if (flame > 0 && now >= (v.nextFlameAt || 0)) {
        v.nextFlameAt = now + 500;
        if (v.defender) hurtDefender(view, sim, v, flame, now);
        else dealDamage(view, sim, v, flame, now);
      }
      const venom = Number(v.venomDps) || 0;
      if (venom > 0 && !v.dead && now >= (v.nextVenomAt || 0)) {
        v.nextVenomAt = now + 750;
        if (v.defender) hurtDefender(view, sim, v, venom, now);
        else dealDamage(view, sim, v, venom, now);
      }
    }
    for (const ent of view.renderer.penEntities || []) {
      if (ent.dead || (!ent.flung && !ent.defender)) continue;
      if (ent.baseId === "C3" && pw(ent) > 0 && ent.target) {
        const key = ent.bTarget ? "b" + ent.bTarget.id
          : (ent.combatTarget ? "m" + ent.combatTarget.id
            : (ent.prey ? "p" + ent.prey.id : "w"));
        if (ent.blinkKey !== key) { ent.blinkKey = key; ent.blinkPoints = 10; }
        const gp = YardRenderer.fromIso(ent.target.x, ent.target.y);
        const sp = YardRenderer.fromIso(ent.x, ent.y);
        const dd = Math.hypot(gp.x - sp.x, gp.y - sp.y);   // cart, vs L*150
        const idd = Math.hypot(ent.target.x - ent.x, ent.target.y - ent.y);
        if (dd > 12 && idd > 8 && dd < pw(ent) * 150
          && (ent.blinkPoints || 0) > 0) {
          ent.blinkPoints--;
          const hop = Math.min(30, idd - 8);
          ent.x += (ent.target.x - ent.x) / idd * hop;
          ent.y += (ent.target.y - ent.y) / idd * hop;
          ent.path = null;        // the hop outran the waypoint chain
          ent.nextPathAt = 0;     // re-route from the new spot
          ent.blinkUntil = now + 200;   // ghost flicker
        }
      }
      if (ent.baseId === "C9" && ent.flung && pw(ent) > 0) {
        if (!ent.bTarget || ent.retreating) {
          ent.invisible = false;   // nothing to sneak toward
          ent.action = null;
          continue;
        }
        const arriving = ent.bTarget && !ent.moving;
        const key9 = ent.bTarget ? "b" + ent.bTarget.id : null;
        if (key9 && ent.cloakKey !== key9) {
          ent.cloakKey = key9;
          ent.invisible = true;      // cloaks the moment he sets out
          ent.cloakExpiry = 0;
        }
        if (ent.invisible) {
          if (arriving) {
            if (!ent.cloakExpiry) ent.cloakExpiry = now + pw(ent) * 1000;
            else if (now >= ent.cloakExpiry) ent.invisible = false;
          } else ent.cloakExpiry = 0;
        }
        ent.action = ent.invisible ? "invisible" : null;
      }
    }

    // ── Pathing pass, per PATHING.GetPath ─────────────────────────────
    // Every ground walker with somewhere to be gets routed around the
    // yard's living footprints. Flyers sail over everything, and the
    // burrowers (Wormzer's clan carries pathing "direct" in the creature
    // locker) dig straight under walls and buildings - both skip the
    // grid entirely. A monster whose goal is genuinely walled off walks
    // direct as a fallback (in game it would start eating the wall).
    for (const ent of view.renderer.penEntities || []) {
      if (ent.dead || (!ent.flung && !ent.defender) || !ent.target) continue;
      if (ent.flying || (Number(ent.altitude) || 0) > 0.5
        || DIRECT_PATHERS.has(ent.baseId)) {
        ent.path = null;
        continue;
      }
      const moved = !ent.pathGoal
        || Math.hypot(ent.target.x - ent.pathGoal.x,
          ent.target.y - ent.pathGoal.y) > 36;
      if (!moved && now < (ent.nextPathAt || 0)) continue;
      if (!moved && Array.isArray(ent.path) && ent.path.length) continue;
      ent.nextPathAt = now + 1200;
      ent.pathGoal = { x: ent.target.x, y: ent.target.y };
      const route = view.renderer.findPath(ent, ent.target);
      if (route === null) {
        ent.path = null;   // off-grid oddity: walk direct
      } else {
        ent.path = route.waypoints.length ? route.waypoints : null;
        // The cheapest route crosses a building core: that IS the game's
        // wall-chewing decision - a level-1 fence is cheaper to eat than
        // a long detour, a high wall sends them around. The crossing
        // building becomes the attack target; the door opens itself.
        if (route.chew && ent.flung && !ent.combatTarget
          && ent.bTarget !== route.chew) {
          ent.bTarget = route.chew;
        }
      }
    }

    // Attackers fight back, per the source's aggro plumbing: a defender's
    // landed hit set _targetCreep on its victim (and up to five nearby
    // attackers), and here those monsters break off to fight it - chasing
    // the defender or champion, swinging their own per-level damage every
    // second at DEFENSE_RANGE 30 or their ranged reach. An Eye-ra pulled
    // into a brawl detonates instead of swinging. When the foe dies the
    // monster shakes it off and resumes rampaging.
    for (const ent of flung) {
      if (ent.dead) continue;
      let foe = ent.combatTarget;
      // Heal-behaviour creeps never join the brawl (the source's aggro
      // sweep and prey-pull both filter them).
      const entHeal = ent.healerDamage
        ?? (ent.healerDamage = statAtLevel(
          monsterStat(ent.baseId)?.props?.damage, ent.level || 1) ?? 0);
      if (entHeal < 0) {
        ent.combatTarget = null;
        healerTick(view, sim, ent, flung, now);
        continue;
      }
      if (foe && (foe.dead || !view.renderer.penEntities.includes(foe))) {
        ent.combatTarget = null;
        foe = null;
      }
      if (!foe) continue;
      ent.target = { x: foe.x, y: foe.y };
      ent.holdWander = true;   // keep chasing; frame keeps ticking
      ent.moving = true;
      const ap = YardRenderer.fromIso(ent.x, ent.y);
      const fp = YardRenderer.fromIso(foe.x, foe.y);
      const dist = Math.hypot(ap.x - fp.x, ap.y - fp.y);
      const reach = Math.max(30, Number(ent.atkRange) || 0);
      if (dist <= reach && now >= (ent.nextSwing || 0)) {
        ent.nextSwing = now + (ent.attackDelayTicks || 80) * TOWER_TICK_MS;
        ent.attackingUntil = now + 600;
        if (ent.explodes) {
          creepExplode(view, sim, ent, foe, now);
          continue;
        }
        const aSwing = (ent.attackDamage || 50) * (ent.tripleVsMonsters ? 3 : 1);
        if ((Number(ent.atkRange) || 0) > 30) {
          if (ent.baseId === "C12" && pw(ent) > 0) {
            // Rockets: DAVE.rangedAttack spawns TWO missiles, damage/2.
            fireCreepBall(view, sim, ent, foe, aSwing / 2, now);
            fireCreepBall(view, sim, ent, foe, aSwing / 2, now);
          } else {
            fireCreepBall(view, sim, ent, foe, aSwing, now);
          }
        } else {
          if (ent.baseId === "G4") {
            const feedA = Math.max(0, Number(ent.feedLevel) || 0);
            const kLvlA = Number(ent.level) || 1;
            if (feedA >= 3 && kLvlA >= 5 && (ent.korathSwings || 0) >= 3) {
              ent.korathSwings = 0;
              // Rows 20-29 at /8 = a 1.0s strip; the quake lands at row
              // 26, 0.6s into the animation.
              ent.action = "stomp";
              ent.attackingUntil = now + 1000;
              setTimeout(() => { ent.action = null; }, 1000);
              setTimeout(() => {
                if (view.attackSim === sim && !ent.dead) {
                  korathQuake(view, sim, ent, aSwing, performance.now());
                }
              }, 600);
              continue;
            }
            if (feedA >= 2 && kLvlA >= 4
              && (entIsFlying(foe) || (Number(foe.altitude) || 0) > 0.5)) {
              ent.korathSwings = (ent.korathSwings || 0) + 1;
              fireCreepBall(view, sim, ent, foe, aSwing / 4, now,
                { speed: 8, interp: 0.8, lift: 50 });
              foe.flameDps = Math.max(foe.flameDps || 0, aSwing * 0.1);
              continue;
            }
            ent.korathSwings = (ent.korathSwings || 0) + 1;
            if (!foe.dead) foe.flameDps = Math.max(foe.flameDps || 0, aSwing * 0.1);
          }
          // Hunters (group 6) deal x3 to creatures (tickBAttack _loc8_).
          hurtDefender(view, sim, foe,
            aSwing * (Number(ent.targetGroup) === 6 ? 3 : 1), now);
          // tickBAttack bite-back: the swing itself hands the victim its
          // attacker - instantly, not on the next aggro sweep - unless
          // the defender is already engaged at-target with someone.
          if (!foe.dead && (!foe.prey || foe.prey.dead
            || now > (foe.attackingUntil || 0))) {
            foe.prey = ent;
          }
          // Venom: a powered Fang's bite hooks a stacking DoT into the
          // victim - dps = damage x level x 0.1, permanent until death.
          if (ent.baseId === "C8" && pw(ent) > 0) {
            foe.venomDps = (foe.venomDps || 0) + aSwing * 0.1 * pw(ent);
          }
          // Claws: Fink's swing splashes FULL damage to up to <level>
          // extra targets within 60px (buildings and enemy ground).
          if (ent.baseId === "C4" && pw(ent) > 0) {
            labSplash(view, sim, ent, foe, aSwing, now,
              { outer: 60, inner: 60, maxTargets: pw(ent),
                buildings: true, monsters: true });
          }
          // Whirlwind: every powered Bandito swing hits ALL enemy ground
          // monsters within 60px for full damage (never buildings), and
          // he visibly spins while brawling.
          if (ent.baseId === "C7" && pw(ent) > 0) {
            labSplash(view, sim, ent, foe, aSwing, now,
              { outer: 60, inner: 60, monsters: true });
            ent.spinUntil = now + 700;
          }
        }
        if (foe.dead) ent.combatTarget = null;
      }
    }

    // Healers, per Zafreeti/Vorg: their damage stat is NEGATIVE - the
    // "attack" is a heal fireball (TYPE_FIREBALL, speed 25) lobbed at the
    // most wounded friendly within range 150, on their own rapid cadence
    // (Zafreeti every 20 ticks, Vorg every 10). They never brawl; they
    // chase whoever on their side is hurting.
    for (const ent of view.renderer.penEntities || []) {
      if (ent.dead || (!ent.flung && !ent.defender)) continue;
      const hd = ent.healerDamage
        ?? (ent.healerDamage = statAtLevel(
          monsterStat(ent.baseId)?.props?.damage, ent.level || 1) ?? 0);
      if (hd >= 0) continue;
      const side = Boolean(ent.flung);
      let patient = null;
      let worst = 1;
      for (const other of view.renderer.penEntities || []) {
        if (other === ent || other.dead || other.retreating) continue;
        if (ANTI_HEAL.has(other.baseId)) continue;   // healers can't be healed
        if (Boolean(other.flung) !== side) continue;
        if (!other.flung && !other.defender) continue;
        const frac = (other.hp ?? 1) / Math.max(1, other.maxHp ?? 1);
        if (frac < worst) { worst = frac; patient = other; }
      }
      if (!patient) continue;
      ent.target = { x: patient.x, y: patient.y };
      ent.holdWander = true;
      ent.moving = true;
      const hp1 = YardRenderer.fromIso(ent.x, ent.y);
      const hp2 = YardRenderer.fromIso(patient.x, patient.y);
      const range = Number(ent.atkRange) || 150;
      if (Math.hypot(hp1.x - hp2.x, hp1.y - hp2.y) <= range
        && now >= (ent.nextSwing || 0)) {
        ent.nextSwing = now + (ent.attackDelayTicks || 20) * TOWER_TICK_MS;
        ent.attackingUntil = now + 400;
        fireCreepBall(view, sim, ent, patient, hd, now);  // negative = heal
      }
    }

    // Rezghul raises the dead: every resurrectCooldown seconds (7 down to
    // 4 by level) he takes a ground corpse of his own side within 300 and
    // returns it as a ZOMBIE - speed x0.75, health and damage x1.0-1.5.
    for (const ent of view.renderer.penEntities || []) {
      if (ent.dead || ent.baseId !== "C19") continue;
      if (!ent.flung && !ent.defender) continue;
      const zp = monsterStat("C19")?.props;
      const cd = (statAtLevel(zp?.resurrectCooldown, ent.level || 1) || 7) * 1000;
      if (now < (ent.nextRez || 0)) continue;
      const rp = YardRenderer.fromIso(ent.x, ent.y);
      const side = Boolean(ent.flung);
      const idx = (sim.corpses || []).findIndex((c) => {
        if (c.flung !== side || now - c.at > 15000) return false;
        const cp = YardRenderer.fromIso(c.x, c.y);
        return Math.hypot(rp.x - cp.x, rp.y - cp.y) <= 300;
      });
      if (idx < 0) continue;
      ent.nextRez = now + cd;
      ent.attackingUntil = now + 600;
      const corpse = sim.corpses.splice(idx, 1)[0];
      spawnSideCreep(view, sim, corpse.baseId, corpse.level, corpse, side, now, {
        zombie: true, abilityLevel: corpse.abilityLevel || 0,
        speedMult: statAtLevel(zp?.zombieSpeedMultiplier, ent.level) || 0.75,
        healthMult: statAtLevel(zp?.zombieHealthMultiplier, ent.level) || 1,
        damageMult: statAtLevel(zp?.zombieDamageMultiplier, ent.level) || 1,
      });
      // The resurrect theatre: EFFECTS.Dig dirt at the feet, and the
      // zombie tweens up 20px over 0.8s (drawn in the yard renderer,
      // which also runs Zombiefy's grayscale fade off raisedAt).
      const zomb = view.renderer.penEntities[view.renderer.penEntities.length - 1];
      if (zomb) {
        zomb.raisedAt = now;
        pushDig(sim, zomb, now, true);
      }
      sim.shots.push({ kind: "creep-ball", ball: "rez",
        from: { x: ent.x, y: ent.y - 14 }, at: { x: ent.x, y: ent.y - 14 },
        dest: { x: corpse.x, y: corpse.y }, speed: 50,
        payload: 0, bornAt: now, done: false });
    }

    // Return fire: every live tower gets its tick, then travelling shots
    // land and expired beams clean themselves up.
    for (const b of view.renderer.buildings || []) towerFire(view, sim, b, now);
    const dt = Math.min(200, now - (sim.lastShotStep || now));
    sim.lastShotStep = now;
    for (const shot of sim.shots) {
      if (shot.done || now < shot.bornAt) continue;
      if (shot.target && !shot.target.dead) {
        shot.lastAt = { x: shot.target.x, y: shot.target.y };
      }
      if (shot.kind === "creep-ball") {
        // FIREBALL.Move: home on the victim - even the corpse - at
        // 0.5*speed per logic tick, delivering the payload on contact.
        const v = shot.victim;
        if (shot.building) {
          shot.dest = { x: shot.building.x, y: shot.building.y - 8 };
        } else if (v && !v.dead && view.renderer.penEntities.includes(v)) {
          shot.dest = { x: v.x, y: v.y - (Number(v.altitude) || 0) };
        } else if (!shot.dest && v) {
          shot.dest = { x: v.x, y: v.y };
        }
        const goal = shot.dest || shot.at;
        const dx = goal.x - shot.at.x;
        const dy = goal.y - shot.at.y;
        const dd = Math.hypot(dx, dy);
        const step2 = (shot.speed || 10) * 40 * (dt / 1000);
        if (dd <= Math.max(6, step2)) {
          shot.done = true;
          shot.hitAt = now;
          if (shot.building) {
            if (shot.payload > 0) {
              // The shooter rides the shell so the hit loots like any
              // other monster-attributed damage.
              damageBuilding(view, sim, shot.building, shot.payload, now,
                shot.src && !shot.src.dead ? shot.src : null);
            }
            if (shot.glaives > 0) {
              // FindGlaiveTarget, exactly: candidates within 100px, NON-
              // WALL buildings first, walls ONLY when nothing else is in
              // reach, and never straight back to the previous target
              // when another candidate exists. Half payload per bounce.
              const hp3 = YardRenderer.fromIso(shot.building.x, shot.building.y);
              const gather = (wantWalls) => {
                const out = [];
                for (const b3 of view.renderer.buildings || []) {
                  if (b3 === shot.building || b3.state === "destroyed") continue;
                  const ty3 = String(view.simContext?.gameData?.get?.(b3.t)?.type || "");
                  if (["decoration", "enemy", "trap", "immovable",
                    "placeholder", "mushroom"].includes(ty3)) continue;
                  if ((ty3 === "wall") !== wantWalls) continue;
                  const bp3 = YardRenderer.fromIso(b3.x, b3.y);
                  const d3 = Math.hypot(hp3.x - bp3.x, hp3.y - bp3.y);
                  if (d3 <= 100) out.push({ b: b3, d: d3 });
                }
                return out.sort((x3, y3) => x3.d - y3.d);
              };
              let cands = gather(false);
              if (!cands.length) cands = gather(true);
              if (cands.length && cands[0].b === shot.prevBuilding) cands.shift();
              if (cands.length) {
                shot.glaives--;
                shot.payload *= 0.5;
                shot.prevBuilding = shot.building;
                shot.building = cands[0].b;
                shot.done = false;
                continue;
              }
            }
            continue;
          }
          const live = shot.victim && !shot.victim.dead
            && view.renderer.penEntities.includes(shot.victim);
          if (live && shot.payload) {
            if (shot.payload < 0) {
              // A heal-ball: restore, clamped at max, green +N popup.
              // FIREBALL's collision cuts any heal to 10% when the
              // target's creatureID starts with "G" - champions only
              // ever receive a tenth of a heal ball's value.
              const tgt = shot.victim;
              let healRaw = -shot.payload;
              if (String(tgt.baseId || "")[0] === "G") healRaw *= 0.1;
              const amount = Math.min(healRaw,
                Math.max(0, (tgt.maxHp ?? 1) - (tgt.hp ?? 0)));
              if (amount > 0) {
                tgt.hp = (tgt.hp ?? 0) + amount;
                pushPopup(sim, tgt, amount, now, { heal: true });
              }
            } else if (shot.victim.defender) {
              hurtDefender(view, sim, shot.victim, shot.payload, now);
            } else {
              dealDamage(view, sim, shot.victim, shot.payload, now);
            }
          }
          continue;
        }
        shot.at = { x: shot.at.x + (dx / dd) * step2,
          y: shot.at.y + (dy / dd) * step2 };
        continue;
      }
      if (shot.kind === "shot") {
        // PROJECTILE.Tick removes the round the instant its target dies -
        // cannon shells and flak missiles simply wink out mid-flight, no
        // impact, no splash. (FIREBALL-backed magma keeps flying: its
        // dead-creep check is only `!this._targetCreep`, so it homes to
        // the corpse and detonates. Spurtz rounds fly to a fixed POINT
        // and never had a target to lose.)
        if (shot.vanish
          && (shot.target?.dead || !view.renderer.penEntities.includes(shot.target))) {
          shot.done = true;
          shot.hitAt = -Infinity;   // no impact flash for a removed round
          continue;
        }
        // PROJECTILE.Move / FIREBALL.Move: half-maxSpeed steps, heading
        // refreshed every 5 ticks, impact inside one maxSpeed of the
        // destination.
        const at = shot.dest || shot.lastAt || shot.from;
        const ticks = dt / TOWER_TICK_MS;
        shot.aimAge = (shot.aimAge ?? Infinity) + ticks;
        if (shot.aimAge >= 5 || !shot.aim) {
          shot.aimAge = 0;
          const d = Math.max(1, Math.hypot(at.x - shot.tmp.x, at.y - shot.tmp.y));
          shot.aim = { x: (at.x - shot.tmp.x) / d, y: (at.y - shot.tmp.y) / d };
        }
        const step = shot.speed * 0.5 * ticks;
        shot.tmp.x += shot.aim.x * step;
        shot.tmp.y += shot.aim.y * step;
        const remaining = Math.hypot(at.x - shot.tmp.x, at.y - shot.tmp.y);
        if (remaining <= shot.speed) {
          shot.done = true;
          shot.hitAt = now;
          towerApplyHit(view, sim, shot, now);
        }
        continue;
      }
      if (shot.kind === "beam-red") {
        // The beam is AUTONOMOUS: LASER holds no monster reference, so it
        // lives its full 100 ticks even when the target dies under it.
        // LASER.Splash pulses every 8TH tick at the WHIP POINT - a monster
        // only cooks while the beam is actually over it - dealing
        // damage * 0.5 * (splash - dist)/splash with NO damage/5 floor
        // and NO _damageMult, distances in cartesian grid space exactly
        // like getCreepsInRange.
        while (now >= shot.nextTick && shot.nextTick < shot.until) {
          const tickAt = shot.nextTick;
          shot.nextTick += LASER_PULSE_TICKS * TOWER_TICK_MS;
          const end = laserSweepPoint(shot, tickAt);
          const ec = YardRenderer.fromIso(end.x, end.y);
          const radius = Math.max(1, Number(shot.splash) || 40);
          const base = Number(shot.damage) || 0;
          for (const ent of view.renderer.penEntities || []) {
            if (!ent.flung || ent.dead) continue;
            if (!towerCanTarget(shot.towerType, ent)) continue;
            const p = YardRenderer.fromIso(ent.x, ent.y);
            const dd = Math.hypot(ec.x - p.x, ec.y - p.y);
            if (dd > radius) continue;
            // Plain modifyHealth: no floor, no _damageMult - but the
            // armorProperty scaling inside modifyHealth still applies.
            dealDamage(view, sim, ent, base * 0.5 * (radius - dd) / radius, now);
          }
          view.renderer.penEntities = view.renderer.penEntities
            .filter((e) => !(e.flung && e.dead));
        }
        // Every 16th tick the whip drops an EFFECTS.Burn scorch mark - the
        // same battle decals the yard renderer already draws (capped so a
        // long fight cannot flood the list).
        while (now >= shot.nextScorch && shot.nextScorch < shot.until) {
          const markAt = laserSweepPoint(shot, shot.nextScorch);
          shot.nextScorch += LASER_SCORCH_TICKS * TOWER_TICK_MS;
          const fx = view.renderer.effects;
          if (Array.isArray(fx)) {
            fx.push({ x: markAt.x, y: markAt.y });
            if (fx.length > 200) fx.splice(0, fx.length - 200);
          }
        }
        if (now >= shot.until) shot.done = true;
        continue;
      }
      if (now >= shot.hitAt) {
        // Tesla mid-burst retarget, per BUILDING25.TickFast: the bolt
        // whose lock just died STILL discharges - the lightning arcs to
        // the corpse (the dead reference persists; modifyHealth on zero
        // health is a no-op) - and only THEN does FindTargets(1) look for
        // a replacement, nearest-first and RANGE-LIMITED. The new lock
        // takes over from the next bolt on; if nothing legal stands in
        // range the burst ends with the wind-down (remaining bolts
        // cancelled), never arcing across the yard.
        if (shot.kind === "beam-tesla") {
          if (shot.burst?.cancelled) {
            shot.done = true;
            shot.hitAt = -Infinity;
            continue;
          }
          const gone = (e) => !e || e.dead
            || !view.renderer.penEntities.includes(e);
          if (gone(shot.target) && shot.burst?.newTarget
            && !gone(shot.burst.newTarget)) {
            shot.target = shot.burst.newTarget;   // adopt the burst's re-lock
            shot.lastAt = { x: shot.target.x, y: shot.target.y };
          }
          if (gone(shot.target)) {
            // This bolt fires at the corpse: drawn to lastAt, deals 0.
            let best = null;
            let bestDist = Infinity;
            const o = shot.towerAt
              || YardRenderer.fromIso(shot.from.x, shot.from.y);
            const maxR = Number(shot.range) || Infinity;
            for (const ent of flung) {
              if (ent.dead || !towerCanTarget(shot.towerType, ent)) continue;
              const p = YardRenderer.fromIso(ent.x, ent.y);
              const dist = Math.hypot(o.x - p.x, o.y - p.y);
              if (dist <= maxR && dist < bestDist) { best = ent; bestDist = dist; }
            }
            if (shot.burst) {
              if (best) shot.burst.newTarget = best;
              else shot.burst.cancelled = true;
            }
            shot.done = true;   // hitAt stays: the corpse bolt still renders
            continue;
          }
        }
        shot.done = true;
        towerApplyHit(view, sim, shot, now);
      }
    }
    sim.shots = sim.shots.filter((shot) =>
      (!shot.done || now - shot.hitAt < (shot.kind === "quake" ? 1000 : 220))
      || now < (shot.until || 0));
    sim.deaths = sim.deaths.filter((d) => now - d.bornAt < 700);
    sim.digs = (sim.digs || []).filter((d) => now - d.bornAt < d.life);
    sim.popups = sim.popups.filter((p) => now - p.bornAt < POPUP_LIFE_MS);

    view.renderer.invalidate();
    // Towers keep watch as long as anything flung still stands.
    sim.effectsRaf = requestAnimationFrame(step);
  };
  sim.effectsRaf = requestAnimationFrame(step);
}

// The per-frame engine: advances tweens, converts landings into damage plus
// ground debris (pebbles play their 20-frame hit animation first), and asks
// the renderer to repaint. Stops itself once the sky is clear - the debris
// needs no further frames.
function startBombLoop(view) {
  const sim = view.attackSim;
  if (!sim || sim.fxRaf) return;
  const step = () => {
    sim.fxRaf = 0;
    if (view.attackSim !== sim || !view.renderer) return;
    const now = performance.now();
    let busy = false;
    for (const fx of sim.activeBombs) {
      for (const particle of fx.particles) {
        if (particle.landed) continue;
        if (now < particle.startAt + particle.duration) { busy = true; continue; }
        particle.landed = true;
        if (fx.kind === "putty") {
          bombApplyEnrage(view, fx);
        } else {
          bombApplyDamage(view, fx);
        }
        if (fx.kind === "pebble") {
          sim.debris.push({ kind: "pebblehit", at: particle.land,
            variation: Math.floor(Math.random() * 4), bornAt: now });
          busy = true; // the hit animation still wants frames
        } else if (fx.kind === "putty") {
          // The landed putty is NOT the flying blob: the sheet's 15 columns
          // are the splat spreading out, and the ground keeps the final,
          // widest frame - hence the animated entry.
          sim.debris.push({ kind: "puttyhit", at: particle.land,
            variation: particle.variation, bornAt: now });
          busy = true;
        } else {
          sim.debris.push({ kind: fx.kind, at: particle.land,
            variation: particle.variation, landedRow: 1 });
        }
      }
    }
    sim.activeBombs = sim.activeBombs.filter(
      (fx) => fx.particles.some((particle) => !particle.landed));
    // Pebble impacts animate for a second after the last landing.
    if (sim.debris.some((d) => (d.kind === "pebblehit" || d.kind === "puttyhit")
      && now - d.bornAt < 20 * PEBBLE_HIT_FRAME_MS)) {
      busy = true;
    }
    view.renderer.invalidate();
    if (busy || sim.activeBombs.length) {
      sim.fxRaf = requestAnimationFrame(step);
    }
  };
  sim.fxRaf = requestAnimationFrame(step);
}

// DROPZONE ring1, drawn as the vector it is in the SWF: a radial gradient
// from the frame colour at alpha 12/255 in the centre to 64/255 at the
// edge, under a 1-twip hairline outline (hairlines stay one pixel at any
// scale in Flash, hence lineWidth / zoom). Update() sizes the ring to
// _size * 1.2 wide - so semi-axes of 0.6 and 0.3 times the radius - and the
// gradient keeps a Giant putty's 700 zone as crisp as a Small twig's.
function drawDropZoneRing(ctx, view, at, radius, valid) {
  const rx = radius * 0.6;
  const ry = radius * 0.3;
  const colour = valid ? "255, 255, 255" : "255, 0, 0";
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.scale(1, ry / rx);
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  grad.addColorStop(0, `rgba(${colour}, ${12 / 255})`);
  grad.addColorStop(1, `rgba(${colour}, ${64 / 255})`);
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineWidth = 1 / (view.renderer?.camera?.zoom || 1);
  ctx.strokeStyle = `rgba(${colour}, 1)`;
  ctx.stroke();
  ctx.restore();
}

// The renderer's simOverlay: debris in the mcbottom slot, flying particles
// and the aiming drop zone in the mctop slot. Both run inside the camera
// transform, so everything scales and pans with the yard.
function makeBombOverlay(view) {
  const sheets = bombSheets();
  const blit = (ctx, sheet, variation, frame, x, y) => {
    if (!sheet.img.complete || !sheet.img.naturalWidth) return;
    ctx.drawImage(sheet.img,
      (frame ?? variation) * sheet.w, (frame != null ? variation : 0) * sheet.h,
      sheet.w, sheet.h,
      x + sheet.ox, y + sheet.oy, sheet.w, sheet.h);
  };
  return {
    drawGround: (ctx) => {
      const sim = view.attackSim;
      if (!sim) return;
      const now = performance.now();
      for (const d of sim.debris) {
        if (d.kind === "pebblehit") {
          const sheet = sheets.pebblehit;
          const frame = Math.min(sheet.frames - 1,
            Math.floor((now - d.bornAt) / PEBBLE_HIT_FRAME_MS));
          blit(ctx, sheet, d.variation, frame, d.at.x, d.at.y);
        } else if (d.kind === "twigs") {
          const sheet = sheets.twigs;
          // Landed twig art is the sheet's second row.
          ctx.drawImage(sheet.img, d.variation * sheet.w, sheet.h, sheet.w, sheet.h,
            d.at.x + sheet.ox, d.at.y + sheet.oy, sheet.w, sheet.h);
        } else if (d.kind === "puttyhit") {
          const sheet = sheets.putty;
          const frame = Math.min(sheet.frames - 1,
            Math.floor((now - d.bornAt) / PEBBLE_HIT_FRAME_MS));
          blit(ctx, sheet, d.variation, frame, d.at.x, d.at.y);
        } else {
          blit(ctx, sheets.putty, d.variation, null, d.at.x, d.at.y);
        }
      }
    },
    drawAir: (ctx) => {
      const sim = view.attackSim;
      if (!sim) return;
      const now = performance.now();
      // Tower fire: travelling shots interpolate toward their (moving)
      // target; beams flash for ~200ms. Colours by family - cannon-type
      // dark shells, laser red, tesla arc-blue, sniper/railgun white.
      const zoom = view.renderer?.camera?.zoom || 1;
      for (const shot of sim.shots || []) {
        if (now < shot.bornAt) continue;  // scheduled (tesla charge) but not discharged
        // Beams and rounds are DRAWN to the airborne sprite (y - altitude);
        // splash math elsewhere keeps the ground point, as GRID does.
        const at = shot.target && !shot.target.dead
          ? { x: shot.target.x,
              y: shot.target.y - (Number(shot.target.altitude) || 0) }
          : (shot.lastAt || shot.from);
        if (shot.kind === "creep-ball") {
          if (!shot.done) {
            // TYPE_FIREBALL and TYPE_MAGMA both play FIREBALL_CLIP's
            // 3-frame flame (exported from the SWF); magma carries an
            // orange GlowFilter on top. Rezghul spawns his own bitmap
            // projectile in game, so his dark ball stays hand-drawn.
            const fb = sheets.fireball;
            if (shot.ball !== "rez" && fb?.img?.complete && fb.img.naturalWidth) {
              const frame = Math.floor(now / 75) % 3;
              ctx.save();
              if (shot.ball === "magma") {
                ctx.shadowColor = "rgba(255, 144, 0, 0.9)";
                ctx.shadowBlur = 8;
              }
              ctx.drawImage(fb.img, frame * 18, 0, 18, 18,
                shot.at.x - 9, shot.at.y - 9, 18, 18);
              ctx.restore();
            } else {
              const colors = { magma: ["#ff7a26", "#ffd23e"],
                heal: ["#39d353", "#b8ffc4"], rez: ["#6a3fa0", "#c9a6f2"] };
              const [core, glow] = colors[shot.ball] || colors.magma;
              ctx.save();
              ctx.fillStyle = core;
              ctx.beginPath();
              ctx.arc(shot.at.x, shot.at.y, 5, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = glow;
              ctx.beginPath();
              ctx.arc(shot.at.x - 1, shot.at.y - 1, 2.2, 0, Math.PI * 2);
              ctx.fill();
              ctx.restore();
            }
          } else if (now - shot.hitAt < 180) {
            const f = (now - shot.hitAt) / 180;
            ctx.save();
            ctx.globalAlpha = 1 - f;
            ctx.strokeStyle = shot.ball === "heal" ? "#39d353"
              : shot.ball === "rez" ? "#6a3fa0" : "#ff7a26";
            ctx.beginPath();
            ctx.arc(shot.at.x, shot.at.y, 4 + f * 10, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
          continue;
        }
        if (shot.kind === "creep-shot") {
          // A monster's ranged bolt: brief pale tracer from muzzle to mark.
          if (now < (shot.until || 0)) {
            const f = (now - shot.bornAt) / 160;
            const a2 = YardRenderer.fromIso(shot.from.x, shot.from.y);
            const b2 = YardRenderer.fromIso(shot.dest.x, shot.dest.y);
            void a2; void b2;
            ctx.save();
            ctx.globalAlpha = Math.max(0, 1 - f);
            ctx.strokeStyle = "#f4edd6";
            ctx.lineWidth = 1.6 / zoom;
            ctx.beginPath();
            ctx.moveTo(shot.from.x, shot.from.y);
            ctx.lineTo(shot.dest.x, shot.dest.y);
            ctx.stroke();
            ctx.restore();
          }
          continue;
        }
        if (shot.kind === "korath-ring" && now < (shot.until || 0)) {
          const f = Math.min(1, (now - shot.bornAt) / 1000);
          const r = 20 + (shot.outer - 20) * f;
          ctx.save();
          ctx.globalAlpha = 0.5 * (1 - f);
          ctx.strokeStyle = "#f28800";
          ctx.lineWidth = 1.2 / zoom;
          ctx.shadowColor = "rgba(255, 108, 0, 0.9)";
          ctx.shadowBlur = 20;
          for (const k of [1, 0.8, 0.6]) {
            ctx.beginPath();
            ctx.ellipse(shot.at.x, shot.at.y, r * k, r * k * 0.5,
              0, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
          continue;
        }
        if (shot.kind === "rail" && now - shot.bornAt < 220) {
          // BUILDING118's ray: white core with the cyan glow, full length.
          const f = (now - shot.bornAt) / 220;
          ctx.save();
          // BUILDING118 lays its 50 gunball segments in raw stage space -
          // the damage ray and the visible ray are the SAME 1600px line,
          // no space conversion.
          const a = shot.rayFromW;
          const b2 = shot.rayEndW;
          ctx.globalAlpha = 1 - f;
          ctx.lineWidth = 6 / zoom;
          ctx.strokeStyle = "rgba(0, 136, 187, 0.5)";
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b2.x, b2.y); ctx.stroke();
          ctx.lineWidth = 1.5 / zoom;
          ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b2.x, b2.y); ctx.stroke();
          ctx.restore();
        } else if (shot.kind === "quake" && !shot.done) {
          // The wind-up: a ring tightening onto the tower until the slam.
          const f = Math.min(1, (now - shot.bornAt) / Math.max(1, shot.hitAt - shot.bornAt));
          ctx.save();
          ctx.globalAlpha = 0.35 + 0.4 * f;
          ctx.lineWidth = 2 / zoom;
          ctx.strokeStyle = "rgba(200, 120, 40, 0.9)";
          ctx.beginPath();
          ctx.ellipse(shot.from.x, shot.from.y, shot.range * (1 - f * 0.7) * 0.6,
            shot.range * (1 - f * 0.7) * 0.3, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        } else if (shot.kind === "quake" && shot.done
          && now - shot.hitAt < 1000) {
          // QuakeGraphic, on the slam: three nested grey ellipses (widths
          // 1.0 / 0.8 / 0.6 of the ring) with a green glow, tweened out to
          // range * 2 wide over one second while fading to nothing.
          const f = (now - shot.hitAt) / 1000;
          const rx = 20 + (shot.range - 20) * f;
          ctx.save();
          ctx.globalAlpha = 0.5 * (1 - f);
          ctx.lineWidth = 1 / zoom;
          ctx.strokeStyle = "rgb(102, 102, 102)";
          ctx.shadowColor = "rgb(51, 143, 74)";
          ctx.shadowBlur = 12 * zoom;
          for (const s of [1, 0.8, 0.6]) {
            ctx.beginPath();
            ctx.ellipse(shot.from.x, shot.from.y, rx * s, rx * s * 0.5,
              0, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        } else if (shot.kind === "shot" && !shot.done) {
          // The round sits wherever PROJECTILE.Move has integrated it to -
          // straight homing flight, no arc, per the class.
          const x = shot.tmp?.x ?? shot.from.x;
          const y = shot.tmp?.y ?? shot.from.y;
          if (shot.spurtz) {
            // SpurtzCannon fires actual Spurtz: the monster's own sprite
            // flies, spinning as it goes.
            // scaleDisplayObjectRandomly: each round carries its own
            // 0.4..1.0 scale - the mid-air sprite must wear it, since the
            // impact AoE is sized from the same number.
            const sc = (shot.spScale || 0.7) * 0.8;
            const sp = sheets.spurtzp;
            if (sp.img.complete && sp.img.naturalWidth) {
              ctx.save();
              ctx.translate(x, y);
              ctx.rotate(((now - shot.bornAt) / 90) % (Math.PI * 2));
              ctx.drawImage(sp.img, -22.5 * sc, -20 * sc, 45 * sc, 40 * sc);
              ctx.restore();
            } else {
              ctx.beginPath(); ctx.arc(x, y, 5 * sc, 0, Math.PI * 2);
              ctx.fillStyle = "#67c832"; ctx.fill();
            }
          } else if (shot.magma) {
            // FIREBALL (magma): a molten ball - white-hot core inside the
            // orange gradient, additive, with a short cooling trail.
            ctx.save();
            ctx.globalCompositeOperation = "lighter";
            const aimv = shot.aim || { x: 0, y: 0 };
            for (let i = 1; i <= 3; i++) {
              ctx.beginPath();
              ctx.arc(x - aimv.x * i * 5, y - aimv.y * i * 5, Math.max(0.5, 3.5 - i * 0.9), 0, Math.PI * 2);
              ctx.fillStyle = `rgba(255, 122, 30, ${0.35 - i * 0.09})`;
              ctx.fill();
            }
            const ball = ctx.createRadialGradient(x, y, 0, x, y, 5);
            ball.addColorStop(0, "rgba(255, 240, 200, 1)");
            ball.addColorStop(0.5, "rgba(255, 140, 30, 0.9)");
            ball.addColorStop(1, "rgba(255, 80, 10, 0)");
            ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fillStyle = ball; ctx.fill();
            ctx.restore();
          } else {
            // PROJECTILES.Spawn feeds the sniper and the cannon the SAME
            // PROJECTILE_CLIP art - one dark shell with a highlight, no
            // special tracer for the sniper.
            ctx.beginPath();
            ctx.arc(x, y, 4.5, 0, Math.PI * 2);
            ctx.fillStyle = "#2b2b2b";
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x - 1.2, y - 1.2, 1.4, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
            ctx.fill();
          }
        } else if (shot.kind === "beam-red" && now < (shot.until || 0)) {
          // LASER.Tick, ported whole: the whipping beam. The end point
          // orbits the origin - angle advancing (4/sqrt(dist))/2 per tick,
          // radius breathing by dist/20 - so the beam sweeps across its
          // victim rather than pinning it. Colours verbatim: warm-white
          // 0xF4EDDD core whose 30 segments pulse 3 +- sin thickness, all
          // inside the deep red-orange 0xCB270B glow; orange 0xFC9D33
          // blobs at both ends; alpha follows the power ramp (a tenth per
          // tick up, down past tick 80).
          const ticks = (now - shot.bornAt) / TOWER_TICK_MS;
          const power = Math.max(0, Math.min(1, Math.min(ticks, 100 - ticks) / 10));
          const end = laserSweepPoint(shot, now);
          const base = { x: shot.from.x, y: shot.from.y };
          ctx.save();
          ctx.globalAlpha = power;
          // the game's GlowFilter(0xCB270B, blur 20, strength 4) reads as
          // a broad soft red-orange sheath around the core - drawn here as
          // a wide under-stroke with a heavy shadow pass
          ctx.shadowColor = "rgb(203, 39, 11)";
          ctx.shadowBlur = 20 * zoom;
          ctx.lineWidth = 7 / zoom;
          ctx.strokeStyle = "rgba(203, 39, 11, 0.55)";
          ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(end.x, end.y); ctx.stroke();
          ctx.shadowBlur = 12 * zoom;
          // segmented core with pulsing thickness (3 +- sin, widened to read
          // at yard zoom the way the filtered original does)
          for (let i = 1; i <= 30; i++) {
            const t0 = (i - 1) / 30;
            const t1 = i / 30;
            ctx.lineWidth = Math.max(1.2, 4 + Math.sin(i / 3 - now / 70) * 1.5) / zoom;
            ctx.strokeStyle = "rgb(244, 237, 221)";
            ctx.beginPath();
            ctx.moveTo(base.x + (end.x - base.x) * t0, base.y + (end.y - base.y) * t0);
            ctx.lineTo(base.x + (end.x - base.x) * t1, base.y + (end.y - base.y) * t1);
            ctx.stroke();
          }
          ctx.shadowBlur = 0;
          ctx.globalAlpha = power / 2;
          ctx.fillStyle = "rgb(252, 157, 51)";
          ctx.beginPath(); ctx.ellipse(end.x, end.y, 8, 4, 0, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(base.x, base.y, 4, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = power;
          ctx.fillStyle = "rgb(244, 237, 221)";
          ctx.beginPath(); ctx.arc(base.x, base.y, 2.5, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        } else if (shot.kind !== "shot" && now - shot.bornAt < 200) {
          ctx.save();
          if (shot.kind === "beam-tesla") {
            // EFFECTS.Lightning verbatim: a 1px polyline in 0x30C8FA with a
            // vertex every 30px, each jittered -7..+8, the final one -5..+5
            // by 0..-10, wrapped in GlowFilter(colour, 1, 4, 4, 2, 2) and
            // composited additively.
            ctx.globalCompositeOperation = "lighter";
            // One Lightning clip per discharge: the jagged path rolls once
            // at first draw and holds its shape while it fades - exactly
            // one bolt per shot fired.
            if (!shot.boltPts) {
              const dist = Math.hypot(at.x - shot.from.x, at.y - shot.from.y);
              const segs = Math.max(1, Math.trunc(dist / 30));
              const p = [[shot.from.x, shot.from.y]];
              for (let i = 1; i < segs; i++) {
                const t = i / segs;
                p.push([shot.from.x + (at.x - shot.from.x) * t - 7 + Math.random() * 15,
                  shot.from.y + (at.y - shot.from.y) * t - 7 + Math.random() * 15]);
              }
              p.push([at.x - 5 + Math.random() * 10, at.y - Math.random() * 10]);
              shot.boltPts = p;
            }
            const pts = shot.boltPts;
            const bolt = () => {
              ctx.beginPath();
              ctx.moveTo(pts[0][0], pts[0][1]);
              for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
              ctx.stroke();
            };
            // A lightning arc is a flash, not a lingering line: a few
            // stage frames (~80ms) with a quadratic falloff, so it snaps
            // bright and is gone before the next discharge 100ms later.
            const boltAge = now - shot.bornAt;
            if (boltAge <= 80) {
              const fade = 1 - boltAge / 80;
              ctx.globalAlpha = Math.max(0.02, fade * fade);
              ctx.strokeStyle = "rgb(48, 200, 250)";
              ctx.shadowColor = "rgb(48, 200, 250)";
              ctx.shadowBlur = 4 * zoom;
              ctx.lineWidth = 1 / zoom;
              bolt(); bolt();   // strength 2: two glow passes
            }
          } else {
            ctx.lineWidth = 1.5 / zoom;
            ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
            ctx.beginPath();
            ctx.moveTo(shot.from.x, shot.from.y);
            ctx.lineTo(at.x, at.y);
            ctx.stroke();
          }
          ctx.restore();
        }
        if (shot.done && now - shot.hitAt < 220) {
          const f = (now - shot.hitAt) / 220;
          ctx.beginPath();
          ctx.arc(at.x, at.y, 4 + f * 10, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 190, 90, ${0.5 * (1 - f)})`;
          ctx.fill();
        }
      }
      // AcidOnDeath puddles: the game draws a code Shape -
      // beginFill(0x00FF00, 0.5) - fading out over the last seconds.
      for (const a of sim.acids || []) {
        const left = (a.until - now) / 10000;
        ctx.save();
        ctx.globalAlpha = 0.5 * Math.min(1, Math.max(0, left * 3));
        ctx.fillStyle = "#00FF00";
        ctx.beginPath();
        ctx.ellipse(a.x, a.y, a.radius, a.radius * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      // Dirt chunks from Dig/Burrow: the ParticlesObject art exported
      // from the SWF, popping up and settling with a quick fade.
      const dirtSheet = sheets.dirt;
      for (const d of sim.digs || []) {
        const f = Math.min(1, (now - d.bornAt) / d.life);
        const rise = Math.sin(Math.min(1, f * 1.6) * Math.PI) * 6;
        ctx.save();
        ctx.globalAlpha = 0.9 * (1 - f);
        if (dirtSheet?.img?.complete && dirtSheet.img.naturalWidth) {
          const w = 13 * d.scale;
          const h = 9 * d.scale;
          ctx.drawImage(dirtSheet.img, d.x - w / 2, d.y - rise - h / 2, w, h);
        } else {
          ctx.fillStyle = "#6b4a2b";
          ctx.beginPath();
          ctx.arc(d.x, d.y - rise, 2.5 * d.scale, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      // Where a monster fell: a brief fading ring.
      for (const d of sim.deaths || []) {
        const f = Math.min(1, (now - d.bornAt) / 700);
        ctx.beginPath();
        ctx.ellipse(d.at.x, d.at.y, 8 + f * 8, (8 + f * 8) * 0.5, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(120, 20, 20, ${0.6 * (1 - f)})`;
        ctx.lineWidth = 1.5 / zoom;
        ctx.stroke();
      }
      // (No burn flicker: the magma tower's FlameEffect never fires in
      // this client build, so nothing in the sim smoulders.)
      // Flame brand: the game parks an animated effects/flame_icon.png
      // over a FlameEffect victim. That sheet is CDN-only, so a small
      // procedural two-tone flicker stands in above the sprite.
      for (const ent of view.renderer?.penEntities || []) {
        if (ent.dead || ent.burrowed || !(Number(ent.flameDps) > 0)) continue;
        const topY = ent.y - (ent.sheet?.[4] ?? 30)
          - (Number(ent.altitude) || 0) - 4;
        const flick = 0.75 + 0.25 * Math.sin(now / 60 + ent.x);
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = "#ff7a26";
        ctx.beginPath();
        ctx.ellipse(ent.x, topY, 2.6, 4.2 * flick, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffd23e";
        ctx.beginPath();
        ctx.ellipse(ent.x, topY + 1, 1.3, 2.2 * flick, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      // (Monster health bars are drawn by the yard renderer's
      // drawMonsterHealthBar - the real 12-state strip baked into the
      // sprite pass, riding altitude and the surface bounce - so the
      // overlay stays out of it. Drawing them here too doubled the bar
      // and parked a second copy at ground height under every flyer.)
      // Floating damage numbers: red bold digits rising ~14px and fading
      // over 0.8s at the point of impact.
      for (const p of sim.popups || []) {
        // ParticleDamageItem.Move: 25px rise over 0.5s, Cubic.easeInOut,
        // then gone - the game never fades these. The bold #FF0000 number
        // sits over a black copy (tLootB), rebuilt here as a stroke.
        const f = Math.min(1, (now - p.bornAt) / POPUP_LIFE_MS);
        const ease = f < 0.5 ? 4 * f * f * f : 1 - ((-2 * f + 2) ** 3) / 2;
        const y = p.at.y - ease * POPUP_RISE_PX;
        ctx.save();
        ctx.font = "bold 10px Verdana, sans-serif";
        ctx.textAlign = "center";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
        let label = (p.sign || (p.heal ? "+" : "")) + p.amount;
        if (p.absorbed) {
          label += `(${p.absorbed > 0 ? "-" : "+"}${Math.abs(p.absorbed)})`;
        }
        ctx.strokeText(label, p.at.x, y);
        ctx.fillStyle = p.color || (p.heal ? "#00ff00" : "#FF0000");
        ctx.fillText(label, p.at.x, y);
        ctx.restore();
      }
      for (const fx of sim.activeBombs) {
        const sheet = sheets[fx.kind];
        for (const particle of fx.particles) {
          if (particle.landed || now < particle.startAt) continue;
          // Sine.easeIn, as TweenLite runs it.
          const t = Math.min(1, (now - particle.startAt) / particle.duration);
          const eased = 1 - Math.cos(t * Math.PI / 2);
          const x = particle.start.x + (particle.land.x - particle.start.x) * eased;
          const y = particle.start.y + (particle.land.y - particle.start.y) * eased;
          blit(ctx, sheet, particle.variation, null, x, y);
        }
      }
      // The flinger's GROUND drop zone: up whenever the bucket holds
      // monsters and no bomb has taken the cursor over (loading the bucket
      // cancels an armed bomb, as BucketUpdate does). GROUND semantics are
      // the bomb's inverse: white over clear ground, red when the zone
      // overlaps a building - the game refuses to Spawn over buildings; the
      // sim colours the warning but flings anyway, like the bombs.
      if (!sim.bombArmed && sim.aim) {
        const zone = flingZoneSize(sim);
        if (zone > 0) {
          const blocked = bombTargets(view.renderer, view.simContext?.gameData,
            sim.aim, zone).length > 0;
          drawDropZoneRing(ctx, view, sim.aim, zone, !blocked);
        }
      }
      // ATTACK.DropZone riding the cursor while armed - the SWF's own ring
      // art at the SWF's own size: DROPZONE.Update sets ring1.width to
      // _size * 1.2, where _size is the bomb RADIUS, so the visible ellipse
      // is radius*1.2 wide by radius*0.6 tall - deliberately smaller than
      // the damage sweep, since particles land within radius/2 of the
      // centre. Frame choice mirrors Follow()'s BUILDINGS branch: white
      // while the blast would touch something, red over empty ground. (The
      // game also refuses to Drop() off-target; the sim fires anyway.)
      if (sim.bombArmed && sim.aim) {
        const bomb = SIM_BOMBS.find((entry) => entry.id === sim.bombArmed);
        if (bomb) {
          const onTarget = bombTargets(view.renderer, view.simContext?.gameData,
            sim.aim, bomb.radius).length > 0;
          drawDropZoneRing(ctx, view, sim.aim, bomb.radius, onTarget);
        }
      }
    },
  };
}

const BETA_WARN_KEY = "bymViewerAttackBetaWarned";

// A dismissible beta notice floated over the yard when an attack starts:
// the sim runs behind it immediately, the notice just sets expectations.
function showAttackBetaWarning(backdrop) {
  try {
    if (window.localStorage?.getItem(BETA_WARN_KEY) === "1") return;
  } catch { /* storage may be unavailable; always show */ }
  if (backdrop.querySelector(".atk-beta-warning")) return;
  const box = document.createElement("div");
  box.className = "atk-beta-warning";
  box.innerHTML = `
    <div class="atk-beta-title">Attack Simulation &mdash; BETA</div>
    <div class="atk-beta-body">
      This is a cosmetic recreation of attacking and is still under
      construction. Things will not work exactly as in game. Not
      implemented yet:
      <ul>
        <li>Monster pathing &mdash; monsters wander instead of routing around walls</li>
        <li>Monsters do not attack buildings, and buildings take no siege damage</li>
        <li>Released defenders and champions cannot be hurt and use no abilities</li>
        <li>Chaos weapons (jars, decoy, vacuum) are cosmetic only</li>
        <li>Booby traps and heavy traps do not trigger</li>
        <li>No sounds, looting, or battle report</li>
      </ul>
      Tower targeting, damage, fire rates and animations are traced from
      the game client and should match closely.
    </div>
    <label class="atk-beta-skip"><input type="checkbox"> Don't show this again</label>
    <button type="button" class="game-button atk-beta-ok">Got it</button>`;
  const shell = backdrop.querySelector(".base-view-canvas-shell") || backdrop;
  shell.appendChild(box);
  box.querySelector(".atk-beta-ok")?.addEventListener("click", () => {
    if (box.querySelector(".atk-beta-skip input")?.checked) {
      try { window.localStorage?.setItem(BETA_WARN_KEY, "1"); } catch { /* ignore */ }
    }
    box.remove();
  });
}

function enterSimulatedAttack(backdrop, view) {
  const ctx = view?.simContext;
  if (!ctx || view.attackSim) return;
  const hud = backdrop.querySelector(".base-view-hud");
  if (!hud) return;
  showAttackBetaWarning(backdrop);

  // Everything the view mode had put up comes down: the HUD is replaced
  // wholesale below, and the outpost picker menu - which hangs off the
  // backdrop, not the HUD - is closed the way switching UI_TOP frames
  // closes it in game.
  backdrop.querySelector(".hud-base-menu")?.remove();

  const isInferno = Boolean(ctx.isInferno);
  const roster = buildSimRoster(isInferno);
  const sim = {
    bucket: Object.create(null),      // ATTACK._flingerBucket
    available: Object.create(null),   // ATTACK._curCreaturesAvailable
    capacity: flingerCapacityFrom(ctx.gameData),
    holdTimer: 0,
    // catapult state: ResourceBombs' _state, plus the shower in the air
    activeBombs: [],
    debris: [],
    origHealth: new Map(),
    aim: null,
    fxRaf: 0,
    effectsRaf: 0,
    towers: new Map(),   // per-tower fire state (BTOWER._fireTick + lock)
    shots: [],           // projectiles and beams in the air
    deaths: [],          // fading marks where monsters fell
    digs: [],            // dirt chunks from burrowers digging/surfacing
    acids: [],           // Project X's AcidOnDeath puddles
    // BASE._resources during the attack: every loot draw deducts here,
    // seeded from the base load's resource fields.
    lootPool: (() => {
      const r = view.simContext?.resources || {};
      return { r1: Number(r.r1) || 0, r2: Number(r.r2) || 0,
        r3: Number(r.r3) || 0, r4: Number(r.r4) || 0 };
    })(),
    popups: [],          // floating damage numbers
    released: new Set(), // bunkers/cage that have spilled their defenders
  };
  // Infinite stock: every variant of every creature is always available.
  sim.capacity = Infinity;
  view.attackSim = sim;

  // The four resource rows are NOT carried into the fake attack: the game
  // repurposes them as loot counters, but a column of zeroed twig/pebble/
  // putty/goo plates reads as leftover view UI here, so they stay hidden
  // until the sim actually loots something.

  const rowsHtml = roster.map((entry, index) => creatureRowHtml(entry, index));
  const rowCount = roster.length;

  // mcPic: the owner's framed picture stays on the plate in attack mode,
  // exactly as UI_TOP's wmattack branch keeps loading BASE._ownerPic.
  const pic = String(ctx.ownerPic || "").trim();
  const plate = `
    <div class="hud-level" title="${escapeHtml(ctx.plateTitle)}">
      <span class="hud-level-title">${escapeHtml(ctx.plateTitle)}</span>
    </div>
    ${pic.startsWith("http://") || pic.startsWith("https://") ? `
      <div class="hud-visitor-pic"><img class="hud-visitor-photo"
        src="${escapeHtml(pic)}" alt="" referrerpolicy="no-referrer"></div>
      <div class="hud-visitor-frame"></div>` : ""}`;

  // CATAPULTPOPUP + SIEGEWEAPONPOPUP, only off the Inferno
  // (`!BASE.isInfernoMainYardOrOutpost` gates both in setupAttackMode).
  const weapons = isInferno ? "" : `
    <div class="atk-catapult">
      <button type="button" class="atk-iconbtn atk-catapult-toggle" aria-expanded="false">
        <span class="atk-icon-image"
          style="background-image:url('${weaponArtUrl(SIM_BOMBS[0].image)}')"></span>
        <span class="atk-icon-label">Catapult</span>
      </button>
      <div class="atk-catapult-panel" hidden>
        <span class="atk-cat-groups" aria-hidden="true"></span>
        <span class="atk-cat-title tw">${escapeHtml(localize("bomb_tw_name_pl", "Twig Missiles"))}</span>
        <span class="atk-cat-title pb">${escapeHtml(localize("bomb_pb_name_pl", "Pebble Bombs"))}</span>
        <span class="atk-cat-title pu">${escapeHtml(localize("bomb_pu_name", "Putty Rage"))}</span>
        ${SIM_BOMBS.map((bomb) => `
          <button type="button" class="atk-slot" data-bomb="${bomb.id}"
            style="left:${bomb.x}px;top:${bomb.y}px"
            title="${escapeHtml(localize(bomb.name, bomb.fallback))}">
            <span class="atk-slot-image"
              style="background-image:url('${weaponArtUrl(bomb.image)}')"></span>
            <span class="atk-slot-label">${escapeHtml(localize(bomb.name, bomb.fallback))}</span>
          </button>`).join("")}
      </div>
    </div>
    <div class="atk-siege">
      <button type="button" class="atk-iconbtn atk-siege-toggle" aria-expanded="false">
        <span class="atk-icon-image"
          style="background-image:url('${weaponArtUrl(`siegebuttons/${SIM_SIEGE_WEAPONS[0].id}.png`)}')"></span>
        <span class="atk-icon-label atk-siege-label">${escapeHtml(
          localize("chaos_weapons", "Chaos Weapons"))}</span>
      </button>
      <div class="atk-siege-panel" hidden>
        ${SIM_SIEGE_WEAPONS.map((weapon, index) => `
          <button type="button" class="atk-slot" data-weapon="${weapon.id}"
            style="left:${8 + index * 74}px;top:8px"
            title="${escapeHtml(localize(weapon.nameKey, weapon.fallback))}">
            <span class="atk-slot-image"
              style="background-image:url('${weaponArtUrl(`siegebuttons/${weapon.id}.png`)}')"></span>
            <span class="atk-slot-label">${escapeHtml(localize(weapon.nameKey, weapon.fallback))}</span>
          </button>`).join("")}
      </div>
    </div>`;

  hud.classList.add("attack-mode");
  hud.innerHTML = `
    ${plate}
    ${weapons}
    <div class="atk-flinger">
      <div class="atk-flinger-top">
        <span class="atk-flinger-fill"></span>
        <span class="atk-flinger-label">${escapeHtml(
          localize("txt_flinger_capacity", "FLINGER Capacity:").replace(/^>\s*/, ""))}</span>
        <span class="atk-flinger-percent">0%</span>
      </div>
      <div class="atk-scrollwrap">
        <div class="atk-list" style="--atk-rows:${rowCount}">
          <div class="atk-list-inner" style="height:${rowCount * 53 + 1}px">
            ${rowsHtml.join("")}
          </div>
        </div>
        <div class="atk-bottom"></div>
      </div>
    </div>`;
  hud.hidden = false;

  wireAttackPanel(backdrop, view, hud);

  // Catapult firing: an armed bomb turns yard clicks into launches and the
  // cursor drags the drop zone around. The overlay paints through the
  // renderer's own layers, so debris sits under building tops as mcbottom
  // does in game.
  const renderer = view.renderer;
  if (renderer) {
    renderer.simTurretMode = true;   // turrets track their targets, not the cursor
    renderer.simOverlay = makeBombOverlay(view);
    renderer.onYardClick = (point) => {
      const live = view.attackSim;
      if (!live) return false;
      if (live.bombArmed) return fireBomb(backdrop, view, point);
      if (flingZoneSize(live) > 0) return spawnFlungMonsters(backdrop, view, point);
      return false;
    };
    sim.aimMove = (event) => {
      const live = view.attackSim;
      if (!live) return;
      live.aim = renderer.screenToWorld(event);
      if (live.bombArmed || flingZoneSize(live) > 0) renderer.invalidate();
    };
    renderer.canvas.addEventListener("pointermove", sim.aimMove);
  }

  renderVisitorBar(backdrop, view, "attack");
  showYardMessage(backdrop, "Simulation only - nothing you do here is saved.");
}

function wireAttackPanel(backdrop, view, hud) {
  const sim = view.attackSim;
  const flinger = hud.querySelector(".atk-flinger");

  // CREATUREBUTTON.More/Less + MoreTick: one step on press, then after 10
  // ticks a step every 2nd tick (~330ms delay, ~15/sec at the SWF's 30fps).
  // MovedOut / mouse-up ends the repeat. Listeners live on the panel, which
  // End Attack removes with the rest of the markup.
  const stopHold = () => {
    window.clearTimeout(sim.holdTimer);
    window.clearInterval(sim.holdTimer);
    sim.holdTimer = 0;
  };
  flinger?.addEventListener("pointerdown", (event) => {
    const more = event.target.closest(".atk-more");
    const less = event.target.closest(".atk-less");
    const row = event.target.closest(".atk-row");
    if ((!more && !less) || !row) return;
    event.preventDefault();
    const step = () => {
      if (!row.isConnected) { stopHold(); return; }
      simBucketStep(view, hud, simRowKey(view.attackSim, row), more ? 1 : -1);
    };
    step();
    stopHold();
    sim.holdTimer = window.setTimeout(() => {
      sim.holdTimer = window.setInterval(step, 66);
    }, 330);
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
    flinger?.addEventListener(type, stopHold);
  }
  sim.stopHold = stopHold;

  // CHAMPIONBUTTON rows carry the same +/- as everything else here, so the
  // pointerdown handler above covers them too - no separate Send/Retreat.

  // CATAPULTPOPUP.Show / Hide: the icon opens the bomb panel; picking a bomb
  // (or clicking off it) closes it again. Selecting swaps the icon's image
  // and flips the label to the red "Cancel", as downBomb does.
  const catapult = hud.querySelector(".atk-catapult");
  const toggle = catapult?.querySelector(".atk-catapult-toggle");
  const panel = catapult?.querySelector(".atk-catapult-panel");
  const label = catapult?.querySelector(".atk-icon-label");
  const image = catapult?.querySelector(".atk-icon-image");
  sim.catapultLabel = label;
  const closePanel = () => {
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    panel.style.position = "";
    panel.style.left = "";
    panel.style.top = "";
    panel.style.transform = "";
    panel.style.transformOrigin = "";
    toggle?.setAttribute("aria-expanded", "false");
  };
  // The panel's SWF-coordinate children need its 448x330 box intact, but the
  // box itself must escape the bar (whose scroll/scale would clip it - the
  // "dropdown cut off at the toolbar" bug) and must fit a phone screen. So on
  // open it goes position:fixed, scaled to the viewport, preferring the space
  // ABOVE the bottom bar, clamped fully on-screen either way.
  const placePanel = () => {
    if (!panel || !toggle) return;
    const btn = toggle.getBoundingClientRect();
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const scale = Math.min(1, (vw - 16) / 448, (vh - 24) / 330);
    const w = 448 * scale;
    const h = 330 * scale;
    let left = Math.max(8, Math.min(btn.left - 16.5 * scale, vw - w - 8));
    let top = btn.top - h - 8;            // above the bar, as the game opens it
    if (top < 8) top = Math.min(btn.bottom + 8, vh - h - 8);  // no room: below
    panel.style.position = "fixed";
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(Math.max(8, top))}px`;
    panel.style.transformOrigin = "top left";
    panel.style.transform = scale < 1 ? `scale(${scale})` : "";
  };
  sim.closeCatapult = closePanel;
  toggle?.addEventListener("click", () => {
    if (sim.bombArmed) {
      // Second click while armed = Cancel, per CATAPULTPOPUP.Show's
      // ResourceBombs._state branch.
      sim.bombArmed = null;
      if (view.renderer?.canvas) view.renderer.canvas.style.cursor = "grab";
      view.renderer?.invalidate();
      if (label) { label.textContent = "Catapult"; label.classList.remove("armed"); }
      return;
    }
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) placePanel();
  });
  panel?.addEventListener("click", (event) => {
    const slot = event.target.closest(".atk-slot");
    if (!slot) return;
    sim.bombArmed = slot.dataset.bomb;
    if (view.renderer?.canvas) view.renderer.canvas.style.cursor = "crosshair";
    const bomb = SIM_BOMBS.find((entry) => entry.id === sim.bombArmed);
    if (image && bomb) image.style.backgroundImage = `url('${weaponArtUrl(bomb.image)}')`;
    if (label) {
      label.textContent = localize("bomb_cancel", "Cancel");
      label.classList.add("armed");
    }
    closePanel();
  });
  // testMouseOff: moving off the open panel closes it.
  panel?.addEventListener("pointerleave", closePanel);

  // SIEGEWEAPONPOPUP, sim edition: the icon opens a chooser holding all
  // three chaos weapons (the game only ever offers availableWeapon; the sim
  // has no siege factory to read, so the trio is on the menu). Picking one
  // arms it - icon image swaps, label flips to the red Cancel - and a
  // second click on the icon cancels, mirroring the catapult's state cycle.
  const siegeWrap = hud.querySelector(".atk-siege");
  const siegeToggle = siegeWrap?.querySelector(".atk-siege-toggle");
  const siegePanel = siegeWrap?.querySelector(".atk-siege-panel");
  const siegeLabel = siegeWrap?.querySelector(".atk-siege-label");
  const siegeImage = siegeWrap?.querySelector(".atk-icon-image");
  const closeSiege = () => {
    if (!siegePanel || siegePanel.hidden) return;
    siegePanel.hidden = true;
    siegeToggle?.setAttribute("aria-expanded", "false");
  };
  siegeToggle?.addEventListener("click", () => {
    if (sim.siegeArmed) {
      sim.siegeArmed = null;
      if (siegeLabel) {
        siegeLabel.textContent = localize("chaos_weapons", "Chaos Weapons");
        siegeLabel.classList.remove("armed");
      }
      return;
    }
    siegePanel.hidden = !siegePanel.hidden;
    siegeToggle.setAttribute("aria-expanded", String(!siegePanel.hidden));
  });
  siegePanel?.addEventListener("click", (event) => {
    const slot = event.target.closest(".atk-slot");
    if (!slot) return;
    sim.siegeArmed = slot.dataset.weapon;
    const weapon = SIM_SIEGE_WEAPONS.find((entry) => entry.id === sim.siegeArmed);
    if (siegeImage && weapon) {
      siegeImage.style.backgroundImage =
        `url('${weaponArtUrl(`siegebuttons/${weapon.id}.png`)}')`;
    }
    if (siegeLabel) {
      siegeLabel.textContent = localize("bomb_cancel", "Cancel");
      siegeLabel.classList.add("armed");
    }
    closeSiege();
  });
  siegePanel?.addEventListener("pointerleave", closeSiege);
}

// ATTACK.BucketAdd / BucketRemove, cosmetic edition: capacity-checked in,
// stock-checked out, then the row and the bar repaint (Update+BucketUpdate).
// A row's dropdown resolves to the bucket key: "L3" -> C1:L3; "A2" ->
// max level with ability tier 2; "F1" -> champion level 6 with Feed 1.
// The ability/feed tier rides in sim.loadout[baseId] and is stamped onto
// spawned monsters (cosmetic until abilities are simulated).
function simRowKey(sim, row) {
  const baseId = row.dataset.creature;
  const max = Math.max(1, Number(row.dataset.max) || 1);
  const value = row.querySelector(".atk-row-level")?.value || "L1";
  // "L4" plain / "L4A2" level 4 with ability tier 2 / "L6F3" feed 3.
  const m = /^L(\d+)(?:([AF])(\d))?$/.exec(value) || [null, "1"];
  const level = Math.max(1, Math.min(max, Number(m[1]) || 1));
  if (sim) {
    sim.loadout = sim.loadout || Object.create(null);
    if (m[2] === "A") sim.loadout[baseId] = { ability: Number(m[3]) };
    else if (m[2] === "F") sim.loadout[baseId] = { feed: Number(m[3]) };
    else if (sim.loadout[baseId]) delete sim.loadout[baseId];
  }
  return `${baseId}:L${level}`;
}

function simBucketStep(view, hud, id, direction) {
  const sim = view?.attackSim;
  if (!sim || !id) return;
  const cost = creatureBucketCost(id);
  const loaded = Number(sim.bucket[id] || 0);
  if (direction > 0) {
    // Stock is infinite; only the bucket itself can fill (and with
    // capacity Infinity it will not).
    if (simBucketUsed(sim) + cost > sim.capacity) return;
    sim.bucket[id] = loaded + 1;
  } else {
    if (loaded <= 0) return;
    sim.bucket[id] = loaded - 1;
  }
  // BucketUpdate cancels any armed bomb and chaos weapon whenever the
  // bucket changes - the monster drop zone takes the cursor over.
  if (sim.bombArmed) {
    sim.bombArmed = null;
    if (sim.catapultLabel) {
      sim.catapultLabel.textContent = "Catapult";
      sim.catapultLabel.classList.remove("armed");
    }
  }
  view.renderer?.invalidate();
  const baseId = String(id).split(":")[0];
  const row = hud.querySelector(`.atk-row[data-creature="${CSS.escape(baseId)}"]`);
  if (row && simRowKey(sim, row) === id) {
    const nowLoaded = Number(sim.bucket[id] || 0);
    const count = row.querySelector(".atk-row-count");
    if (count) {
      // CREATUREBUTTON.Update: "<red>loaded</red> / available" - the
      // available side is infinite now.
      count.innerHTML = nowLoaded > 0
        ? `<b><span class="atk-loaded">${nowLoaded}</span> / &infin;</b>`
        : `<b>0 / &infin;</b>`;
    }
  }
  simRefreshBar(sim, hud);
}

function simBucketUsed(sim) {
  let used = 0;
  for (const [id, count] of Object.entries(sim.bucket)) {
    used += creatureBucketCost(id) * Number(count || 0);
  }
  return used;
}

// updateAttackMode's MR2 branch: mcBar.scaleX ends up used/capacity, and
// scaleX works on the sprite's NATURAL width - shape 2154 is 167px - so a
// 100% flinger covers 167 of the 192px red strip, leaving the sliver of red
// at the right edge the game leaves too. tA shows the ratio as "N%".
function simRefreshBar(sim, hud) {
  const used = simBucketUsed(sim);
  const ratio = sim.capacity > 0 ? Math.min(1, used / sim.capacity) : 0;
  const fill = hud.querySelector(".atk-flinger-fill");
  if (fill) fill.style.width = `${(ratio * 167).toFixed(1)}px`;
  const percent = hud.querySelector(".atk-flinger-percent");
  if (percent) percent.textContent = `${Math.min(100, Math.floor(ratio * 100))}%`;
}

function exitSimulatedAttack(backdrop, view) {
  const hud = backdrop.querySelector(".base-view-hud");
  const sim = view?.attackSim;
  sim?.stopHold?.();
  // Nothing persists: every building the bombs touched goes back to the
  // health and damage state the save gave it, the shower and debris go with
  // the overlay, and the renderer forgets the click hook.
  if (sim) {
    if (sim.fxRaf) cancelAnimationFrame(sim.fxRaf);
    if (sim.effectsRaf) cancelAnimationFrame(sim.effectsRaf);
    const renderer = view.renderer;
    if (renderer) {
      for (const b of renderer.buildings || []) {
        const orig = sim.origHealth.get(b.id);
        if (orig) { b.hp = orig.hp; b.state = orig.state; }
      }
      // The restored yard is solid again: rebuild the cost grid so the
      // next simulation doesn't route through phantom rubble.
      renderer.buildBlockGrid?.();
      if (sim.aimMove) renderer.canvas?.removeEventListener("pointermove", sim.aimMove);
      renderer.penEntities = (renderer.penEntities || [])
        .filter((ent) => !ent.flung && !ent.defender);
      renderer.simTurretMode = false;
      backdrop.querySelector(".atk-beta-warning")?.remove();
      for (const b of renderer.buildings || []) {
        b.simAim = null;
        b.simAnim = null;
        b.simRot = null;
      }
      if (sim.hiddenChampions?.length) {
        renderer.champions.unshift(...sim.hiddenChampions);
        sim.hiddenChampions = null;
      }
      renderer.simOverlay = null;
      renderer.onYardClick = null;
      renderer.invalidate();
    }
  }
  if (view) view.attackSim = null;
  hud?.classList.remove("attack-mode");
  // Put the view-mode UI back exactly as loadBaseIntoView built it.
  view?.simContext?.restoreViewUi?.();
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

export async function openBaseView({ token, baseid, userid, name, isMain, isWild, isInferno, isOwnYard, outpostList, ownerPic, x, y, terrainHeight, prepare, prepareFor, baseListFor, recoverToken, isAdmin = false }) {
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
      token, baseid, userid, name, isMain, isWild, isInferno, isOwnYard, outpostList, ownerPic, x, y, terrainHeight, prepare, prepareFor, baseListFor, recoverToken, isAdmin,
    });
    return;
  }

  const backdrop = document.createElement("div");
  backdrop.className = "base-view-backdrop";
  backdrop.innerHTML = `
    <div class="base-view-window game-frame frame-mr2" role="dialog" aria-modal="true" aria-label="Base viewer">
      <div class="base-view-header">
        <span class="base-view-title">${escapeHtml(buildBaseTitle(name, isMain, x, y, isWild, isInferno))}</span>
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
    token, baseid, userid, name, isMain, isWild, isInferno, isOwnYard, outpostList, ownerPic, x, y, terrainHeight, prepare, prepareFor, baseListFor, recoverToken, isAdmin,
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
  token, baseid, userid, name, isMain, isWild, isInferno, isOwnYard, outpostList, ownerPic, x, y, terrainHeight, prepare, prepareFor, baseListFor, recoverToken, isAdmin,
}) {
  // Retry re-runs the whole thing, prepare included - so it refreshes the
  // zone and re-resolves the base id rather than replaying a stale one.
  const retryArgs = {
    token, baseid, userid, name, isMain, isWild, isInferno, isOwnYard, outpostList,
    ownerPic, x, y, terrainHeight, prepare, prepareFor, baseListFor, recoverToken,
  };
  const current = () => activeView === view && view.generation === generation;

  // Optional prepare step: the caller reloads the cell's zone from the game
  // server first, then hands back the freshly observed base id + owner name.
  let resolvedBaseid = baseid;
  let resolvedName = "";
  // Inferno has no cell and no base id - the server reads the player's own
  // infernosave - so the whole resolve step is skipped.
  if (typeof prepare === "function" && !isInferno) {
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
  if (!isInferno && (!resolvedBaseid || resolvedBaseid === "0")) {
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
      loadGameDataFor(isInferno ? "inferno" : (isMain || isWild ? "main" : "outpost")),
      isInferno
        ? fetchInfernoBase(token, userid, recoverToken)
        : fetchBase(token, resolvedBaseid, userid, recoverToken),
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
    // Only a genuine outpost is an outpost. `!isMain` also caught the Inferno
    // yard (opened with isMain: false, isInferno: true) and wild cells, and
    // isOutpost gates the "a full gatherer stops animating" rule - so every
    // Inferno harvester kept working at full storage, which is the reported
    // "generators animate when full". The real payload has 12 of 24 Inferno
    // harvesters sitting at exactly capacity[l-1] with pr:0.
    isOutpost: !isMain && !isInferno && !isWild,
    isOwnYard: Boolean(isOwnYard),
    // Scouting must not reveal traps (Booby Trap, Heavy Trap, ...): every
    // props entry with type "trap" is omitted entirely.
    hideBuilding: (typeId, props) => String(props?.type || "") === "trap",
  });
  view.renderer = renderer;
  canvas.style.cursor = "grab";
  renderer.setTheme(terrainFor({ isInferno, isMain, isWild, isOwnYard, terrainHeight, data }));
  // Inferno building art lives in a parallel buildings/i* tree on the server.
  renderer.setInfernoArt?.(Boolean(isInferno));
  renderer.setResources?.(safeObject(data?.resources));
  renderer.forceTownHallAtZero = String(data?.type || "") === "main";
  // The cavern is synthesised, not saved - see withInfernoCavern - and only
  // on your own main yard, matching INFERNO_EMERGENCE_EVENT's own gate of
  // BUILD mode on a main yard.
  // The cavern appears in both directions: on your main yard it goes down,
  // in the Inferno base it comes back up. INFERNOPORTAL.ToggleYard() is the
  // same single control in game.
  const buildingData = (isOwnYard && (isMain || isInferno))
    ? withInfernoCavern(safeObject(data?.buildingdata))
    : safeObject(data?.buildingdata);
  renderer.setBuildings(buildingData, {
    healthData: safeObject(data?.buildinghealthdata),
    savetime: data?.savetime,
    servertime: data?.currenttime,
    baseseed: data?.baseseed,
  });
  // Mushrooms are deliberately not drawn in the viewer.
  renderer.setEffects?.(safeArray(data?.effects));
  renderer.setLockerData?.(data?.lockerdata);
  populatePens(renderer, data);

  // Clicking the cavern opens the entice popup, as INFERNOPORTAL.Click does.
  renderer.onBuildingClick = (building) => {
    if (Number(building?.t) !== INFERNO_PORTAL_TYPE) return;
    if (isInferno) {
      // ToggleYard()'s other branch: from the Inferno yard it loads the main
      // yard straight back, with no popup in between.
      openBaseView({
        token, baseid, userid, name, isMain: true, isOwnYard: true,
        outpostList, prepare, prepareFor, baseListFor, recoverToken, x, y,
      });
      return;
    }
    openInfernoPopup(backdrop, () => {
      openBaseView({
        token, baseid, userid, name, isMain: false, isInferno: true,
        isOwnYard: true, outpostList, prepareFor, baseListFor, recoverToken,
        x: INFERNO_PORTAL_POS.x, y: INFERNO_PORTAL_POS.y,
      });
    });
  };

  const hud = backdrop.querySelector(".base-view-hud");
  // Everything below runs once now and again whenever "End Attack" tears the
  // simulation down: the simulated attack replaces the HUD wholesale, and
  // restoring it must rebuild the picker wiring too, not just the markup.
  const renderViewModeUi = () => {
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
        if (entry.isInferno) {
          // Same load the cavern performs: type=ibuild, baseid 0. No entice
          // popup here - the picker is already an explicit choice.
          openBaseView({
            token, baseid, userid, name, isMain: false, isInferno: true,
            isOwnYard: true, outpostList: entries,
            x: INFERNO_PORTAL_POS.x, y: INFERNO_PORTAL_POS.y,
            prepareFor, baseListFor, recoverToken,
          });
          return;
        }
        openBaseView({
          token, baseid: String(entry.baseid), userid, name,
          isMain: Boolean(entry.isMain), isOwnYard: true,
          outpostList: entries, x: entry.x, y: entry.y,
          // Without this the outpost opens with terrainHeight undefined and
          // terrainFor() falls back to grass, so a rock or sand outpost
          // reached through the picker looked different to the same outpost
          // opened from the map.
          terrainHeight: entry.terrainHeight,
          prepare: typeof prepareFor === "function"
            ? prepareFor(entry.x, entry.y)
            : undefined,
          prepareFor, baseListFor, recoverToken,
        });
      });
    }, isInferno);
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
    renderVisitorBar(backdrop, view, "view");
  };
  renderViewModeUi();

  // Context the "Simulate Attack" button needs, refreshed on every load so an
  // in-place swap to another base simulates against the right yard. The
  // plate keeps the same text the game's attack mode would show: the target
  // owner's name ("NAME'S YARD"), or the plain title on your own yard, or
  // INFERNO down below.
  const displayOwner = String(data?.name || "").trim()
    || resolvedName || String(name || "").trim();
  view.simContext = {
    isInferno: Boolean(isInferno),
    isMain: Boolean(isMain),
    // MONSTERBUNKER.Setup's input: the defender's housed monsters, straight
    // from the save.
    bunkerData: data?.monsterbunkerdata ?? null, // may be a JSON string; safeObject'd at use
    // CREATURES.Spawn levels its spawns from the yard owner's
    // m_upgrades - serialised into the save as "monsterupdate". Accepts
    // the field as an object or a JSON string, entries {Cn: {level}} or
    // {Cn: n}.
    monsterLevels: (() => {
      let mu = data?.monsterupdate;
      if (typeof mu === "string") { try { mu = JSON.parse(mu); } catch { mu = null; } }
      return mu && typeof mu === "object" ? mu : null;
    })(),
    // The defender's LAB powerups ride the save's "academy" field
    // (importAcademyData -> m_upgrades[creature].powerup is exactly what
    // poweredUp()/powerUpLevel() read for friendly creeps). Entries
    // {Cn: {level, powerup, ...}}, possibly JSON-encoded.
    academy: (() => {
      let ac = data?.academy;
      if (typeof ac === "string") { try { ac = JSON.parse(ac); } catch { ac = null; } }
      return ac && typeof ac === "object" ? ac : null;
    })(),
    gameData,
    // The yard's stored resources seed the battle loot pool (ATTACK's
    // BASE._resources stand-in).
    resources: safeObject(data?.resources),
    // mcPic only ever shows on somebody else's plate; your own yard's plate
    // has the star and level number there instead.
    ownerPic: isOwnYard ? "" : String(ownerPic || ""),
    plateTitle: isInferno ? HUD_TITLE_INFERNO
      : (yardOwnerTitle(displayOwner) || HUD_TITLE),
    restoreViewUi: renderViewModeUi,
  };
  // A new load while the simulation is open (picker, in-place swap): the HUD
  // was just rebuilt for view mode, so drop the stale simulation state.
  if (view.attackSim) {
    view.attackSim.stopHold?.();
    view.attackSim = null;
    hud?.classList.remove("attack-mode");
  }

  status.remove();
  const shown = backdrop.querySelector(".base-view-title");
  const ownerName = String(data?.name || "").trim() || resolvedName || String(name || "").trim();
  if (shown) {
    shown.textContent = buildBaseTitle(ownerName, isMain, x, y, isWild, isInferno);
  }
  debugLog(`Base view open: baseid ${resolvedBaseid}, ${renderer.buildings.length} structures.`);
}
