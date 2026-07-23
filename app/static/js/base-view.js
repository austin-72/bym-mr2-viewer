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
        const home = housings[Math.floor(Math.random() * housings.length)].placed;
        entities.push({
          id: `${key}-${i}`,
          kind: "creep",
          sheet,
          dirs: 30, //               SPRITES fallback: angle / 12
          speed,
          home: { x: home.x, y: home.y },
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

const ANIMATIONS_PREF_KEY = "bymViewerBaseAnimations";
const LAYOUT_PREF_KEY = "bymViewerBaseLayout";
const MIN_WINDOW_WIDTH = 360;
const MIN_WINDOW_HEIGHT = 260;

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
function defaultLayout() {
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
function clampLayout(layout) {
  const width = Math.min(Math.max(MIN_WINDOW_WIDTH, layout.width), window.innerWidth);
  const height = Math.min(Math.max(MIN_WINDOW_HEIGHT, layout.height), window.innerHeight);
  return {
    width,
    height,
    left: Math.min(Math.max(0, layout.left), Math.max(0, window.innerWidth - width)),
    top: Math.min(Math.max(0, layout.top), Math.max(0, window.innerHeight - height)),
  };
}

/**
 * Makes the base-view window draggable by its header and resizable from any
 * edge or corner, persisting the geometry so the next base opens the same
 * way. The renderer's ResizeObserver picks up the new canvas size on its
 * own, so nothing here has to poke the renderer.
 */
function setupWindowLayout(windowEl, resetButton) {
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

  // Drag by the header (ignoring the buttons living in it).
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

  resetButton?.addEventListener("click", () => {
    clearLayoutPref();
    layout = apply(defaultLayout(), { persist: false });
  });

  // A smaller window (or a rotated phone) must not strand the popup.
  const onResize = () => {
    layout = apply(layout, { persist: false });
  };
  window.addEventListener("resize", onResize);
  return () => window.removeEventListener("resize", onResize);
}

function loadAnimationsPref() {
  // Off by default; only an explicit stored "1" turns building animations on.
  try {
    return window.localStorage.getItem(ANIMATIONS_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function saveAnimationsPref(enabled) {
  try {
    window.localStorage.setItem(ANIMATIONS_PREF_KEY, enabled ? "1" : "0");
  } catch {
    /* private mode: preference just won't persist */
  }
}

let activeView = null;

export function closeBaseView() {
  if (!activeView) {
    return;
  }
  const { backdrop, renderer, keyHandler, teardownLayout } = activeView;
  activeView = null;
  renderer?.destroy?.();
  teardownLayout?.();
  document.removeEventListener("keydown", keyHandler);
  backdrop.remove();
}

export async function openBaseView({ token, baseid, userid, title, isMain, prepare, recoverToken }) {
  closeBaseView();

  const backdrop = document.createElement("div");
  backdrop.className = "base-view-backdrop";
  backdrop.innerHTML = `
    <div class="base-view-window" role="dialog" aria-modal="true" aria-label="Base viewer">
      <div class="base-view-header">
        <span class="base-view-title">${escapeHtml(title || (isMain ? "Yard" : "Outpost"))}</span>
        <div class="base-view-header-buttons">
          <button type="button" class="base-view-anim-toggle" aria-pressed="true"
            title="Toggle building animations (monsters and champions always animate)"></button>
          <button type="button" class="base-view-reset-layout"
            title="Reset the window to its default size and position">Reset size</button>
          <button type="button" class="base-view-close" aria-label="Close base view" title="Close">&times;</button>
        </div>
      </div>
      <div class="base-view-canvas-shell">
        <canvas class="base-view-canvas"></canvas>
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
    </div>
  `;
  const keyHandler = (event) => {
    if (event.key === "Escape") {
      closeBaseView();
    }
  };
  activeView = { backdrop, renderer: null, keyHandler, teardownLayout: null };
  document.body.appendChild(backdrop);
  document.addEventListener("keydown", keyHandler);
  backdrop.querySelector(".base-view-close").addEventListener("click", closeBaseView);
  // Drag/resize the window, restoring the size and position last used.
  activeView.teardownLayout = setupWindowLayout(
    backdrop.querySelector(".base-view-window"),
    backdrop.querySelector(".base-view-reset-layout"),
  );
  // Building-animation toggle, remembered across sessions. Monsters and
  // champions are exempt and always animate.
  let animationsEnabled = loadAnimationsPref();
  const animToggle = backdrop.querySelector(".base-view-anim-toggle");
  const syncAnimToggle = () => {
    animToggle.textContent = animationsEnabled ? "Animations: On" : "Animations: Off";
    animToggle.setAttribute("aria-pressed", animationsEnabled ? "true" : "false");
    animToggle.classList.toggle("off", !animationsEnabled);
  };
  syncAnimToggle();
  animToggle.addEventListener("click", () => {
    animationsEnabled = !animationsEnabled;
    saveAnimationsPref(animationsEnabled);
    syncAnimToggle();
    activeView?.renderer?.setBuildingAnimations?.(animationsEnabled);
  });
  // Clicking the dimmed area (outside the window) closes too; clicks inside
  // the window never bubble out to this.
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) {
      closeBaseView();
    }
  });

  const status = backdrop.querySelector(".base-view-status");
  const canvas = backdrop.querySelector(".base-view-canvas");

  // Optional prepare step: the caller reloads the cell's zone from the game
  // server first, then hands back the freshly observed base id + owner name.
  let resolvedBaseid = baseid;
  let resolvedName = "";
  if (typeof prepare === "function") {
    try {
      const resolved = await prepare((message) => {
        if (activeView?.backdrop === backdrop) {
          status.textContent = message;
        }
      });
      if (activeView?.backdrop !== backdrop) {
        return; // closed while refreshing
      }
      resolvedBaseid = String(resolved?.baseid || "").trim();
      resolvedName = String(resolved?.name || "").trim();
    } catch (error) {
      if (activeView?.backdrop !== backdrop) {
        return;
      }
      status.textContent = error?.message || "Could not refresh this cell.";
      status.classList.add("error");
      return;
    }
  }
  if (!resolvedBaseid || resolvedBaseid === "0") {
    status.textContent = "No base id is available for this cell.";
    status.classList.add("error");
    return;
  }
  status.textContent = "Loading base\u2026";

  let gameData;
  let data;
  try {
    [gameData, data] = await Promise.all([
      loadGameData(),
      fetchBase(token, resolvedBaseid, userid, recoverToken),
    ]);
  } catch (error) {
    if (activeView?.backdrop !== backdrop) {
      return; // closed (or replaced) while loading
    }
    status.textContent = error?.message
      ? `Could not load this base: ${error.message}`
      : "Could not load this base.";
    status.classList.add("error");
    return;
  }
  if (activeView?.backdrop !== backdrop) {
    return; // closed while loading
  }

  // Read-only renderer: pan + zoom only, sprites via the permanent
  // server-side image cache.
  const renderer = new YardRenderer(canvas, gameData, "/imagecache", {
    interactive: false,
    buildingAnimations: animationsEnabled,
    // Scouting must not reveal traps (Booby Trap, Heavy Trap, ...): every
    // props entry with type "trap" is omitted entirely.
    hideBuilding: (typeId, props) => String(props?.type || "") === "trap",
  });
  activeView.renderer = renderer;
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
  populatePens(renderer, data);
  status.remove();
  const shown = backdrop.querySelector(".base-view-title");
  const ownerName = String(data?.name || "").trim() || resolvedName;
  if (shown && ownerName) {
    shown.textContent = `${ownerName}'s ${isMain ? "Yard" : "Outpost"}`;
  }
  debugLog(`Base view open: baseid ${resolvedBaseid}, ${renderer.buildings.length} structures.`);
}
