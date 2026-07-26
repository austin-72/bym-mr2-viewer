// Canvas renderer for a player's yard — game-accurate edition.
//
// Coordinate model (from the Flash client, BFOUNDATION.Setup + GRID):
//  - Building save records carry {X, Y} (capital!) in CARTESIAN yard units,
//    snapped to a 20-unit lattice; negatives are normal. The yard spans
//    [-1300, 1300]² (GRID._mapWidth/Height = 2600).
//  - Screen position = GRID.ToISO(X, Y): (X - Y, (X + Y) * 0.5), floored.
//    That point is the movieclip origin — the TOP vertex of the footprint.
//  - A size × size cartesian footprint projects to a screen diamond
//    2·size wide and size tall below the origin.
//
// Rendering features mirrored from the Flash client:
//  - Ground: the seven 200×100 isograss tiles rect-tiled (seeded variety)
//    and clipped to the yard diamond (MAPBG.MakeTile / MAP tiling).
//  - Sprites: shadow + top per level bucket, with "damaged" (< 50% hp,
//    BFOUNDATION line 529) and "destroyed" (0 hp) variants when
//    buildinghealthdata provides hp, falling back to the base state when a
//    variant is missing (BFOUNDATION render-state fallback).
//  - Animations: `anim` entries are horizontal spritesheets
//    [file, [offsetX, offsetY, frameW, frameH], frameCount], ticked with a
//    random start phase per building (BFOUNDATION._animTick).
//  - Save-data quirks: t:18 walls become t:17 level 2; t:53/54 skipped
//    (BASE.as building loop).
//  - Construction / upgrade countdowns (cB / cU seconds remaining as of
//    savetime) shown as live badges.

import { harvesterInfo, HARVESTER_RESOURCE } from "./gamedata.js";

const CELL = 20;
const YARD_HALF = 1300; // cartesian half-extent of the buildable yard
const GRASS_W = 200;
const GRASS_H = 100;
// ── Ground composite (MAPBG.MakeTile) ─────────────────────────────────
// The original builds a 1000x500 mega-tile: sheet t1 (5x5 repeats of tile 1)
// as the base, then for each further tile variant a perlinNoise alpha mask
// (baseX = 50·tile, baseY = 25·tile, 2 octaves, stitched, seeded with
// BASE._baseSeed + 1 + tile) composites sheet t{tile} on top. The noise
// function here is a seeded periodic Perlin — structurally identical, though
// not bit-identical to Flash's implementation.

const GROUND_W = 1000;
const GROUND_H = 500;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Periodic (stitched) 2-octave Perlin over a GROUND_W x GROUND_H bitmap.
function perlinAlpha(baseX, baseY, seed) {
  const octaves = 2;
  const data = new Float32Array(GROUND_W * GROUND_H);
  for (let octave = 0; octave < octaves; octave++) {
    const freq = 2 ** octave;
    const amplitude = 1 / 2 ** octave;
    const cols = Math.max(1, Math.round((GROUND_W / baseX) * freq));
    const rows = Math.max(1, Math.round((GROUND_H / baseY) * freq));
    const rand = mulberry32(seed * 7919 + octave * 104729);
    const lattice = new Float32Array((cols + 1) * (rows + 1));
    for (let ly = 0; ly < rows; ly++) {
      for (let lx = 0; lx < cols; lx++) lattice[ly * (cols + 1) + lx] = rand();
    }
    // Stitch: wrap edges so the tile is seamless.
    for (let ly = 0; ly <= rows; ly++) lattice[ly * (cols + 1) + cols] = lattice[(ly % rows) * (cols + 1)];
    for (let lx = 0; lx <= cols; lx++) lattice[rows * (cols + 1) + lx] = lattice[lx];
    const fade = (t) => t * t * (3 - 2 * t);
    for (let y = 0; y < GROUND_H; y++) {
      const fy = (y / GROUND_H) * rows;
      const y0 = Math.floor(fy);
      const ty = fade(fy - y0);
      for (let x = 0; x < GROUND_W; x++) {
        const fx = (x / GROUND_W) * cols;
        const x0 = Math.floor(fx);
        const tx = fade(fx - x0);
        const i00 = lattice[y0 * (cols + 1) + x0];
        const i10 = lattice[y0 * (cols + 1) + x0 + 1];
        const i01 = lattice[(y0 + 1) * (cols + 1) + x0];
        const i11 = lattice[(y0 + 1) * (cols + 1) + x0 + 1];
        const top = i00 + (i10 - i00) * tx;
        const bottom = i01 + (i11 - i01) * tx;
        data[y * GROUND_W + x] += (top + (bottom - top) * ty) * amplitude;
      }
    }
  }
  return data;
}

const THEMES = {
  grass: {
    tiles: [
      "/assets/yardbg/grass/isograss1.png",
      "/assets/yardbg/grass/isograss2.png",
      "/assets/yardbg/grass/isograss3.png",
      "/assets/yardbg/grass/isograss4.png",
      "/assets/yardbg/grass/isograss5.png",
      "/assets/yardbg/grass/isograss6.png",
      "/assets/yardbg/grass/isograss7.png",
    ],
    base: "#2f4a20",
    void: "#101c10",
    grid: "rgba(0, 0, 0, 0.08)",
  },
  lava: {
    tiles: [
      "/assets/yardbg/lava/lava1.png",
      "/assets/yardbg/lava/lava2.png",
      "/assets/yardbg/lava/lava3.png",
      "/assets/yardbg/lava/lava4.png",
    ],
    base: "#4a1808",
    void: "#1c0a04",
    grid: "rgba(0, 0, 0, 0.18)",
  },
};
const ANIM_FRAME_MS = 1000 / 24; // building anim strips
// Pen movement advances once per ENTER_FRAME, and the SWF header declares
// 40fps - stepping at 24 ran creeps and champions at 60% of game speed.
const PEN_FRAME_MS = 1000 / 40;
const HATCH_FRAME_MS = 1000 / 12; // BUILDING13.TickFast: every 2nd frame

// BuildingOverlay strips: a 51x300 sheet of 50 progress rows and a 51x120
// sheet of 20 health rows, both 6px tall, sampled one row at a time.
const OVERLAY_PROGRESS = "/assets/gameui/overlay_progress.png";
const OVERLAY_HP = "/assets/gameui/overlay_hp.png";
const OVERLAY_ROW_H = 6;
const OVERLAY_W = 51;
// ImageText.Get(text, 9, 0.6, ...) draws a TextField into a bitmap, so the
// glyphs start one 2px TextField gutter in. BuildingOverlay then copies that
// bitmap into bmdtext at y = -1 and places bmdtext at y = -32, which puts the
// top of the lettering at -32 + 2 - 1 = -31. A 9px cap height ends around -22,
// clearing the progress bar at -20 by roughly 2px.
const OVERLAY_LABEL_SIZE = 9;
const OVERLAY_LABEL_TOP = -31;

/** BuildingOverlay: int(49 / total * (total - remaining)). */
function overlayProgressRow(total, remaining) {
  const t = Number(total) || 0;
  if (t <= 0) return -1;
  const done = Math.max(0, Math.min(t, t - Math.max(0, remaining)));
  return Math.max(0, Math.min(49, Math.floor((49 / t) * done)));
}

/** BuildingOverlay: 19 - int(19 / maxHealth * health), blank once dead. */
function overlayHealthRow(health, maxHealth) {
  if (health === null || health === undefined) return -1;
  const hp = Number(health);
  const max = Number(maxHealth) || 0;
  if (!max || hp <= 0 || hp >= max) return -1;
  return Math.max(0, Math.min(19, 19 - Math.floor((19 / max) * hp)));
}

// KEYS bdg_state_*, as ImageText renders them into the overlay label.
const OVERLAY_LABELS = {
  building: "BUILDING",
  upgrading: "UPGRADING",
  fortifying: "FORTIFYING",
  repairing: "REPAIRING",
};
const ANIM_START_AT_ZERO = new Set([9, 19, 25, 54]); // BFOUNDATION Setup

// ── Animation gating ────────────────────────────────────────────────────
// The game only runs most anim strips while the building is doing something.
// Left ungated, a yard is a wall of perpetual motion that reads as busy when
// nothing is happening, so each rule below mirrors the class that owns it.

// Idle machinery: the strip exists but the game never loops it here.
const NEVER_ANIMATE = new Set([
  9,   // Monster Juicer
  19,  // Wild Monster Baiter
  22,  // Monster Bunker
  25,  // Tesla Tower
  129, // Inferno Quake Tower
]);

// Turret strips are DIRECTION sheets, not loops: each frame is the barrel
// rotated one step. BTOWER.Rotate: angle = atan2(dy, dx) in PATHING (grid)
// space, degrees, normalised to 0-360, then int(angle / 11.25) -> 32
// headings. Resting on frame 0 is why an unaimed tower faces bottom-right.
const TURRET_TYPES = new Set([
  21,  // Sniper Tower
  23,  // Laser Tower
  115, // Aerial Defense (flak) Tower
  118, // Railgun Tower
  132, // Inferno Magma Tower
  136, // Spurtz Cannon
  137, // Black Spurtz Cannon
]);
const TURRET_HEADINGS = 32; // BTOWER.Rotate: 360 / 11.25
// BUILDING23.Track divides by 6.66 instead, so the laser tower's strip is a
// 54-step rotation rather than the usual 32. Indexing its sheet as 32 makes
// the barrel lag the pointer by an ever-growing angle.
const TURRET_HEADINGS_BY_TYPE = new Map([[23, 54]]); // 360 / 6.66

// Buildings that animate only while working. Each predicate takes the raw
// save record and returns whether that job is running.
const BUSY_ANIMATE = new Map([
  // BUILDING13: _inProduction != "" && _productionStage == 1.
  [13, (raw) => String(raw?.rIP || "") !== "" && Number(raw?.rPS || 0) === 1],
  // BUILDING26 / MONSTERLAB export `upg` while a research/training runs.
  [26, (raw) => Boolean(raw?.upg)],
  [116, (raw) => Boolean(raw?.upg)],
  // SiegeBuilding.TickFast animates while any weapon is upgrading; the job
  // list persists as unlockingWeapons2 (older saves: unlockingWeapons).
  [133, (raw) => hasSiegeJob(raw)],
  [134, (raw) => hasSiegeJob(raw)],
  // BUILDING8 keys off CREATURELOCKER._unlocking, which lives in the save's
  // top-level lockerdata rather than the building record - supplied through
  // setLockerData(). Without it the locker stays still, which is the safe
  // default for a viewer.
  [8, (raw, renderer) => renderer.lockerUnlocking],
]);

function hasSiegeJob(raw) {
  for (const key of ["unlockingWeapons2", "unlockingWeapons"]) {
    const jobs = raw?.[key];
    if (jobs && typeof jobs === "object" && Object.keys(jobs).length > 0) return true;
  }
  return false;
}

export class YardRenderer {
  // options.interactive=false (map-viewer base popup): pan + zoom stay
  // enabled but buildings cannot be hovered, selected, or dragged.
  constructor(canvas, gameData, assetBase, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.gameData = gameData;
    this.assetBase = assetBase.replace(/\/+$/, "") + "/assets/";
    this.images = new Map();
    this.buildings = [];
    this.healthData = {};
    this.savetime = 0;
    this.theme = THEMES.grass;
    this.champions = [];
    this.penEntities = []; //  HOUSING.Populate + CHAMPIONCAGE.SpawnGuardian
    this.penTick = 0;
    this.lastPenStep = 0;
    this.mushrooms = [];
    this.effects = [];
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.hovered = null;
    this.selected = null;
    this.onSelect = null;
    this.editMode = false;
    this.editSnap = 10; // GRID.FindSpace scans a 10-unit mesh
    this.onLayoutChange = null;
    this.onDragEnd = null;
    this.needsDraw = true;
    this.hasAnimations = false;
    this.hasCountdowns = false;
    this.interactive = options.interactive !== false;
    // Where turrets point. Null until the pointer moves (or a tap lands), so
    // an untouched yard shows them at their resting heading.
    this.aimPoint = null;
    // Set from the save's lockerdata; gates the Monster Locker animation.
    this.lockerUnlocking = false;
    // Your own yard gets the white boundary and the resource readout, the
    // way the game shows it.
    this.isOwnYard = Boolean(options.isOwnYard);
    this.resources = null;
    // Outposts keep their resource gatherers animating even when full; on a
    // main yard a full gatherer is idle and stops.
    this.isOutpost = Boolean(options.isOutpost);
    // Optional predicate (typeId, props) => true to omit a building entirely
    // (the base viewer hides traps: scouting must not reveal them).
    this.hideBuilding = typeof options.hideBuilding === "function" ? options.hideBuilding : null;
    // Building sprite-sheet animations can be toggled off (pen creatures and
    // champions are unaffected - they always animate).
    this.buildingAnimations = options.buildingAnimations !== false;
    this.destroyed = false;
    this.bindInput();
    const loop = () => {
      if (this.destroyed) return;
      // Animations and live countdowns need continuous redraws; otherwise
      // draw only when something changed.
      if (this.penEntities.length) {
        const now = Math.floor(performance.now() / PEN_FRAME_MS);
        if (!this.lastPenStep) this.lastPenStep = now;
        const steps = Math.min(16, now - this.lastPenStep);
        if (steps > 0) {
          this.stepPens(steps);
          this.lastPenStep = now;
          this.needsDraw = true;
        }
      }
      const liveAnimations = this.hasAnimations
        && (this.buildingAnimations || this.penEntities.length > 0);
      if (this.needsDraw || liveAnimations || this.hasCountdowns) {
        this.needsDraw = false;
        this.draw();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement || canvas);
    this.resize();
  }

  destroy() {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
  }

  setBuildingAnimations(enabled) {
    this.buildingAnimations = Boolean(enabled);
    this.invalidate();
  }

  invalidate() {
    this.needsDraw = true;
  }

  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const ratio = window.devicePixelRatio || 1;
    const { clientWidth, clientHeight } = parent;
    if (!clientWidth || !clientHeight) return;
    this.canvas.width = clientWidth * ratio;
    this.canvas.height = clientHeight * ratio;
    this.canvas.style.width = clientWidth + "px";
    this.canvas.style.height = clientHeight + "px";
    this.ratio = ratio;
    this.invalidate();
  }

  // ── data ──────────────────────────────────────────────────────────────

  setTheme(name) {
    this.theme = THEMES[name] || THEMES.grass;
    this.groundCanvas = null; // rebuild for the new tile set
    this.invalidate();
  }

  // Builds the MAPBG mega-tile once all tile sprites are loaded.
  buildGround() {
    if (this.groundCanvas) return this.groundCanvas;
    // Tiles are bundled locally, so an absolute path is used as-is; only
    // relative paths get the CDN-proxy prefix.
    const tiles = this.theme.tiles.map((path) =>
      this.sprite(path.startsWith("/") ? path : this.assetBase + path));
    if (!tiles.every((entry) => entry.ready)) return null;
    const composite = document.createElement("canvas");
    composite.width = GROUND_W;
    composite.height = GROUND_H;
    const cctx = composite.getContext("2d");
    const sheet = (entry) => {
      const c = document.createElement("canvas");
      c.width = GROUND_W;
      c.height = GROUND_H;
      const sctx = c.getContext("2d");
      for (let h = 0; h < 5; h++) {
        for (let v = 0; v < 5; v++) sctx.drawImage(entry.img, h * 200, v * 100);
      }
      return c;
    };
    cctx.drawImage(sheet(tiles[0]), 0, 0);
    const seed = Number(this.baseSeed) || 0;
    for (let tile = 2; tile <= tiles.length; tile++) {
      const alpha = perlinAlpha(50 * tile, 25 * tile, seed + 1 + tile);
      const layer = sheet(tiles[tile - 1]);
      const lctx = layer.getContext("2d");
      const pixels = lctx.getImageData(0, 0, GROUND_W, GROUND_H);
      for (let i = 0; i < GROUND_W * GROUND_H; i++) {
        pixels.data[i * 4 + 3] = Math.round(pixels.data[i * 4 + 3] * Math.min(1, Math.max(0, alpha[i])));
      }
      lctx.putImageData(pixels, 0, 0);
      cctx.drawImage(layer, 0, 0);
    }
    this.groundCanvas = composite;
    return composite;
  }

  // Champions (save.champion): active champions (status 0) stand beside the
  // town hall; frozen ones (status 1) sit at the champion chamber (t 119).
  setChampions(champions) {
    this.champions = [];
    this.penEntities = []; //  HOUSING.Populate + CHAMPIONCAGE.SpawnGuardian
    this.penTick = 0;
    this.lastPenStep = 0;
    const list = Array.isArray(champions) ? champions : [];
    const anchorFor = (frozen) => {
      const host = this.buildings.find((b) => b.t === (frozen ? 119 : 14));
      return host || this.buildings[0] || null;
    };
    list.forEach((champ, index) => {
      if (!champ || !champ.t) return;
      const frozen = Number(champ.status) === 1;
      const anchor = anchorFor(frozen);
      if (!anchor) return;
      const size = this.gameData.footprint(anchor.t);
      this.champions.push({
        t: Number(champ.t),
        l: Number(champ.l) || 1,
        nm: champ.nm,
        frozen,
        // Stand at the right edge of the anchor footprint, staggered.
        x: anchor.x + size * 0.7 + index * 30,
        y: anchor.y + size * 0.45,
      });
    });
    this.invalidate();
  }

  // Battle decals (save.effects, EFFECTS.as SnapShotB): [x, y, code, age]
  // where x/y are already iso screen coordinates. Rendered as scorch marks
  // (the original uses embedded Flash effect clips keyed by code).
  setEffects(list) {
    this.effects = (Array.isArray(list) ? list : [])
      .filter((e) => Array.isArray(e) && e.length >= 3)
      .map(([x, y, code]) => ({ x: Number(x) || 0, y: Number(y) || 0, code: String(code) }));
    this.invalidate();
  }

  // Mushrooms (save.mushrooms.l): entries are [frame, X, Y] in cartesian
  // yard units (MUSHROOMS.as). Rendered with the mushroom thumb sprite.
  setMushrooms(list) {
    this.mushrooms = (Array.isArray(list) ? list : [])
      .filter((m) => Array.isArray(m) && m.length >= 3)
      .map(([frame, X, Y]) => ({
        frame: Number(frame) || 0,
        x: Math.floor(Number(X) - Number(Y)),
        y: Math.floor((Number(X) + Number(Y)) * 0.5),
      }));
    this.invalidate();
  }

  setBuildings(buildingData, { healthData = {}, savetime = 0, servertime = 0, baseseed = 0 } = {}) {
    this.healthData = healthData || {};
    if (this.baseSeed !== Number(baseseed)) {
      this.baseSeed = Number(baseseed) || 0;
      this.groundCanvas = null;
    }
    const localEpoch = Math.floor(Date.now() / 1000);
    // Fold server/local clock skew into the baseline (BASE.as computes
    // catchup as server currenttime − savetime; we then tick with the local
    // clock from an equivalent starting point).
    const skew = Number(servertime) ? localEpoch - Number(servertime) : 0;
    this.savetime = (Number(savetime) || 0) + skew;
    const nowEpoch = localEpoch;

    this.buildings = Object.entries(buildingData || {})
      .map(([key, record]) => {
        let t = Number(record.t);
        // BASE.as: on a main yard, building id 0 is forced to the Town Hall.
        if (this.forceTownHallAtZero && key === "0" && t !== 14) t = 14;
        // The save omits `l` at level 1 and writes 0 while a fresh build is
        // still running. Keep both: `rawLevel` drives the cost lookups the way
        // BFOUNDATION does, `l` is the art level (imageData[0] falls back to
        // imageData[1], so level 0 draws the level-1 sprite).
        const rawLevel = Number(record.l ?? 1) || 0;
        let l = rawLevel > 0 ? rawLevel : 1;
        // BASE.as: stone wall records are the wooden wall at level 2.
        if (t === 18) {
          t = 17;
          l = 2;
        }
        const cartX = Number(record.X ?? record.x) || 0;
        const cartY = Number(record.Y ?? record.y) || 0;
        const id = record.id ?? Number(key);

        // Damage state from buildinghealthdata (hp by building id).
        const maxHp = this.gameData.hp(t, l);
        const hp = this.healthData[id] ?? this.healthData[String(id)];
        let state = "";
        if (hp !== undefined && maxHp) {
          if (Number(hp) <= 0) state = "destroyed";
          else if (Number(hp) < maxHp * 0.5) state = "damaged"; // BFOUNDATION:529
        }

        // Countdowns: cB/cU/cF/cR are seconds remaining as of savetime, and
        // rE is the repair flag. BFOUNDATION.Export writes all five.
        const elapsed = this.savetime ? nowEpoch - this.savetime : 0;
        const remainingOf = (key) =>
          Number(record[key]) > 0 ? Number(record[key]) - elapsed : 0;
        const buildRemaining = remainingOf("cB");
        const upgradeRemaining = remainingOf("cU");
        const fortifyRemaining = remainingOf("cF");
        const rebuildRemaining = remainingOf("cR");
        const endsAt = (secs) => (secs > 0 ? Date.now() + secs * 1000 : 0);

        // Totals for the progress bar. BuildingOverlay reads costs[_lvl] for
        // both build and upgrade (costs is 0-indexed, so at level L that is
        // the cost of L -> L+1, and at level 0 it is the initial build), sums
        // costs[0..prefab-1] for a prefab, and fortify_costs[fort] to fortify.
        const props = this.gameData.get(t);
        const costs = Array.isArray(props?.costs) ? props.costs : null;
        const fortCosts = Array.isArray(props?.fortify_costs) ? props.fortify_costs : null;
        const prefab = Number(record.prefab) || 0;
        const fort = Number(record.fort ?? 0) || 0;
        const timeAt = (arr, i) =>
          arr ? Number(arr[Math.max(0, Math.min(arr.length - 1, i))]?.time) || 0 : 0;
        let buildTotal = timeAt(costs, rawLevel);
        if (prefab && costs) {
          buildTotal = 0;
          for (let i = 0; i < prefab && i < costs.length; i++) {
            buildTotal += Number(costs[i]?.time) || 0;
          }
        }
        const upgradeTotal = timeAt(costs, rawLevel);
        const fortifyTotal = timeAt(fortCosts, fort);

        return {
          key,
          id,
          t,
          l,
          cartX,
          cartY,
          x: Math.floor(cartX - cartY), // GRID.ToISO
          y: Math.floor((cartX + cartY) * 0.5),
          rawLevel,
          fort,
          state,
          hp: hp !== undefined ? Number(hp) : null,
          maxHp,
          harvest: HARVESTER_RESOURCE[t]
            ? harvesterInfo(this.gameData.get(t), l, record, this.savetime)
            : null,
          buildEndsAt: endsAt(buildRemaining),
          upgradeEndsAt: endsAt(upgradeRemaining),
          fortifyEndsAt: endsAt(fortifyRemaining),
          rebuildEndsAt: endsAt(rebuildRemaining),
          repairing: Number(record.rE) > 0,
          buildTotal,
          upgradeTotal,
          fortifyTotal,
          animPhase: Math.random(), // scaled to int(r * (frames - 2)) at draw
          raw: record,
        };
      })
      .filter((b) => Number.isFinite(b.t) && b.t !== 53 && b.t !== 54) // BASE.as skip
      .filter((b) => !this.hideBuilding || !this.hideBuilding(b.t, this.gameData.get(b.t)))
      .sort((a, b) => a.y - b.y || a.x - b.x);

    this.refreshAnimationState();
    this.hasCountdowns = this.buildings.some(
      (b) => b.buildEndsAt || b.upgradeEndsAt || b.fortifyEndsAt,
    );

    this.fitCamera();
    this.invalidate();
  }

  fitCamera() {
    if (!this.buildings.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of this.buildings) {
      const size = this.gameData.footprint(b.t);
      minX = Math.min(minX, b.x - size);
      maxX = Math.max(maxX, b.x + size);
      minY = Math.min(minY, b.y - size); // sprites rise above the origin
      maxY = Math.max(maxY, b.y + size);
    }
    const pad = 140;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const viewW = this.canvas.width / (this.ratio || 1);
    const viewH = this.canvas.height / (this.ratio || 1);
    const zoom = Math.min(viewW / (maxX - minX), viewH / (maxY - minY), 1.4);
    this.camera.zoom = Math.max(0.15, zoom);
    this.camera.x = (minX + maxX) / 2 - viewW / 2 / this.camera.zoom;
    this.camera.y = (minY + maxY) / 2 - viewH / 2 / this.camera.zoom;
  }

  // ── input ─────────────────────────────────────────────────────────────

  bindInput() {
    const canvas = this.canvas;
    let dragging = false;
    let moved = false;
    let last = null;

    // Active pointers, so two fingers can be told apart from one. A second
    // pointer starts a pinch: the midpoint is held fixed in world space while
    // the distance between the fingers drives the zoom, which is how every
    // native map behaves.
    const pointers = new Map();
    let pinch = null;

    const pinchDistance = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const pinchMidpoint = () => {
      const [a, b] = [...pointers.values()];
      return { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 };
    };
    const beginPinch = () => {
      const distance = pinchDistance();
      if (distance <= 0) return;
      pinch = { distance, zoom: this.camera.zoom };
      dragging = false;
      moved = true; // a pinch is never a tap
    };

    let draggingBuilding = null;
    canvas.addEventListener("pointerdown", (event) => {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      canvas.setPointerCapture(event.pointerId);
      if (pointers.size === 2) {
        beginPinch();
        return;
      }
      if (pointers.size > 2) return;
      dragging = true;
      moved = false;
      last = { x: event.clientX, y: event.clientY };
      draggingBuilding = this.editMode && this.interactive ? this.hitTest(event) : null;
      if (draggingBuilding) {
        draggingBuilding._dragOrigin = { X: draggingBuilding.cartX, Y: draggingBuilding.cartY };
      }
    });
    canvas.addEventListener("pointermove", (event) => {
      if (pointers.has(event.pointerId)) {
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }

      if (pinch && pointers.size >= 2) {
        const distance = pinchDistance();
        if (distance > 0) {
          const midpoint = pinchMidpoint();
          const before = this.screenToWorld(midpoint);
          // Same bounds as the wheel path: GLOBAL._MAGNIFICATION_BOUNDS is
          // (0.6, 2.75), widened a little on the way out.
          this.camera.zoom = Math.min(2.75, Math.max(0.12, pinch.zoom * (distance / pinch.distance)));
          const after = this.screenToWorld(midpoint);
          this.camera.x += before.x - after.x;
          this.camera.y += before.y - after.y;
          this.invalidate();
        }
        event.preventDefault();
        return;
      }

      if (dragging && draggingBuilding) {
        // GRID.FromISO: cartX = screenY + screenX/2, cartY = screenY − screenX/2,
        // snapped to the 20-unit lattice.
        const point = this.screenToWorld(event);
        const snap = this.editSnap || CELL;
        const cartX = Math.round((point.y + point.x * 0.5) / snap) * snap;
        const cartY = Math.round((point.y - point.x * 0.5) / snap) * snap;
        if (cartX !== draggingBuilding.cartX || cartY !== draggingBuilding.cartY) {
          moved = true;
          draggingBuilding.cartX = cartX;
          draggingBuilding.cartY = cartY;
          draggingBuilding.x = Math.floor(cartX - cartY);
          draggingBuilding.y = Math.floor((cartX + cartY) * 0.5);
          this.buildings.sort((a, b) => a.y - b.y || a.x - b.x);
          if (this.onLayoutChange) this.onLayoutChange();
          this.invalidate();
        }
        return;
      }
      // Turrets follow the pointer wherever it is, panning or not. On touch
      // there is no hover, so the aim point is set on tap instead.
      if (event.pointerType !== "touch") {
        this.setAimPoint(this.screenToWorld(event));
      }

      if (dragging && last) {
        const dx = event.clientX - last.x;
        const dy = event.clientY - last.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        this.camera.x -= dx / this.camera.zoom;
        this.camera.y -= dy / this.camera.zoom;
        last = { x: event.clientX, y: event.clientY };
        this.invalidate();
      } else if (this.interactive && event.pointerType !== "touch") {
        // Hover only applies to a real cursor; on touch it would leave a
        // stale highlight behind after every tap.
        const hit = this.hitTest(event);
        if (hit !== this.hovered) {
          this.hovered = hit;
          canvas.style.cursor = hit ? "pointer" : "grab";
          this.invalidate();
        }
      }
    });
    const releasePointer = (event) => {
      pointers.delete(event.pointerId);
      if (pinch && pointers.size < 2) {
        pinch = null;
        // Hand control back to the finger still down, without the camera
        // lurching to meet it.
        const remaining = [...pointers.values()][0];
        if (remaining) {
          dragging = true;
          last = { x: remaining.x, y: remaining.y };
        } else {
          dragging = false;
        }
      }
    };
    canvas.addEventListener("pointerup", (event) => {
      const wasPinching = Boolean(pinch);
      releasePointer(event);
      if (pointers.size > 0) return;
      dragging = false;
      if (draggingBuilding && moved && this.onDragEnd) {
        this.onDragEnd(draggingBuilding, draggingBuilding._dragOrigin);
      }
      draggingBuilding = null;
      if (!moved && !wasPinching && event.pointerType === "touch") {
        this.setAimPoint(this.screenToWorld(event));
      }
      if (!moved && !wasPinching && this.interactive) {
        this.selected = this.hitTest(event);
        this.invalidate();
        if (this.onSelect) this.onSelect(this.selected);
      }
    });
    canvas.addEventListener("pointercancel", (event) => {
      releasePointer(event);
      if (pointers.size === 0) {
        dragging = false;
        draggingBuilding = null;
      }
    });
    canvas.addEventListener("pointerleave", () => {
      if (pointers.size === 0) {
        dragging = false;
      }
      if (this.hovered) {
        this.hovered = null;
        this.invalidate();
      }
    });
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        const before = this.screenToWorld(event);
        // GLOBAL._MAGNIFICATION_BOUNDS is (0.6, 2.75); allow a bit wider out.
        this.camera.zoom = Math.min(2.75, Math.max(0.12, this.camera.zoom * factor));
        const after = this.screenToWorld(event);
        this.camera.x += before.x - after.x;
        this.camera.y += before.y - after.y;
        this.invalidate();
      },
      { passive: false },
    );
  }

  screenToWorld(event) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    return { x: this.camera.x + sx / this.camera.zoom, y: this.camera.y + sy / this.camera.zoom };
  }

  hitTest(event) {
    const point = this.screenToWorld(event);
    for (let i = this.buildings.length - 1; i >= 0; i--) {
      const b = this.buildings[i];
      const size = this.gameData.footprint(b.t);
      const halfW = size;
      const halfH = size / 2;
      const dx = Math.abs(point.x - b.x);
      const dy = Math.abs(point.y - (b.y + halfH));
      if (dx / halfW + dy / halfH <= 1) return b;
    }
    return null;
  }

  // ── sprites ───────────────────────────────────────────────────────────

  sprite(url) {
    let entry = this.images.get(url);
    if (!entry) {
      // No crossOrigin: we never read canvas pixels back, and requesting
      // CORS would make sprites fail on hosts without ACAO headers.
      const img = new Image();
      entry = { img, ready: false, failed: false };
      img.onload = () => {
        entry.ready = true;
        this.invalidate();
      };
      img.onerror = () => {
        entry.failed = true;
      };
      img.src = url;
      this.images.set(url, entry);
    }
    return entry;
  }

  /**
   * Recomputes whether the continuous redraw loop is needed. Only strips that
   * will actually move count: with most buildings now gated on being busy, an
   * idle yard drops to static rendering entirely, which matters on phones.
   * Must be re-run whenever a gating input changes (buildings, locker state).
   */
  refreshAnimationState() {
    const previous = this.hasAnimations;
    this.hasAnimations = this.buildings.some((b) => {
      const bundle = this.gameData.imagesForLevel(b.t, this.effectiveLevel(b.t, b.l));
      const suffix = b.state === "damaged" ? "damaged" : "";
      if (!bundle?.entry?.["anim" + suffix] || b.state === "destroyed") return false;
      // Turrets redraw on pointer movement, not on a timer.
      if (TURRET_TYPES.has(b.t)) return false;
      return b.t === 6 || this.shouldAnimate(b);
    });
    this.hasAnimations = this.hasAnimations || this.penEntities.length > 0;
    if (previous !== this.hasAnimations) this.invalidate();
  }

  /**
   * Feeds the save's top-level `lockerdata` in, so the Monster Locker can
   * animate while a creature is unlocking. CREATURELOCKER treats an entry
   * with t == 1 as in-progress; anything else is locked or already owned.
   */
  setLockerData(lockerData) {
    let unlocking = false;
    if (lockerData && typeof lockerData === "object") {
      unlocking = Object.values(lockerData)
        .some((entry) => entry && typeof entry === "object" && Number(entry.t) === 1);
    }
    if (this.lockerUnlocking !== unlocking) {
      this.lockerUnlocking = unlocking;
      this.refreshAnimationState();
      this.invalidate();
    }
  }

  repositionBuilding(building, cartX, cartY) {
    building.cartX = cartX;
    building.cartY = cartY;
    building.x = Math.floor(cartX - cartY);
    building.y = Math.floor((cartX + cartY) * 0.5);
    this.buildings.sort((a, b) => a.y - b.y || a.x - b.x);
    this.invalidate();
  }

  // BFOUNDATION:1094 — fortification overlay bucket for a fort level,
  // exact match else scan downward, like the image buckets.
  fortBundle(t, fortLevel) {
    if (!fortLevel) return null;
    const props = this.gameData.get(t);
    const table = props?.fortImgData;
    if (!table) return null;
    for (let level = fortLevel; level > 0; level--) {
      if (table[String(level)]) return { baseurl: table.baseurl || "", entry: table[String(level)] };
    }
    return null;
  }

  drawFortLayer(b, which) {
    const bundle = this.fortBundle(b.t, b.fort);
    if (!bundle) return;
    const spec = this.layerSpec(bundle.entry, which, b.state);
    if (!spec) return;
    const [file, offset] = spec;
    const entry = this.sprite(this.assetBase + bundle.baseurl + file);
    if (!entry.ready) return;
    const [ox, oy] = Array.isArray(offset) ? offset : [0, 0];
    this.ctx.drawImage(entry.img, b.x + ox, b.y + oy);
  }

  // BFOUNDATION.getEffectiveLevel: outside Map Room 3, the Flinger renders
  // capped at level 4 and Monster Housing at level 6.
  effectiveLevel(t, l) {
    if (t === 5) return Math.min(l, 4);
    if (t === 15) return Math.min(l, 6);
    return l;
  }

  // BFOUNDATION render-state fallback: try "topdamaged", fall back to "top".
  layerSpec(entry, layer, state) {
    if (state && Array.isArray(entry[layer + state])) return entry[layer + state];
    if (Array.isArray(entry[layer])) return entry[layer];
    return null;
  }

  // ── drawing ───────────────────────────────────────────────────────────

  draw() {
    const { ctx, camera } = this;
    const ratio = this.ratio || 1;
    const viewW = this.canvas.width / ratio;
    const viewH = this.canvas.height / ratio;

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = this.theme.void; // beyond the yard
    ctx.fillRect(0, 0, viewW, viewH);

    ctx.save();
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    this.drawGround(viewW, viewH);

    for (const decal of this.effects) this.drawEffect(decal);
    for (const b of this.buildings) this.drawBuilding(b, "shadow");
    if (this.hovered && this.hovered !== this.selected) this.drawFootprint(this.hovered, false);
    if (this.selected) this.drawFootprint(this.selected, true);
    // Building tops, pen creatures, and mushrooms share one depth sort,
    // painted from the top of the yard downward. Each item sorts by the
    // BOTTOM of its footprint (origin y + size/2): sorting by the origin
    // alone lets a large building behind a small one paint over it.
    const layerItems = [
      ...this.buildings.map((b) => ({
        y: b.y + this.gameData.footprint(b.t) / 2,
        draw: () => this.drawBuilding(b, "top"),
      })),
      // Pen occupants sort against their own home rather than by raw y. The
      // cage sprite is one image: its lower half is the front wall and must
      // occlude an occupant standing there, while its upper half is the back
      // wall and the occupant should cover it. So anything in the back half
      // (above the home origin) draws just after the building, and anything
      // in the front half just before it. `sub` breaks ties by the
      // occupant's own y, so of two champions the lower one paints last.
      ...this.penEntities.map((e) => {
        const homeDepth = e.home && e.homeType
          ? e.home.y + this.gameData.footprint(e.homeType) / 2
          : e.y;
        const inBackHalf = e.home ? e.y < e.home.y : false;
        return {
          y: homeDepth + (inBackHalf ? 0.5 : -0.5),
          sub: e.y,
          draw: () => this.drawPenEntity(e),
        };
      }),
      ...this.mushrooms.map((shroom) => ({
        y: Number(shroom?.y ?? 0),
        draw: () => this.drawMushroom(shroom),
      })),
    ].sort((a, b) => a.y - b.y || (a.sub ?? 0) - (b.sub ?? 0));
    for (const item of layerItems) item.draw();

    // BuildingOverlay is a child of the building's own clip in game, so it
    // sits inside the camera transform and scales with zoom.
    for (const b of this.buildings) this.drawBuildingOverlay(b);
    this.hasCountdowns = this.buildings.some(
      (b) => b.buildEndsAt || b.upgradeEndsAt || b.fortifyEndsAt,
    );

    // Screen-space overlays (constant size regardless of zoom)
    ctx.restore();
    ctx.save();
    if (this.hovered) this.drawTooltip(this.hovered);
    ctx.restore();
  }



  worldToScreen(x, y) {
    return {
      x: (x - this.camera.x) * this.camera.zoom,
      y: (y - this.camera.y) * this.camera.zoom,
    };
  }

  // Building coordinates in a base save are cartesian and centred on the
  // origin (kit layouts contain negative X/Y), so the yard diamond is centred
  // on (0,0) too. YARD_HALF is the default half-extent; expandable yards
  // override it via setYardExtent().
  traceYardDiamond() {
    const { ctx } = this;
    const half = this.yardHalf || YARD_HALF;
    ctx.beginPath();
    ctx.moveTo(0, -half);
    ctx.lineTo(half * 2, 0);
    ctx.lineTo(0, half);
    ctx.lineTo(-half * 2, 0);
    ctx.closePath();
  }

  drawGround(viewW, viewH) {
    const { ctx, camera } = this;
    ctx.save();
    this.traceYardDiamond();
    ctx.clip();

    // Base tone under the tiles (visible until they load / at far zoom)
    ctx.fillStyle = this.theme.base;
    ctx.fill();

    // Rect-tile the isograss variants across the visible clipped region,
    // variant chosen by a stable per-cell hash so the mix never flickers.
    const half = this.yardHalf || YARD_HALF;
    const left = Math.max(camera.x, -half * 2);
    const top = Math.max(camera.y, -half);
    const right = Math.min(camera.x + viewW / camera.zoom, half * 2);
    const bottom = Math.min(camera.y + viewH / camera.zoom, half);
    const startGX = Math.floor(left / GRASS_W) * GRASS_W;
    const startGY = Math.floor(top / GRASS_H) * GRASS_H;
    const ground = this.buildGround();
    if (ground) {
      // MAPBG mega-tile: seamless 1000x500 composite, tiled on its own grid.
      const megaX = Math.floor(startGX / GROUND_W) * GROUND_W;
      const megaY = Math.floor(startGY / GROUND_H) * GROUND_H;
      for (let gy = megaY; gy < bottom; gy += GROUND_H) {
        for (let gx = megaX; gx < right; gx += GROUND_W) {
          ctx.drawImage(ground, gx, gy);
        }
      }
    } else {
      // Fallback while tile sprites stream in.
      for (let gy = startGY; gy < bottom; gy += GRASS_H) {
        for (let gx = startGX; gx < right; gx += GRASS_W) {
          const tiles = this.theme.tiles;
          const hash = Math.abs(((gx / GRASS_W) * 73856093) ^ ((gy / GRASS_H) * 19349663)) % tiles.length;
          const path = tiles[hash];
          const entry = this.sprite(path.startsWith("/") ? path : this.assetBase + path);
          if (entry.ready) ctx.drawImage(entry.img, gx, gy);
        }
      }
    }

    // 20-unit build lattice, only inside the yard, only when zoomed in.
    if (camera.zoom > 0.5) {
      ctx.lineWidth = 1 / camera.zoom;
      ctx.strokeStyle = this.theme.grid;
      ctx.beginPath();
      const rise = (right - left) * 0.5;
      const start = Math.floor((top - rise) / CELL) * CELL;
      for (let c = start; c < bottom + rise; c += CELL) {
        ctx.moveTo(left, c);
        ctx.lineTo(right, c + rise);
        ctx.moveTo(left, c);
        ctx.lineTo(right, c - rise);
      }
      ctx.stroke();
    }
    ctx.restore();

    // Yard edge. Viewing your own yard, the game draws this as a bright white
    // boundary marking the buildable area; someone else's base gets the plain
    // dark edge, so it stays obvious whose yard you are looking at.
    this.traceYardDiamond();
    if (this.isOwnYard) {
      ctx.lineWidth = 4 / camera.zoom;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.stroke();
      ctx.lineWidth = 1 / camera.zoom;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
      ctx.stroke();
    } else {
      ctx.lineWidth = 3 / camera.zoom;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
      ctx.stroke();
    }
  }

  /** True when this building has any animation sheet for its state - the
   *  Monster Bunker and a few others ship only an anim, no static top. */
  hasAnimLayer(b, bundle) {
    if (!bundle || !bundle.entry || b.state === "destroyed") return false;
    const suffix = b.state === "damaged" ? "damaged" : "";
    return ["anim", "anim2", "anim3"].some((key) => {
      const spec = bundle.entry[key + suffix];
      return Array.isArray(spec) && spec.length >= 3;
    });
  }

  drawBuilding(b, layer) {
    const { ctx } = this;
    if (layer === "top") this.drawFortLayer(b, "back");
    const bundle = this.gameData.imagesForLevel(b.t, this.effectiveLevel(b.t, b.l));
    if (!bundle || !bundle.entry) {
      if (layer === "top") this.drawPlaceholder(b);
      return;
    }
    // Only fall back to the highlight placeholder when this building has no
    // art at all for this layer - an anim-only building draws below.
    const spec = this.layerSpec(bundle.entry, layer, b.state);
    const animates = this.hasAnimLayer(b, bundle);
    if (spec) {
      const [file, offset] = spec;
      const entry = this.sprite(this.assetBase + bundle.baseurl + file);
      if (entry.failed && layer === "top") {
        if (!animates) this.drawPlaceholder(b);
      } else if (entry.ready) {
        const [ox, oy] = Array.isArray(offset) ? offset : [0, 0];
        if (layer === "shadow") {
          ctx.save();
          // BFOUNDATION renders shadows with BlendMode.MULTIPLY, full alpha.
          ctx.globalCompositeOperation = "multiply";
          ctx.drawImage(entry.img, b.x + ox, b.y + oy);
          ctx.restore();
        } else {
          ctx.drawImage(entry.img, b.x + ox, b.y + oy);
        }
      }
    } else if (layer === "top" && !animates) {
      this.drawPlaceholder(b);
    }

    // Animation layers ride on top of the "top" sprite (skip when destroyed).
    if (layer === "top" && b.state !== "destroyed") {
      for (const animKey of ["anim", "anim2", "anim3"]) {
        this.drawAnim(b, bundle, animKey);
      }
    }
    // Fortification front piece sits in front of everything on this building.
    if (layer === "top") this.drawFortLayer(b, "front");
  }

  drawAnim(b, bundle, animKey) {
    // State-exact lookup, mirroring setupImage's 'anim' + state indexing —
    // no fallback: a damaged building animates only when the bucket ships
    // an animdamaged sheet.
    const stateSuffix = b.state === "damaged" ? "damaged" : "";
    const spec = bundle.entry[animKey + stateSuffix];
    if (!Array.isArray(spec) || spec.length < 3) return;
    const [file, rect, frames] = spec;
    if (!Array.isArray(rect) || !frames) return;
    const entry = this.sprite(this.assetBase + bundle.baseurl + file);
    if (!entry.ready) return;
    const [rx, ry, fw, fh] = rect;

    // Turret barrels are direction sheets: pick the frame that points at the
    // aim point (pointer, or last tap on touch) rather than looping. Done
    // before every other rule, including the "animations off" toggle, because
    // this is orientation, not animation.
    if (TURRET_TYPES.has(b.t)) {
      const frame = this.turretFrame(b, frames);
      this.ctx.drawImage(entry.img, frame * fw, 0, fw, fh, b.x + rx, b.y + ry, fw, fh);
      return;
    }

    let frame;
    if (b.t === 6) {
      // BUILDING6: the anim strip is a storage-fullness gauge, not a loop -
      // it keeps its state frame even with animations disabled.
      frame = Math.min(this.siloFrame ?? 0, frames - 1);
    } else if (!this.buildingAnimations || !this.shouldAnimate(b)) {
      frame = 0; // resting frame
    } else if (b.t === 13) {
      // BUILDING13 runs at half rate (TickFast: every 2nd frame).
      frame = Math.floor(performance.now() / HATCH_FRAME_MS) % frames;
    } else {
      // BFOUNDATION Setup: _animTick starts at int(random() * (frames - 2)),
      // except types 9/19/25/54 which start at 0; advance per ENTER_FRAME.
      const start = ANIM_START_AT_ZERO.has(b.t) ? 0 : Math.floor(b.animPhase * Math.max(0, frames - 2));
      frame = (Math.floor(performance.now() / ANIM_FRAME_MS) + start) % frames;
    }
    this.ctx.drawImage(entry.img, frame * fw, 0, fw, fh, b.x + rx, b.y + ry, fw, fh);
  }

  /** Whether this building's looping strip should be running right now. */
  shouldAnimate(b) {
    if (NEVER_ANIMATE.has(b.t)) return false;

    // Nothing animates while the building is mid-job: BFOUNDATION gates every
    // anim on _countdownBuild + _countdownUpgrade == 0, and the same applies
    // to fortifying and rebuilding.
    const raw = b.raw || {};
    if (b.buildEndsAt || b.upgradeEndsAt || b.fortifyEndsAt || b.rebuildEndsAt) {
      return false;
    }

    // Resource gatherers stop once their store is full - a full collector is
    // idle, not working. Outposts are exempt: their gatherers keep running.
    if (b.harvest && !this.isOutpost && b.harvest.storedNow() >= b.harvest.capacity) {
      return false;
    }

    const busy = BUSY_ANIMATE.get(b.t);
    return busy ? Boolean(busy(raw, this)) : true;
  }

  /**
   * Direction frame for a turret, following BTOWER.Rotate.
   *
   * The game works in PATHING (cartesian grid) space, so both the tower and
   * the aim point are converted out of isometric screen space first, then
   * atan2 gives the heading and int(angle / 11.25) the frame. Sheets that
   * ship fewer than 32 frames are mapped proportionally rather than clamped,
   * so the full circle stays reachable.
   */
  turretFrame(b, frames) {
    if (!this.aimPoint) return 0; // untouched: rests bottom-right, as in game
    const headings = Math.min(frames, TURRET_HEADINGS_BY_TYPE.get(b.t) || TURRET_HEADINGS);
    const muzzle = YardRenderer.fromIso(b.x, b.y);
    const target = YardRenderer.fromIso(this.aimPoint.x, this.aimPoint.y);
    let angle = Math.atan2(target.y - (muzzle.y + 35), target.x - (muzzle.x + 35)) * 57.2957795;
    if (angle < 0) angle += 360;
    return Math.min(headings - 1, Math.floor((angle / 360) * headings));
  }

  /**
   * Points every turret at a world coordinate. Called on pointer movement,
   * and on tap for touch devices where there is no hover to follow.
   */
  setAimPoint(point) {
    if (!point) {
      if (!this.aimPoint) return;
      this.aimPoint = null;
      this.invalidate();
      return;
    }
    const previous = this.aimPoint;
    // Sub-pixel jitter cannot change a 11.25-degree bucket; skipping those
    // redraws keeps a still pointer from forcing repaints.
    if (previous && Math.abs(previous.x - point.x) < 2 && Math.abs(previous.y - point.y) < 2) {
      return;
    }
    this.aimPoint = { x: point.x, y: point.y };
    this.invalidate();
  }

  drawEffect(decal) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 0.35;
    const gradient = ctx.createRadialGradient(decal.x, decal.y, 2, decal.x, decal.y, 22);
    gradient.addColorStop(0, "rgba(20, 12, 6, 0.9)");
    gradient.addColorStop(1, "rgba(20, 12, 6, 0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.ellipse(decal.x, decal.y, 24, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawMushroom(shroom) {
    const entry = this.sprite(this.assetBase + "buildingthumbs/7.png");
    if (!entry.ready) return;
    // The game draws mushrooms from an embedded MovieClip (doodad_mushroom_mc)
    // that isn't downloadable, so this stands in with the 40x40 thumb scaled
    // up to roughly the doodad's on-screen size, keeping a little per-frame
    // size variety. Anchored so the stem sits on the ground point.
    const scale = 1.05 + (shroom.frame % 3) * 0.18;
    const w = 40 * scale;
    this.ctx.drawImage(entry.img, shroom.x - w / 2, shroom.y - w * 0.8, w, w);
  }


  // ── Pens: housed creeps + champion (HOUSING.as / CHAMPIONCAGE.as) ────
  // PointInHouse: house grid point + (40 + rand*80, 40 + rand*80), to iso.
  // PointInCage:  cage grid point + (40 + rand*40, 40 + rand*40), to iso.
  // Wander (tickBPen / ChampionBase): after a 240-frame warmup, each frame
  // has a 1/200 (creep) or 1/150 (champion) chance to pick a new target;
  // pen speed = moveSpeed * 0.5 * 0.5; rotation = atan2(dy, dx) degrees.
  static fromIso(ix, iy) {
    return { x: iy + ix / 2, y: iy - ix / 2 };
  }

  static toIsoPoint(gx, gy) {
    return { x: gx - gy, y: (gx + gy) * 0.5 };
  }

  pointInPen(anchor, size, offset = 40) {
    // offset positions the pen rect inside the anchor building's footprint:
    // the cage/housing rects start at (40,40) in a 200-unit building, but a
    // smaller building (the 64-unit Champion Chamber) needs a smaller inset
    // or the roam area falls entirely OUTSIDE the building.
    const grid = YardRenderer.fromIso(anchor.x, anchor.y);
    const gx = grid.x + offset + Math.random() * size;
    const gy = grid.y + offset + Math.random() * size;
    return YardRenderer.toIsoPoint(gx, gy);
  }

  /** entities: [{id, kind:"creep"|"guardian", sheet:[file,w,h,mx,my],
   *  speed, dirs, home:{x,y}, penSize, rowFn?}] — positions seeded like
   *  the spawn calls (random point in pen, random angle). */
  /**
   * BUILDING6.Update: silo fill frame = int(26 * (r1+..+r4) / (r1max+..+r4max)).
   * The sheet has 26 cells (0..25); at exactly full the source computes 26,
   * whose copyPixels is out of bounds and no-ops in Flash — so the visible
   * ceiling is cell 25, which we clamp to explicitly.
   */
  setResources(resources) {
    const res = resources && typeof resources === "object" ? resources : {};
    this.resources = res;
    let cur = 0;
    let max = 0;
    for (let i = 1; i < 5; i++) { //   the source's 1..4 loop
      cur += Number(res["r" + i]) || 0;
      max += Number(res["r" + i + "max"]) || 0;
    }
    const frame = max > 0 ? Math.min(25, Math.trunc((26 / max) * cur)) : 0;
    if (frame !== this.siloFrame) {
      this.siloFrame = frame;
      this.invalidate();
    }
  }

  setPenEntities(entities) {
    this.penEntities = (entities || []).map((spec) => {
      const start = this.pointInPen(spec.home, spec.penSize, spec.penOffset);
      return {
        ...spec,
        x: start.x,
        y: start.y,
        target: this.pointInPen(spec.home, spec.penSize, spec.penOffset),
        rotation: Math.random() * 360,
        frame: 0,
        moving: true,
      };
    });
    this.hasAnimations = this.hasAnimations || this.penEntities.length > 0;
    this.invalidate();
  }

  stepPens(steps) {
    for (const ent of this.penEntities) {
      for (let i = 0; i < steps; i++) {
        ent.frame++;
        const chance = ent.kind === "guardian" ? 150 : 200; // ChampionBase 1276 / tickBPen
        if (ent.frame > 240 && Math.floor(Math.random() * chance) === 1) {
          ent.target = this.pointInPen(ent.home, ent.penSize, ent.penOffset);
        }
        const dx = ent.target.x - ent.x;
        const dy = ent.target.y - ent.y;
        const dist = Math.hypot(dx, dy);
        // CreepBase/ChampionBase: _speed = moveSpeed * 0.5, halved again for
        // pen behaviour. Champions differ in that ChampionBase derives
        // moveSpeed as (guardian speed / 2) first, so they end up at an
        // eighth of their stat rather than a quarter.
        const base = ent.kind === "guardian" ? ent.speed * 0.5 : ent.speed;
        const speed = base * 0.5 * 0.5;
        if (dist > Math.max(1, speed)) {
          const angle = Math.atan2(dy, dx);
          ent.x += Math.cos(angle) * speed;
          ent.y += Math.sin(angle) * speed;
          ent.rotation = ((angle * 57.2957795) % 360 + 360) % 360;
          ent.moving = true;
        } else {
          ent.moving = false;
        }
      }
    }
  }

  drawPenEntity(ent) {
    // Sheets are tried best-first: a missing evolution sheet upstream falls
    // back to a neighbouring one rather than leaving the champion invisible.
    // Only a failed candidate advances to the next, so the normal case still
    // issues exactly one request.
    const candidates = Array.isArray(ent.sheets) && ent.sheets.length ? ent.sheets : [ent.sheet];
    let sheet = null;
    let entry = null;
    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) continue;
      const found = this.sprite(this.assetBase + candidate[0]);
      if (found.failed) continue;
      sheet = candidate;
      entry = found;
      break;
    }
    if (!sheet) {
      if (!this.warnedSheets) this.warnedSheets = new Set();
      if (!this.warnedSheets.has(ent.id)) {
        this.warnedSheets.add(ent.id);
        const tried = candidates.map((c) => this.assetBase + c[0]).join(", ");
        console.warn(`[BaseView] No sprite sheet loaded for pen entity "${ent.id}" - it cannot render. Tried: ${tried}`);
      }
      return;
    }
    if (!entry.ready) return;
    const [, cw, ch, mx, my] = sheet;
    // Derive the sheet grid from the ACTUAL image instead of trusting the
    // assumed direction/row counts. The old hard bounds check silently drew
    // nothing whenever an assumed frame fell outside the real sheet - which
    // made champions with fewer columns/rows than expected (Korath, Krallen)
    // invisible, and left others (Fomor) frozen at directions whose frames
    // didn't exist. Mapping rotation across the real column count and
    // wrapping rows keeps every champion visible with its nearest frame,
    // and is bit-identical when the sheet matches the assumptions.
    const cols = Math.max(1, Math.floor(entry.img.width / Math.max(1, Math.floor(cw))));
    const rows = Math.max(1, Math.floor(entry.img.height / Math.max(1, ch)));
    const rotation = ((Number(ent.rotation) || 0) % 360 + 360) % 360;
    const col = Math.min(cols - 1, Math.floor((rotation / 360) * cols));
    const row = (ent.rowFn ? ent.rowFn(ent.moving, ent.frame) : 0) % rows;
    const sx = Math.floor(cw * col);
    const sy = Math.floor(ch * row);
    this.ctx.drawImage(entry.img, sx, sy, Math.floor(cw), ch,
      ent.x - mx, ent.y - my, Math.floor(cw), ch);
  }

  drawChampion(champ) {
    const { ctx } = this;
    const entry = this.sprite(this.assetBase + `monsters/G${champ.t}_L${Math.max(1, Math.min(6, champ.l))}-150.png`);
    if (!entry.ready) return;
    const w = entry.img.width;
    const h = entry.img.height;
    ctx.save();
    if (champ.frozen) ctx.globalAlpha = 0.65;
    // Shadow blob under the champion
    ctx.beginPath();
    ctx.ellipse(champ.x, champ.y + 4, w * 0.32, w * 0.12, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fill();
    ctx.drawImage(entry.img, champ.x - w / 2, champ.y - h + 12);
    ctx.restore();
  }

  drawPlaceholder(b) {
    const { ctx } = this;
    const size = this.gameData.footprint(b.t);
    this.traceDiamond(b, size);
    ctx.fillStyle = "rgba(164, 226, 46, 0.12)";
    ctx.fill();
    ctx.strokeStyle = "rgba(164, 226, 46, 0.5)";
    ctx.lineWidth = 1 / this.camera.zoom;
    ctx.stroke();
  }

  drawFootprint(b, selected) {
    const { ctx } = this;
    const size = this.gameData.footprint(b.t);
    this.traceDiamond(b, size);
    ctx.fillStyle = selected ? "rgba(164, 226, 46, 0.20)" : "rgba(255, 255, 255, 0.10)";
    ctx.fill();
    ctx.strokeStyle = selected ? "#a4e22e" : "rgba(255, 255, 255, 0.45)";
    ctx.lineWidth = (selected ? 2 : 1) / this.camera.zoom;
    ctx.stroke();
  }

  traceDiamond(b, size) {
    const { ctx } = this;
    const halfW = size;      // cartesian size × size square projects to a
    const halfH = size / 2;  // 2·size × size screen diamond, top at origin
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x + halfW, b.y + halfH);
    ctx.lineTo(b.x, b.y + halfH * 2);
    ctx.lineTo(b.x - halfW, b.y + halfH);
    ctx.closePath();
  }

  // ── screen-space overlays ─────────────────────────────────────────────

  /**
   * BuildingOverlay.Update: a state label, a progress bar and a health bar,
   * anchored at the building origin (plus _overlayOffset, which nothing in
   * the codebase ever sets away from 0,0).
   *
   *   label     51-wide slot at (-26, -32), 21px tall, centred in the slot
   *   progress  51x6 at (-26, -20)
   *   health    51x6 at (-26, -14)
   *
   * The game never draws a clock over a building - the remaining time only
   * shows in the worker queue - so neither do we.
   */
  drawBuildingOverlay(b) {
    const now = Date.now();
    if (b.buildEndsAt && b.buildEndsAt <= now) b.buildEndsAt = 0;
    if (b.upgradeEndsAt && b.upgradeEndsAt <= now) b.upgradeEndsAt = 0;
    if (b.fortifyEndsAt && b.fortifyEndsAt <= now) b.fortifyEndsAt = 0;

    let label = "";
    let row = -1;
    if (b.repairing) {
      // Repairing sets the label and then blanks the progress bitmap.
      label = OVERLAY_LABELS.repairing;
    } else if (b.buildEndsAt) {
      label = OVERLAY_LABELS.building;
      row = overlayProgressRow(b.buildTotal, (b.buildEndsAt - now) / 1000);
    } else if (b.upgradeEndsAt) {
      label = OVERLAY_LABELS.upgrading;
      row = overlayProgressRow(b.upgradeTotal, (b.upgradeEndsAt - now) / 1000);
    } else if (b.fortifyEndsAt) {
      label = OVERLAY_LABELS.fortifying;
      row = overlayProgressRow(b.fortifyTotal, (b.fortifyEndsAt - now) / 1000);
    }

    const hpRow = b.state === "destroyed" ? -1 : overlayHealthRow(b.hp, b.maxHp);
    if (!label && hpRow < 0) return;

    const { ctx } = this;
    const left = b.x - 26;
    if (label) {
      ctx.save();
      // ImageText.Get(text, 9, 0.6, [GlowFilter(0, 1, 2, 2, 4, 1)]) - 9px
      // with a tight black glow, which a round-joined stroke reproduces.
      // Same stack the yard's other canvas text uses, so the overlay labels
      // and the tooltips are set in one face. "GROBOLDpro" is not a family
      // anything here declares - the @font-face names are Groboldov and
      // Grobold - so it is only ever hit when the font is installed locally;
      // it stays first for those machines, with the real webfont behind it.
      // ImageText.Get sets the overlay labels in Groboldov; the aliases in
      // front cover machines with the client's fonts installed locally.
      ctx.font = `700 ${OVERLAY_LABEL_SIZE}px GROBOLDpro, Groboldov, GROBOLD,`
        + ` Grobold, Verdana, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.lineJoin = "round";
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#000";
      ctx.strokeText(label, left + OVERLAY_W / 2, b.y + OVERLAY_LABEL_TOP);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, left + OVERLAY_W / 2, b.y + OVERLAY_LABEL_TOP);
      ctx.restore();
    }
    if (row >= 0) {
      const strip = this.sprite(OVERLAY_PROGRESS);
      if (strip.ready) {
        ctx.drawImage(strip.img, 0, OVERLAY_ROW_H * row, OVERLAY_W, OVERLAY_ROW_H,
          left, b.y - 20, OVERLAY_W, OVERLAY_ROW_H);
      }
    }
    if (hpRow >= 0) {
      const strip = this.sprite(OVERLAY_HP);
      if (strip.ready) {
        ctx.drawImage(strip.img, 0, OVERLAY_ROW_H * hpRow, OVERLAY_W, OVERLAY_ROW_H,
          left, b.y - 14, OVERLAY_W, OVERLAY_ROW_H);
      }
    }
  }


  drawTooltip(b) {
    const name = this.gameData.displayName(b.t);
    const label = `${name} · Lv ${b.l}` + (b.state ? ` · ${b.state}` : "");
    const size = this.gameData.footprint(b.t);
    const pos = this.worldToScreen(b.x, b.y);
    this.drawPill(pos.x, pos.y - Math.max(24, size * 0.4 * this.camera.zoom), label, "#ece5cf");
  }

  drawPill(cx, cy, text, color) {
    const { ctx } = this;
    ctx.font = "700 12px GROBOLDpro,Groboldov,GROBOLD,Grobold,Verdana,sans-serif";
    const width = ctx.measureText(text).width + 16;
    const height = 20;
    const x = cx - width / 2;
    const y = cy - height / 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, width, height, 10);
    else ctx.rect(x, y, width, height);
    ctx.fillStyle = "rgba(13, 19, 10, 0.85)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cx, cy + 0.5);
  }
}

