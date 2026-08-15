import {
  ASSET_PATHS,
  CELL_HEX_EDGES,
  CELL_HEX_VERTICES,
  CELL_ART_BOUNDS,
  CELL_ART_PLACEMENT,
  MAPROOM_UI,
  MCBG_ASPECT,
  MC_PLAYER_ANCHOR,
  NAME_BAR,
  NAME_BAR_COLOURS,
  NAME_BAR_CONTRAST_THRESHOLD,
  NAME_BAR_EMPTY_DARKEN,
  NAME_BAR_MAX_DISPLAY_DAMAGE,
  NAME_BAR_OUTLINE,
  NAME_TEXT,
  LEVEL_PLACEMENT,
  PROTECTION_BOUNDS,
  PROTECTION_PLACEMENT,
  TERRAIN_BANDS,
  TERRAIN_TILE_PATH,
  TERRAIN_TILE_W,
  TERRAIN_TILE_H,
  WATER_SURFACE_FILL,
  cellLift,
  colourDistance,
  darkenHex,
  terrainFrameFor,
  waterSurfaceLift,
  MR2,
  cellKey,
  formatCompactNumber,
  formatRelativeTime,
  getCellLootTotal,
  TRIBE_CELL_ASSETS,
  clamp,
  createEmptyRendererBaseFilter,
  cubeToOffset,
  getFlingerRange,
  generatedWildCell,
  getHexDistance,
  getOutpostKitKey,
  getOutpostKitSuffix,
  getTerrainBand,
  getTribeKey,
  isCollinear,
  makeEdgeKey,
  normalizeRendererBaseFilter,
  offsetToCube,
  parseVertexKey,
  pointInHex,
  positiveModulo,
  samePoint,
  storageGetServerMap,
  debugLog,
  storagePostServerZones,
  vertexKey,
  zoneKey,
  zoneOriginForCell,
} from "./shared.js";
import { FETCH_PRIORITY, ZONE_PACER_BYPASS_PRIORITY } from "./api-client.js";

const WHEEL_ZOOM_MULTIPLIER = 1.14;
const LABEL_RENDER_ZOOM_MIN = 0.42;const DEFAULT_MAP_ZOOM = 0.7;

// Loot label per-resource styling. r1..r4 are the BYM resources in canonical
// order (Twigs, Pebbles, Putty, Goo); "total" sums them (getCellLootTotal).
const LOOT_RESOURCE_STYLES = {
  tier: { label: "Loot percentile", color: "#ffd97a" },
  total: { label: "Loot", color: "#ffd97a" },
  r1: { label: "Twigs", color: "#e6c98a" },
  r2: { label: "Pebbles", color: "#a9c2d6" },
  r3: { label: "Putty", color: "#e3a6d4" },
  r4: { label: "Goo", color: "#8fd6a0" },
};
const LOOT_RESOURCE_KEYS = ["tier", "total", "r1", "r2", "r3", "r4"];
/**
 * The zoom ladder.
 *
 * One wheel notch multiplies zoom by WHEEL_ZOOM_MULTIPLIER, so the reachable
 * zooms form a geometric ladder. Step 1 is fully zoomed in (MAX_ZOOM) and each
 * step out divides by the ratio:
 *
 *   zoomForStep(n) = MAX_ZOOM / ratio^(n - 1)
 *
 * The old range (1.5 down to 0.08) was 23 steps, which is what a scroll from
 * one end to the other counted. ZOOM_STEPS extends that to 29, putting the
 * far end at ~0.038 - a little over twice as far out as before - and MIN_ZOOM
 * is derived from it so the bottom of the range always lands exactly on a
 * step instead of part-way between two.
 */
const ZOOM_STEPS = 29;
const SIMPLE_VIEW_FROM_STEP = 10;
// Below this zoom the renderer switches to a simplified level-of-detail:
// terrain as rectangles and bases as markers, so deep zoom-out stays smooth.

// Marker colours for the simplified far-zoom view. The full layout carries
// the same relationships on the name bar instead.
const ALLY_STROKE = "rgba(52, 214, 236, 0.95)";
const ENEMY_STROKE = "rgba(255, 92, 74, 0.95)";
const MAX_ZOOM = 1.5;
const MIN_ZOOM = MAX_ZOOM / (WHEEL_ZOOM_MULTIPLIER ** (ZOOM_STEPS - 1));

/** The zoom at a given ladder step (1 = fully zoomed in). */
function zoomForStep(step) {
  return MAX_ZOOM / (WHEEL_ZOOM_MULTIPLIER ** (step - 1));
}

/** Ladder step for an arbitrary zoom, which pinch and fit-to-view produce. */
function zoomStepFor(zoom) {
  return 1 + Math.log(MAX_ZOOM / zoom) / Math.log(WHEEL_ZOOM_MULTIPLIER);
}

// Steps 1..9 draw the full layout; 10 and beyond switch to the simplified
// view. The threshold is the geometric midpoint between steps 9 and 10, so a
// zoom landing exactly on a step is never ambiguous.
const LOD_SIMPLE_ZOOM = zoomForStep(SIMPLE_VIEW_FROM_STEP) * Math.sqrt(WHEEL_ZOOM_MULTIPLIER);
const FETCH_DEBOUNCE_MS = 160;

// Mirrors the server's persist-side minification (CELL_DROP_KEYS in
// dev_server.py): per-session and unread fields plus zero/empty defaults.
// normalizeCell restores every default on the way back in, so the round trip
// is lossless.
//
// "bid" is NOT dropped, despite what this list used to say. The server keeps
// it on purpose - View Yard loads a base through /base/load with it - but the
// client stripped it here before upload, so no zone in the shared cache has
// ever carried a base id. A zone fetched live this session had one; the same
// zone restored from cache did not, which is why anything counting or opening
// bases from cached cells behaved inconsistently.
// Floor between two forced zone reloads of the SAME zone (base-view opens).
// Matches the force path in refetchZones; a base id cannot go stale faster.
const ZONE_RELOAD_MIN_AGE_MS = 15 * 1000;

// Above this many changed cells, rebuilding the world bitmap outright beats
// patching them one at a time.
const WORLD_BITMAP_PATCH_LIMIT = 20000;

// Rows to probe either side when hit-testing. Relief shifts a cell's drawn
// position by up to +64px (deepest water) or -52px (highest land) against a
// 75px row pitch, so one row of slack on each side is not enough.
const RELIEF_PROBE_ROWS = 2;

const CELL_CACHE_DROP_KEYS = new Set([
  "m", "mine", "blendedHeight",
  // Per-session render memo. Uploading it would leak which cells are hidden
  // and which tribe they are pretending to be.
  "hiddenDisguise",
]);
// Avatars are only kept on main yards; outposts repeating the same URL are
// pure cache bloat (the profile photo lookup walks all of a player's cells
// and finds the main's copy anyway).
const CELL_CACHE_PIC_KEYS = new Set(["pic_square", "im", "pic", "picSquare", "avatar", "avatarUrl", "img", "picture"]);
const CELL_CACHE_MAIN_YARD = 2;
const CELL_CACHE_KEEP_KEYS = new Set(["x", "y", "i"]);

function minifyCellForCache(cell) {
  const out = {};
  for (const [key, value] of Object.entries(cell)) {
    if (CELL_CACHE_DROP_KEYS.has(key)) {
      continue;
    }
    if (CELL_CACHE_PIC_KEYS.has(key) && Number(cell.b || 0) !== CELL_CACHE_MAIN_YARD) {
      continue;
    }
    if (!CELL_CACHE_KEEP_KEYS.has(key)) {
      if (value === 0 || value === null || value === "" ||
          (Array.isArray(value) && !value.length) ||
          (value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length)) {
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

export class MapRenderer {
  constructor({ canvas, overlayEl, coordsEl, statusEl, assets, api, onHoverCell, onSelectCell }) {
    this.canvas = canvas;
    this.overlayEl = overlayEl;
    this.guestMode = false;
    this.overlayMessageEl = null;
    this.overlayProgressEl = null;
    this.overlayProgressFillEl = null;
    this.coordsEl = coordsEl;
    this.statusEl = statusEl;
    this.assets = assets;
    this.api = api;
    this.onHoverCell = onHoverCell;
    this.onSelectCell = onSelectCell;

    this.ctx = this.canvas.getContext("2d", { alpha: false });
    this.token = null;
    this.currentUserId = null;
    this.mapMeta = null;
    this.cellCache = new Map();
    this.loadedZones = new Map();
    this.pendingZones = new Set();
    // Bumped whenever the cell cache is written to. Anything derived from the
    // whole cache (currently the range-highlight set) memoises against it
    // rather than recomputing per frame.
    this.cacheVersion = 0;
    this.worldBitmap = null;
    this.worldBitmapVersion = -1;
    // Cells written since the bitmap was last built. A zone merge touches a
    // few hundred; repainting those pixels is far cheaper than the ~120ms
    // full rebuild, which is reserved for a cold start or a bulk change.
    this.worldBitmapDirty = [];
    this.baseCellIndex = [];
    this.baseCellVersion = -1;
    this.rangeHighlightVersion = -1;
    this.rangeHighlightKeys = new Set();
    // key -> in-flight reloadZoneNow promise, so base opens in the same zone
    // share one fetch instead of racing identical ones.
    this.zoneReloadsInFlight = new Map();
    this.zoneQueue = [];
    this.queuedZoneKeys = new Set();
    this.zoneWorkersActive = 0;
    this.zoneFetchGeneration = 0;
    this.onZonesSettled = null;
    // key -> Set of resolvers, so a caller can await ONE zone instead of the
    // whole queue draining (see awaitZoneKey / refetchZones).
    this.zoneKeyWaiters = new Map();
    this.zoneWaitStats = { successes: 0, failures: 0, firstError: null };
    this.jumpMarker = null;
    this.highlightNames = { allies: new Set(), enemies: new Set() };
    this.hiddenTileStyle = "tribe";
    // Zones holding the player's own bases / allied bases, for the tiered
    // freshness rules. Rebuilt on bootstrap and highlight changes, extended
    // incrementally during merges.
    this.ownZones = new Set();
    this.allyZones = new Set();
    // Split by base kind for the fetch-priority tiers: the main yard's zone
    // outranks the player's outposts, which outrank allied bases.
    this.ownMainZones = new Set();
    this.ownOutpostZones = new Set();
    this.showLoot = false;
    this.showOutpostTypes = false;
    this.showIdleWorkers = true;
    this.lootResource = "total";
    // Players hidden from the map for normal users (moderation). Empty for
    // administrators, who see everything.
    this.hiddenPlayerNames = new Set();
    // Main-yard name labels are collected during the cell pass and drawn
    // last, so they sit on top of every cell, overlay, and highlight.
    this.pendingMainLabels = [];
    this.onCellOwnershipChanges = null;
    this.scanState = null;
    this.measureMode = false;
    // Completed measurements: [{ a: {x,y}, b: {x,y} }], any number of them.
    this.measurements = [];
    // First point of an in-progress measurement (rubber-bands to the mouse).
    this.measureDraft = null;
    // A picked-up endpoint being repositioned: { index, end: "a"|"b" }.
    this.measureCarry = null;
    this.measurePointerInside = false;
    this.onMeasureUpdated = null;
    // Settles when the current world's full explored cache is hydrated;
    // the bootstraps hold the loading overlay on it.
    this.cacheHydrationDone = null;
    this.homeCellKey = null;
    this.hoveredCellKey = null;
    this.selectedCellKey = null;
    this.offsetX = 0;
    this.offsetY = 0;
    this.zoom = DEFAULT_MAP_ZOOM;
    this.zoomAnimationFrame = 0;
    this.panAnimationFrame = 0;
    this.fetchTimer = null;
    this.serverName = null;
    this.dirtyZoneKeys = new Set();
    this.persistTimer = null;
    this.baseFilter = createEmptyRendererBaseFilter();
    this.dragging = false;
    this.dragMoved = false;
    this.dragPointerId = null;
    this.dragLastPoint = null;
    this.activePointers = new Map();
    this.pinchState = null;
    this.lastPointer = { x: 0, y: 0 };
    this.viewportWidth = 0;
    this.viewportHeight = 0;

    this.canvas.addEventListener("pointerdown", (event) => this.handlePointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.handlePointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.handlePointerUp(event));
    this.canvas.addEventListener("pointercancel", (event) => this.handlePointerCancel(event));
    this.canvas.addEventListener("lostpointercapture", (event) => this.handlePointerCancel(event));
    this.canvas.addEventListener("pointerleave", () => this.handlePointerLeave());
    this.canvas.addEventListener("wheel", (event) => this.handleWheel(event), { passive: false });
    window.addEventListener("resize", () => this.render());
  }

  // Identifiers the worldmapv2/getarea request is scoped to (the signed-in
  // user and current world), mirroring what /base/load and /leaderboards send.
  zoneScope() {
    return {
      userid: this.currentUserId || undefined,
      worldid: this.mapMeta?.worldid || this.mapMeta?.worldId || undefined,
    };
  }

  // The map is interactive when a live session exists OR the guest view is
  // showing cached zones. Fetching, scanning, and persistence stay
  // token-gated - guests only ever read the shared cache.
  get interactive() {
    return Boolean(this.token || this.guestMode);
  }

  // Signed-out read-only view of one world's shared cache. Restores the
  // cached zones, never contacts the game server, and marks every zone
  // without cached data as "Not Cached" while rendering.
  async bootstrapGuest(serverName) {
    this.cancelAnimations();
    this.cancelWorldScan();
    this.settleZoneWait();
    this.token = null;
    this.currentUserId = null;
    this.mapMeta = null;
    this.guestMode = true;
    this.serverName = String(serverName || "").trim() || null;
    this.cellCache.clear();
    this.cacheVersion += 1;
    this.worldBitmap = null;
    this.worldBitmapDirty = [];
    this.loadedZones.clear();
    this.pendingZones.clear();
    this.zoneReloadsInFlight.clear();
    this.zoneQueue = [];
    this.queuedZoneKeys = new Set();
    this.dirtyZoneKeys.clear();
    this.homeCellKey = null;
    this.hoveredCellKey = null;
    this.selectedCellKey = null;
    this.jumpMarker = null;
    this.zoom = DEFAULT_MAP_ZOOM;
    this.zoneFetchGeneration += 1;
    const bootGeneration = this.zoneFetchGeneration;
    this.setOverlay("Loading cached map...");

    // Guests land on 0,0 rather than the middle of the world: it is a fixed,
    // nameable place, so a shared link and a cold open agree on where "the
    // start" is.
    this.centerOnCell(0, 0);
    let restored = false;
    if (this.serverName) {
      restored = await this.restoreExploredCache();
      this.rebuildFreshnessZones();
      // Same rule as the signed-in bootstrap: the overlay only drops once
      // the whole cached world is on the map.
      await (this.cacheHydrationDone || Promise.resolve());
      if (this.zoneFetchGeneration !== bootGeneration) {
        return this.loadedZones.size;
      }
    }
    this.setOverlay("");
    this.render();
    return restored ? this.loadedZones.size : 0;
  }

  async bootstrap(session) {
    // A guest view may be showing another world's cache; a real sign-in
    // starts from a clean slate so worlds never mix.
    if (this.guestMode) {
      this.guestMode = false;
      this.cellCache.clear();
    this.cacheVersion += 1;
    this.worldBitmap = null;
    this.worldBitmapDirty = [];
      this.loadedZones.clear();
    }
    this.cancelAnimations();
    this.cancelWorldScan();
    this.token = session.token;
    this.currentUserId = Number(session.user.userid || 0);
    this.mapMeta = session.map;
    this.settleZoneWait();
    this.cellCache.clear();
    this.cacheVersion += 1;
    this.worldBitmap = null;
    this.worldBitmapDirty = [];
    this.loadedZones.clear();
    this.pendingZones.clear();
    this.zoneReloadsInFlight.clear();
    this.zoneQueue = [];
    this.queuedZoneKeys = new Set();
    this.zoneFetchGeneration += 1;
    // The shared map cache lives on the viewer server under
    // server_{servername}/. The server name is the 0x0-style world id, which
    // only exists after sign-in has loaded /base/load — bootstrap runs after
    // that, so by this point it is guaranteed to be available (or genuinely
    // missing from the API response, in which case we fall back to the map
    // dimensions rather than mixing worlds into one directory).
    const worldId = String(this.mapMeta?.worldid || this.mapMeta?.worldId || "").trim();
    if (!worldId) {
      console.warn("[BYM-MR2] No world id in the session; using map dimensions as the cache server name.");
    }
    this.serverName = worldId || `${this.getMapWidth()}x${this.getMapHeight()}`;
    this.dirtyZoneKeys.clear();
    this.homeCellKey = null;
    this.hoveredCellKey = null;
    this.selectedCellKey = null;
    this.jumpMarker = null;
    this.zoom = DEFAULT_MAP_ZOOM;
    this.setOverlay("Loading live MR2 data...");
    this.setCoordinatesDisplay(null);

    const homebase = Array.isArray(this.mapMeta?.homebase) ? this.mapMeta.homebase : null;
    if (homebase && homebase.length === 2 && homebase[0] >= 0 && homebase[1] >= 0) {
      this.homeCellKey = cellKey(homebase[0], homebase[1]);
    }

    // Signing in always lands on your own main yard at 1:1, ahead of any
    // saved view state - the point of signing in is to see your own empire,
    // and a restored viewport from a previous session is rarely where you
    // wanted to start. Zoom is set before centring so centerOnCell measures
    // the viewport at the zoom it will actually be drawn at.
    this.zoom = 1;
    if (this.homeCellKey) {
      const home = this.getHomeCoordinates();
      this.centerOnCell(home.x, home.y);
    } else {
      this.centerOnCell(Math.floor(this.getMapWidth() / 2), Math.floor(this.getMapHeight() / 2));
    }

    const bootGeneration = this.zoneFetchGeneration;
    await this.restoreExploredCache();
    this.rebuildFreshnessZones();
    this.render();

    // The initial load holds the overlay until EVERY cached cell is on the
    // map, not just the viewport slice - cells popping in after the screen
    // "unlocked" read as the map being broken.
    this.setOverlay("Loading cached map cells...");
    await (this.cacheHydrationDone || Promise.resolve());
    if (this.zoneFetchGeneration !== bootGeneration) {
      return; // superseded by another bootstrap; it owns the overlay now
    }

    // Cached cells display immediately, but a fresh login always re-fetches
    // the zones in view so the player starts with current data.
    // Stage 1: live-fetch only zones holding the player's own bases and
    // wait for them - that is the data worth blocking the overlay on. The
    // rest of the viewport paints from cache and refreshes in the
    // background: allies first, then by proximity (stage 2/3 fall out of
    // the priority ordering).
    this.setOverlay("Loading live MR2 data...");
    await this.ensureCellsForViewport(true, { waitForCompletion: true, onlyOwn: true });
    this.ensureCellsForViewport(true).catch((error) => {
      console.warn("Background zone refresh failed.", error);
    });

    if (this.zoneFetchGeneration !== bootGeneration) {
      return;
    }
    this.setOverlay("");
    this.render();
  }

  // Forces a refetch of the zones currently in view. The rest of the
  // explored map (including full-world-scan progress) is deliberately kept:
  // clearing it here would also clobber the on-disk cache on the next
  // persist, throwing away everything outside the viewport.
  async refreshMapData() {
    if (!this.token) {
      return;
    }

    this.cancelAnimations();
    this.setOverlay("Refreshing live MR2 data...");
    this.render();

    try {
      // Stage 1: live-fetch only zones holding the player's own bases and
    // wait for them - that is the data worth blocking the overlay on. The
    // rest of the viewport paints from cache and refreshes in the
    // background: allies first, then by proximity (stage 2/3 fall out of
    // the priority ordering).
    await this.ensureCellsForViewport(true, { waitForCompletion: true, onlyOwn: true });
    this.ensureCellsForViewport(true).catch((error) => {
      console.warn("Background zone refresh failed.", error);
    });

      // Cell objects were replaced by the merge; re-emit hover/selection so
      // the details panel reflects the fresh data.
      this.onHoverCell(this.hoveredCellKey ? this.cellCache.get(this.hoveredCellKey) || null : null);
      this.onSelectCell(this.getSelectedCell());
    } finally {
      this.setOverlay("");
      this.render();
    }
  }

  reset(message) {
    this.cancelAnimations();
    this.cancelWorldScan();
    this.settleZoneWait();
    this.jumpMarker = null;
    this.measureMode = false;
    this.measurements = [];
    this.measureDraft = null;
    this.measureCarry = null;
    this.measurePointerInside = false;
    // setMeasureMode owns the cursor; a teardown mid-measure must not leave
    // the crosshair behind.
    this.canvas.style.cursor = "";
    this.token = null;
    this.currentUserId = null;
    this.mapMeta = null;
    this.guestMode = false;
    this.cellCache.clear();
    this.cacheVersion += 1;
    this.worldBitmap = null;
    this.worldBitmapDirty = [];
    this.loadedZones.clear();
    this.pendingZones.clear();
    this.zoneReloadsInFlight.clear();
    this.zoneQueue = [];
    this.queuedZoneKeys = new Set();
    this.zoneFetchGeneration += 1;
    this.homeCellKey = null;
    this.hoveredCellKey = null;
    this.selectedCellKey = null;
    this.offsetX = 0;
    this.offsetY = 0;
    this.zoom = DEFAULT_MAP_ZOOM;
    if (this.fetchTimer) {
      window.clearTimeout(this.fetchTimer);
      this.fetchTimer = null;
    }
    if (this.persistTimer) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.serverName = null;
    this.dirtyZoneKeys.clear();
    this.baseFilter = createEmptyRendererBaseFilter();
    this.dragging = false;
    this.dragMoved = false;
    this.dragPointerId = null;
    this.dragLastPoint = null;
    this.activePointers.clear();
    this.pinchState = null;
    this.setOverlay(message);
    this.setCoordinatesDisplay(null);
    this.onHoverCell(null);
    this.onSelectCell(null);
    this.render();
  }

  getSelectedCell() {
    return this.selectedCellKey ? this.cellCache.get(this.selectedCellKey) || null : null;
  }

  setBaseFilter(filter) {
    this.baseFilter = normalizeRendererBaseFilter(filter);

    const hoveredCell = this.hoveredCellKey ? this.cellCache.get(this.hoveredCellKey) || null : null;
    if (hoveredCell && !this.shouldDisplayBaseCell(hoveredCell)) {
      this.hoveredCellKey = null;
      this.onHoverCell(null);
    } else {
      this.onHoverCell(hoveredCell);
    }

    const selectedCell = this.getSelectedCell();
    if (selectedCell && !this.shouldDisplayBaseCell(selectedCell)) {
      this.selectedCellKey = null;
      this.onSelectCell(null);
    } else {
      this.onSelectCell(selectedCell);
    }

    this.render();
  }

  getAvailableWildBaseLevels() {
    const levels = new Set();

    for (const cell of this.cellCache.values()) {
      const metadata = this.getBaseFilterMetadata(cell);
      if (metadata && metadata.level > 0) {
        levels.add(metadata.level);
      }
    }

    return [...levels].sort((left, right) => left - right);
  }

  hasActiveBaseFilter() {
    return (
      this.baseFilter.types.size > 0 ||
      this.baseFilter.kits.size > 0 ||
      Number(this.baseFilter.levelMin || 0) > 0 ||
      Number(this.baseFilter.levelMax || 0) > 0 ||
      Boolean(this.baseFilter.bigOwners) ||
      Boolean(this.baseFilter.playerOwnerIds) ||
      Boolean(this.baseFilter.inactiveNames) ||
      this.baseFilter.heights.size > 0 ||
      this.baseFilter.owners.size > 0 ||
      this.baseFilter.tribes.size > 0 ||
      this.baseFilter.protection.size > 0 ||
      this.baseFilter.damageMin !== null ||
      this.baseFilter.damageMax !== null ||
      Boolean(this.baseFilter.flingerCells)
    );
  }

  isAlwaysVisibleOwnedBase(cell) {
    return (
      Number(cell.mine || 0) === 1 &&
      (Number(cell.b) === MR2.yardTypes.main || Number(cell.b) === MR2.yardTypes.outpost)
    );
  }

  shouldDisplayBaseCell(cell) {
    if (!this.doesContainDisplayableBase(cell)) {
      return false;
    }

    if (this.isCellHidden(cell)) {
      // A hidden base still draws - as the wild monster cell it is
      // masquerading as, via displayCell(). Search, filters, profiles and the
      // shared cache all continue to exclude it; this is a drawing decision
      // only. "water" is the one style that suppresses the marker, sinking
      // the tile to the waterline instead.
      return this.hiddenTileStyle !== "water";
    }

    if (!this.hasActiveBaseFilter()) {
      return true;
    }

    if (this.isAlwaysVisibleOwnedBase(cell)) {
      return true;
    }

    return this.matchesBaseFilter(cell);
  }

  // me / allies / enemies / other for a player-owned cell, from the relation
  // sets the app supplies with the filter. Without them everything reads as
  // "other" (a filter that needs them always ships them).
  resolveOwnerRelation(cell) {
    if (Number(cell.mine || 0) === 1) {
      return "me";
    }
    const rel = this.baseFilter.relSets;
    if (!rel) {
      return "other";
    }
    const owner = String(cell.n || "").trim().toLocaleLowerCase();
    if (!owner) {
      return "other";
    }
    if (rel.own?.has(owner)) return "me";
    if (rel.enemies?.has(owner)) return "enemies";
    if (rel.allies?.has(owner)) return "allies";
    return "other";
  }

  matchesPlayerOwnerFilter(cell) {
    const ownerIds = this.baseFilter.playerOwnerIds;
    if (!ownerIds || !ownerIds.size) {
      return false;
    }

    if (!ownerIds.has(Number(cell.uid || 0))) {
      return false;
    }

    return Number(cell.b) === MR2.yardTypes.main || Number(cell.b) === MR2.yardTypes.outpost;
  }

  matchesBaseFilter(cell) {
    if (this.baseFilter.playerOwnerIds && !this.matchesPlayerOwnerFilter(cell)) {
      return false;
    }

    if (this.baseFilter.inactiveNames) {
      // Only player-owned bases can be inactive; wild bases never match.
      const owner = String(cell.n || "").trim().toLocaleLowerCase();
      if (!owner || Number(cell.uid || 0) <= 0 || !this.baseFilter.inactiveNames.has(owner)) {
        return false;
      }
    }

    if (this.baseFilter.bigOwners) {
      // Big-fish filter: only bases (mains AND outposts) of players whose
      // outpost count clears the threshold.
      const owner = String(cell.n || "").trim().toLocaleLowerCase();
      if (!owner || Number(cell.uid || 0) <= 0 || !this.baseFilter.bigOwners.has(owner)) {
        return false;
      }
    }

    // Cell height: the terrain frame under the base, via the same accessor
    // the terrain painters use. Chips exist only for frames bases can stand
    // on, so a water anomaly passes through.
    if (this.baseFilter.heights.size > 0) {
      const frame = terrainFrameFor(this.terrainHeightFor(cell));
      if (this.baseFilter.heights.has("__none__") ||
          (frame.startsWith("water") ? false : !this.baseFilter.heights.has(frame))) {
        return false;
      }
    }

    // Owner relation constrains player bases only; wild cells pass through,
    // like the kit checklist does for mains.
    const isPlayerBase = Number(cell.b) === MR2.yardTypes.main
      || Number(cell.b) === MR2.yardTypes.outpost;
    if (this.baseFilter.owners.size > 0 && isPlayerBase) {
      if (!this.baseFilter.owners.has(this.resolveOwnerRelation(cell))) {
        return false;
      }
    }

    // Tribe constrains wild cells only; an unrecognized tribe passes.
    if (this.baseFilter.tribes.size > 0
        && Number(cell.b) === MR2.yardTypes.wildMonster) {
      const tribe = getTribeKey(cell);
      if (tribe && !this.baseFilter.tribes.has(tribe)) {
        return false;
      }
      if (this.baseFilter.tribes.has("__none__")) {
        return false;
      }
    }

    // Damage band: applies to every base cell (wilds carry damage too).
    const damageMin = this.baseFilter.damageMin;
    const damageMax = this.baseFilter.damageMax;
    if (damageMin !== null || damageMax !== null) {
      const damage = Number(cell.dm || 0);
      if (damageMin !== null && damage < damageMin) return false;
      if (damageMax !== null && damage > damageMax) return false;
    }

    // Damage protection: player bases only (wilds cannot bubble). cell.p is
    // the shield flag the popup's "Protection" row reads.
    if (this.baseFilter.protection.size > 0 && isPlayerBase) {
      const state = Number(cell.p || 0) === 1 ? "protected" : "unprotected";
      if (!this.baseFilter.protection.has(state)) return false;
    }

    // Flinger range: hex-disk reach of the chosen anchors, precomputed with
    // the same GetCellsInRange port that draws the range rings.
    if (this.baseFilter.flingerCells) {
      if (!this.baseFilter.flingerCells.has(cellKey(Number(cell.x || 0), Number(cell.y || 0)))) {
        return false;
      }
    }

    const needsMetadata = (
      this.baseFilter.types.size > 0 ||
      this.baseFilter.kits.size > 0 ||
      Number(this.baseFilter.levelMin || 0) > 0 ||
      Number(this.baseFilter.levelMax || 0) > 0
    );
    if (!needsMetadata) {
      return true;
    }

    const metadata = this.getBaseFilterMetadata(cell);
    if (!metadata) {
      return false;
    }

    if (this.baseFilter.types.size > 0 && !this.baseFilter.types.has(metadata.type)) {
      return false;
    }

    // The kit checklist constrains outposts only: mains and wild bases pass
    // through so unchecking "Ultra" hides ultra outposts without touching
    // the rest of the map.
    if (
      this.baseFilter.kits.size > 0 &&
      metadata.type === "outpost" &&
      !this.baseFilter.kits.has(metadata.kit)
    ) {
      return false;
    }

    // The level slider is "Wild monster level": player bases pass through.
    const levelMin = Number(this.baseFilter.levelMin || 0);
    const levelMax = Number(this.baseFilter.levelMax || 0);
    if (metadata.type === "wild") {
      if (levelMin > 0 && (metadata.level <= 0 || metadata.level < levelMin)) {
        return false;
      }
      if (levelMax > 0 && (metadata.level <= 0 || metadata.level > levelMax)) {
        return false;
      }
    }

    return true;
  }

  getVisibleBaseCount({ includePlayerBases = true } = {}) {
    let count = 0;

    for (const cell of this.cellCache.values()) {
      if (!this.shouldDisplayBaseCell(cell)) {
        continue;
      }

      if (!includePlayerBases && Number(cell.b) === MR2.yardTypes.main) {
        continue;
      }

      count += 1;
    }

    return count;
  }

  getBaseFilterMatchCount({ includePlayerBases = true } = {}) {
    let count = 0;
    const hasActiveFilter = this.hasActiveBaseFilter();

    for (const cell of this.cellCache.values()) {
      if (!this.doesContainDisplayableBase(cell)) {
        continue;
      }

      if (!includePlayerBases && Number(cell.b) === MR2.yardTypes.main) {
        continue;
      }

      if (hasActiveFilter && !this.matchesBaseFilter(cell)) {
        continue;
      }

      count += 1;
    }

    return count;
  }

  getBaseFilterMetadata(cell) {
    let type = null;
    switch (Number(cell.b)) {
      case MR2.yardTypes.wildMonster:
        type = "wild";
        break;
      case MR2.yardTypes.main:
        type = "main";
        break;
      case MR2.yardTypes.outpost:
        type = "outpost";
        break;
      default:
        return null;
    }

    const tribe = type === "wild" ? getTribeKey(cell) : null;
    // getarea reports v per cell from that cell's own save, so this is the
    // outpost's own empire value - the same signal the cell popup's Kit
    // line uses.
    const kit = type === "outpost" ? getOutpostKitKey(cell.v) : null;
    const level = Number(cell.l || 0);
    return { type, tribe, kit, level };
  }

  // Outpost count per player across the explored map - the data behind the
  // "big fish" outpost filter (lowercased name -> count).
  // Ownership-change records across the explored map, newest first, built
  // from the tt/po/pn/pb stamps the merge path leaves on cells. Shared-cache
  // hydration brings in records other viewers observed, so this covers the
  // whole world's known history, not just this session's.
  getRecentChangeRecords(limit = 200) {
    const records = [];
    for (const cell of this.cellCache.values()) {
      const at = Number(cell.tt || 0);
      if (!(at > 0)) {
        continue;
      }
      records.push({
        x: Number(cell.x),
        y: Number(cell.y),
        at,
        prevUid: Number(cell.po || 0),
        prevName: String(cell.pn || "").trim(),
        prevType: Number(cell.pb || 0),
        newUid: Number(cell.uid || 0),
        newName: String(cell.n || "").trim(),
        newType: Number(cell.b || 0),
      });
    }
    records.sort((left, right) => right.at - left.at);
    return records.slice(0, Math.max(1, limit));
  }

  // Per-owner outpost kit tallies (lowercased name -> {none, regular, mega,
  // ultra, total}) across the explored map. Same coverage caveat as
  // getOwnerOutpostCounts: it can only count outposts in zones this viewer
  // has actually cached.
  getOwnerKitCounts() {
    const counts = new Map();
    for (const cell of this.cellCache.values()) {
      if (Number(cell.b) !== MR2.yardTypes.outpost || Number(cell.uid || 0) <= 0) {
        continue;
      }
      const owner = String(cell.n || "").trim().toLocaleLowerCase();
      if (!owner) {
        continue;
      }
      let entry = counts.get(owner);
      if (!entry) {
        entry = { none: 0, regular: 0, mega: 0, ultra: 0, total: 0 };
        counts.set(owner, entry);
      }
      entry[getOutpostKitKey(cell.v)] += 1;
      entry.total += 1;
    }
    return counts;
  }

  getOwnerOutpostCounts() {
    const counts = new Map();
    for (const cell of this.cellCache.values()) {
      const baseType = Number(cell.b);
      if (Number(cell.uid || 0) <= 0) {
        continue;
      }
      const owner = String(cell.n || "").trim().toLocaleLowerCase();
      if (!owner) {
        continue;
      }
      if (baseType === MR2.yardTypes.outpost) {
        counts.set(owner, (counts.get(owner) || 0) + 1);
      } else if (baseType === MR2.yardTypes.main && !counts.has(owner)) {
        // Mains-only players legitimately have zero outposts - they must be
        // findable with a "max outposts" bound (the little fish).
        counts.set(owner, 0);
      }
    }
    return counts;
  }

  getZoomRange() {
    return { min: MIN_ZOOM, max: MAX_ZOOM };
  }

  zoomBy(multiplier, animate = false) {
    const rect = this.canvas.getBoundingClientRect();
    const focusX = rect.width * 0.5;
    const focusY = rect.height * 0.5;

    if (animate) {
      this.animateZoom(this.zoom * multiplier, focusX, focusY);
      return;
    }

    this.cancelAnimations();
    this.setZoom(this.zoom * multiplier, focusX, focusY);
  }

  setOverlay(message, options = {}) {
    this.buildOverlayContent();
    this.overlayMessageEl.textContent = message || "";
    this.overlayEl.hidden = !message;
    // A dismissible overlay (the session-expired notice) shows an x in the
    // card's top-right corner: closing it uncovers the cached map so the
    // person can keep browsing - and keep receiving alliance messages and
    // everything else that rides the site session - without signing back
    // in to the game. Zone loading stays halted either way.
    if (this.overlayCloseEl) {
      this.overlayCloseEl.hidden = !(message && options.dismissible);
    }
    // Each new overlay message starts without a progress bar; zone loading
    // reveals it via setOverlayProgress once totals are known.
    this.setOverlayProgress(null);
  }

  // Lazily builds the overlay card (message + progress bar) inside the
  // #map-overlay container the markup provides.
  buildOverlayContent() {
    if (this.overlayMessageEl) {
      return;
    }
    // The card ships in the markup so the initial "Loading..." shows before
    // any script runs; build it only if the markup is missing.
    let card = this.overlayEl.querySelector(".map-overlay-card");
    if (!card) {
      card = document.createElement("div");
      card.className = "map-overlay-card";
      card.innerHTML =
        '<div class="map-overlay-message"></div>' +
        '<div class="map-overlay-progress" hidden><div class="map-overlay-progress-fill"></div></div>';
      this.overlayEl.appendChild(card);
    }
    // The x lives on the card, hidden by default; only dismissible
    // messages reveal it.
    let close = card.querySelector(".map-overlay-close");
    if (!close) {
      close = document.createElement("button");
      close.type = "button";
      close.className = "popup-close map-overlay-close";
      close.setAttribute("aria-label", "Dismiss and browse the cached map");
      close.title = "Dismiss and browse the cached map";
      close.innerHTML = "&times;";
      close.hidden = true;
      close.addEventListener("click", () => this.setOverlay(""));
      card.appendChild(close);
    }
    this.overlayCloseEl = close;
    this.overlayMessageEl = card.querySelector(".map-overlay-message");
    this.overlayProgressEl = card.querySelector(".map-overlay-progress");
    this.overlayProgressFillEl = card.querySelector(".map-overlay-progress-fill");
  }

  // Pushes the current waited-zone-load stats into the overlay bar.
  updateOverlayProgress() {
    const stats = this.zoneWaitStats;
    if (!stats?.total) {
      return;
    }
    this.setOverlayProgress({
      completed: stats.successes + stats.failures,
      total: stats.total,
    });
  }

  // progress: { completed, total } or null to hide the bar. Only rendered
  // while the overlay itself is visible.
  setOverlayProgress(progress) {
    this.buildOverlayContent();
    const total = Number(progress?.total || 0);
    if (!total || this.overlayEl.hidden) {
      this.overlayProgressEl.hidden = true;
      this.overlayProgressFillEl.style.width = "0%";
      return;
    }
    const completed = Math.min(total, Math.max(0, Number(progress?.completed || 0)));
    const percent = Math.round((completed / total) * 100);
    this.overlayProgressEl.hidden = false;
    this.overlayProgressFillEl.style.width = `${percent}%`;
    this.overlayProgressEl.setAttribute("role", "progressbar");
    this.overlayProgressEl.setAttribute("aria-valuemin", "0");
    this.overlayProgressEl.setAttribute("aria-valuemax", String(total));
    this.overlayProgressEl.setAttribute("aria-valuenow", String(completed));
  }

  setStatus(message) {
    if (this.statusEl) {
      this.statusEl.textContent = message;
    }
  }

  setZoom(nextZoom, focusX, focusY) {
    const clampedZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const localFocusX = focusX ?? width * 0.5;
    const localFocusY = focusY ?? height * 0.5;
    const before = this.screenToWorld(localFocusX, localFocusY);

    this.zoom = clampedZoom;
    this.offsetX = before.x - localFocusX / this.zoom;
    // Must be the exact inverse of screenToWorld, which divides out the mcBG
    // vertical stretch. Without the same division here the focus point drifts
    // by the aspect ratio on every step, so repeated zooming walked the camera
    // steadily upward.
    this.offsetY = before.y - this.viewWorldHeight(localFocusY);
    this.clampOffset();
    this.render();
    this.scheduleFetch();
  }

  animateZoom(nextZoom, focusX, focusY) {
    const targetZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const startZoom = this.zoom;
    if (Math.abs(targetZoom - startZoom) < 0.001) {
      return;
    }

    this.cancelAnimations();
    const startTime = performance.now();
    const durationMs = 180;

    const step = (timestamp) => {
      const progress = clamp((timestamp - startTime) / durationMs, 0, 1);
      const eased = 1 - ((1 - progress) ** 3);
      const interpolatedZoom = startZoom + (targetZoom - startZoom) * eased;
      this.setZoom(interpolatedZoom, focusX, focusY);

      if (progress < 1) {
        this.zoomAnimationFrame = window.requestAnimationFrame(step);
      } else {
        this.zoomAnimationFrame = 0;
      }
    };

    this.zoomAnimationFrame = window.requestAnimationFrame(step);
  }

  cancelZoomAnimation() {
    if (!this.zoomAnimationFrame) {
      return;
    }

    window.cancelAnimationFrame(this.zoomAnimationFrame);
    this.zoomAnimationFrame = 0;
  }

  animatePanTo(cellX, cellY) {
    const canonicalOffset = this.getCenteredOffset(cellX, cellY);
    const startOffsetX = this.offsetX;
    const startOffsetY = this.offsetY;
    const targetOffset = {
      x: this.nearestWrappedValue(canonicalOffset.x, startOffsetX, this.getWorldPeriodX()),
      y: this.nearestWrappedValue(canonicalOffset.y, startOffsetY, this.getWorldPeriodY()),
    };

    if (
      Math.abs(targetOffset.x - startOffsetX) < 0.5 &&
      Math.abs(targetOffset.y - startOffsetY) < 0.5
    ) {
      this.offsetX = targetOffset.x;
      this.offsetY = targetOffset.y;
      this.render();
      this.scheduleFetch();
      return;
    }

    this.cancelPanAnimation();
    const startTime = performance.now();
    const durationMs = 280;

    const step = (timestamp) => {
      const progress = clamp((timestamp - startTime) / durationMs, 0, 1);
      const eased = 1 - ((1 - progress) ** 3);
      this.offsetX = startOffsetX + (targetOffset.x - startOffsetX) * eased;
      this.offsetY = startOffsetY + (targetOffset.y - startOffsetY) * eased;
      this.renderNow();

      if (progress < 1) {
        this.panAnimationFrame = window.requestAnimationFrame(step);
      } else {
        this.panAnimationFrame = 0;
        this.clampOffset();
        this.scheduleFetch();
      }
    };

    this.panAnimationFrame = window.requestAnimationFrame(step);
  }

  animateViewTo(cellX, cellY, nextZoom) {
    const targetZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const startOffsetX = this.offsetX;
    const startOffsetY = this.offsetY;
    const startZoom = this.zoom;
    const startCenterWorldX = startOffsetX + width / (2 * startZoom);
    const startCenterWorldY = startOffsetY + height / (2 * startZoom);
    const targetOffset = this.getCenteredOffset(cellX, cellY, targetZoom);
    const targetCenterWorldX = this.nearestWrappedValue(
      targetOffset.x + width / (2 * targetZoom),
      startCenterWorldX,
      this.getWorldPeriodX(),
    );
    const targetCenterWorldY = this.nearestWrappedValue(
      targetOffset.y + height / (2 * targetZoom),
      startCenterWorldY,
      this.getWorldPeriodY(),
    );

    if (
      Math.abs(targetZoom - startZoom) < 0.001 &&
      Math.abs(targetOffset.x - startOffsetX) < 0.5 &&
      Math.abs(targetOffset.y - startOffsetY) < 0.5
    ) {
      this.zoom = targetZoom;
      this.offsetX = targetOffset.x;
      this.offsetY = targetOffset.y;
      this.render();
      this.scheduleFetch();
      return;
    }

    this.cancelAnimations();
    const startTime = performance.now();
    const durationMs = 280;

    const step = (timestamp) => {
      const progress = clamp((timestamp - startTime) / durationMs, 0, 1);
      const eased = 1 - ((1 - progress) ** 3);
      const interpolatedZoom = startZoom + (targetZoom - startZoom) * eased;
      const centerWorldX = startCenterWorldX + (targetCenterWorldX - startCenterWorldX) * eased;
      const centerWorldY = startCenterWorldY + (targetCenterWorldY - startCenterWorldY) * eased;

      this.zoom = interpolatedZoom;
      this.offsetX = centerWorldX - width / (2 * this.zoom);
      this.offsetY = centerWorldY - this.viewWorldHeight(height) / 2;
      this.renderNow();

      if (progress < 1) {
        this.panAnimationFrame = window.requestAnimationFrame(step);
      } else {
        this.panAnimationFrame = 0;
        this.clampOffset();
        this.scheduleFetch();
      }
    };

    this.panAnimationFrame = window.requestAnimationFrame(step);
  }

  cancelPanAnimation() {
    if (!this.panAnimationFrame) {
      return;
    }

    window.cancelAnimationFrame(this.panAnimationFrame);
    this.panAnimationFrame = 0;
  }

  cancelAnimations() {
    this.cancelZoomAnimation();
    this.cancelPanAnimation();
  }

  getCenteredOffset(cellX, cellY, zoom = this.zoom) {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const world = this.cellToWorld(cellX, cellY);
    const offsetX = world.x - width / (2 * zoom) + MR2.cellWidth * 0.5;
    const offsetY = world.y - ((height / MCBG_ASPECT) / zoom) / 2 + MR2.cellHeight * 0.5;
    return this.getClampedOffset(offsetX, offsetY);
  }

  centerOnCell(cellX, cellY) {
    const centeredOffset = this.getCenteredOffset(cellX, cellY);
    this.offsetX = centeredOffset.x;
    this.offsetY = centeredOffset.y;
  }

  // Converts a /worldmapv2/getarea response ({ x: { y: cell } }) into
  // normalized cells keyed by coordinates.
  // Stamps ownership-change history onto a freshly merged cell:
  //   tt - takeover time, UTC ms (always set when a change is known; the
  //        cache minifiers drop zero values, so tt > 0 is the presence flag)
  //   po - previous owner uid (omitted when the previous owner was wild)
  //   pn - previous owner/tribe name
  //   pb - previous cell type (wild/main/outpost)
  // When no new change is seen, history carries forward from the prior
  // cached cell; history arriving from the shared cache (another viewer
  // observed the change first) is kept as-is. A record with no timestamp
  // (older cache format) defaults to the current UTC time.
  applyChangeTracking(previous, current) {
    const changed = Boolean(previous) &&
      Number(previous.uid || 0) !== Number(current.uid || 0);

    if (changed && !(Number(current.tt) > 0)) {
      const prevUid = Number(previous.uid || 0);
      if (prevUid > 0) {
        current.po = prevUid;
      } else {
        delete current.po;
      }
      const prevName = String(previous.n || "").trim();
      if (prevName) {
        current.pn = prevName;
      } else {
        delete current.pn;
      }
      const prevType = Number(previous.b || 0);
      if (prevType) {
        current.pb = prevType;
      }
      current.tt = Date.now();
    } else if (!changed && previous && !(Number(current.tt) > 0) && Number(previous.tt) > 0) {
      current.tt = Number(previous.tt);
      if (previous.po !== undefined) current.po = previous.po;
      if (previous.pn !== undefined) current.pn = previous.pn;
      if (previous.pb !== undefined) current.pb = previous.pb;
    }

    // "Default to the current UTC time if nonexistent": a record that has
    // owner history but no usable timestamp gets one now.
    if ((current.po !== undefined || current.pn !== undefined) && !(Number(current.tt) > 0)) {
      current.tt = Date.now();
    }
    return changed;
  }

  mergeZoneResponse(response) {
    const data = response?.data;
    if (!data || typeof data !== "object") {
      return;
    }

    const ownershipChanges = [];
    const ingestedCells = [];

    for (const [rawX, column] of Object.entries(data)) {
      if (!column || typeof column !== "object") {
        continue;
      }

      const x = Number(rawX);
      for (const [rawY, rawCell] of Object.entries(column)) {
        const y = Number(rawY);
        if (Number.isNaN(x) || Number.isNaN(y) || !rawCell || typeof rawCell !== "object") {
          continue;
        }

        const key = cellKey(x, y);
        const previous = this.cellCache.get(key) || null;
        const current = this.normalizeCell(x, y, rawCell);
        this.cellCache.set(key, current);
        this.cacheVersion += 1;
        this.worldBitmapDirty.push(current);
        this.noteFreshnessCell(current);
        ingestedCells.push(current);

        // Report ownership transitions (captures / losses) for cells we had
        // prior data on. A change means the owner uid differs, which covers
        // wild -> player, player -> wild, and player -> player takeovers.
        // applyChangeTracking also stamps the record onto the cell so the
        // shared cache carries it to every other viewer.
        if (this.applyChangeTracking(previous, current)) {
          ownershipChanges.push({ x, y, previous, current });
        }
      }
    }

    if (ownershipChanges.length && typeof this.onCellOwnershipChanges === "function") {
      try {
        this.onCellOwnershipChanges(ownershipChanges);
      } catch (error) {
        console.warn("Ownership-change handler failed.", error);
      }
    }
    // Live-zone hook: the app archives baseloads for main yards it has
    // not captured recently. Fired only for live getarea ingests (this
    // method), never for shared-cache hydration.
    if (ingestedCells.length && typeof this.onZoneLoaded === "function") {
      try {
        this.onZoneLoaded(ingestedCells);
      } catch (error) {
        console.warn("Zone-loaded handler failed.", error);
      }
    }
  }

  normalizeCell(x, y, rawCell) {
    const cell = {
      ...rawCell,
      x,
      y,
      uid: Number(rawCell.uid || 0),
      b: rawCell.b !== undefined ? Number(rawCell.b) : null,
      i: Number(rawCell.i || 0),
      l: Number(rawCell.l || 0),
      v: Number(rawCell.v || 0),
      f: Number(rawCell.f || 0),
      c: Number(rawCell.c || 0),
      dm: Number(rawCell.dm || 0),
      // The monster-housing blob is dropped below, but the worker-idle
      // icon needs to know whether a job is running: keep just its
      // finishtime (seconds since epoch; 0 = no job = worker idle).
      mft: Number(rawCell?.m?.finishtime || rawCell?.mft || 0),
      d: Number(rawCell.d || 0),
      lo: Number(rawCell.lo || 0),
      p: Number(rawCell.p || 0),
      t: Number(rawCell.t || 0),
      // "mine" from a live getarea response is per-session truth; the shared
      // cache deliberately never stores it (one user's flag must not paint
      // their bases blue for everyone), so cells restored from cache derive
      // it from the owner uid instead.
      mine:
        Number(rawCell.mine || 0) ||
        (Number(rawCell.uid || 0) > 0 && Number(rawCell.uid) === Number(this.currentUserId || 0) ? 1 : 0),
    };
    // The monster-housing blob is by far the largest field in a cell and the
    // viewer never reads it. Dropping it here keeps memory, the shared
    // cache, and its transfers lean; previously cached cells shed it as
    // they are refetched.
    delete cell.m;
    return cell;
  }

  // Loads the shared explored-map cache for this world from the viewer
  // server (server_{servername}/zones/). The cache is shared between all
  // users, so anything any signed-in player has explored is available here.
  hydrateZonePayload(zone) {
    const zoneX = Number(zone?.x);
    const zoneY = Number(zone?.y);
    if (!Number.isFinite(zoneX) || !Number.isFinite(zoneY)) {
      return false;
    }
    const key = zoneKey(zoneX, zoneY);
    const fetchedAt = Number(zone.fetchedAt || 0);
    if (this.loadedZones.has(key) && Number(this.loadedZones.get(key)) >= fetchedAt) {
      return false; // already hydrated (e.g. by the viewport-first phase)
    }
    this.loadedZones.set(key, fetchedAt);
    this.ownRangeDirty = true;
    if (Array.isArray(zone.cells)) {
      for (const cell of zone.cells) {
        if (cell && Number.isFinite(Number(cell.x)) && Number.isFinite(Number(cell.y))) {
          const normalized = this.normalizeCell(Number(cell.x), Number(cell.y), cell);
          this.cellCache.set(cellKey(cell.x, cell.y), normalized);
          this.cacheVersion += 1;
          this.worldBitmapDirty.push(normalized);
        }
      }
    }
    return true;
  }

  viewportZoneOrigins(marginZones = 2) {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const bounds = this.getVisibleCellBounds(width, height);
    const margin = marginZones * MR2.zoneSize;
    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();
    const seen = new Set();
    const origins = [];
    for (let x = zoneOriginForCell(bounds.minX - margin); x <= zoneOriginForCell(bounds.maxX + margin); x += MR2.zoneSize) {
      for (let y = zoneOriginForCell(bounds.minY - margin); y <= zoneOriginForCell(bounds.maxY + margin); y += MR2.zoneSize) {
        const wrappedX = positiveModulo(x, mapWidth);
        const wrappedY = positiveModulo(y, mapHeight);
        const key = zoneKey(wrappedX, wrappedY);
        if (!seen.has(key)) {
          seen.add(key);
          origins.push({ x: wrappedX, y: wrappedY });
        }
      }
    }
    return origins;
  }

  // Cache restore is split in two: the zones around the current view hydrate
  // synchronously (map interactive immediately), then the rest of the
  // explored world streams in during idle time. Heavy caches used to mean
  // seconds of main-thread parsing before anything appeared - exactly
  // backwards for the veterans with the fullest maps.
  async restoreExploredCache() {
    if (!this.serverName) {
      return false;
    }

    let restoredAny = false;
    let origins = this.viewportZoneOrigins(2);
    if (origins.length > 200) {
      // Zoomed far out, the viewport can cover most of the map; hydrate the
      // 200 zones nearest the view centre first (the server caps ?zones= at
      // 200) and let the background pass stream the rest.
      const width = this.canvas.clientWidth || 1;
      const height = this.canvas.clientHeight || 1;
      const centerX = this.offsetX + width / (2 * this.zoom);
      const centerY = this.offsetY + this.viewWorldHeight(height) / 2;
      const centerZoneX = zoneOriginForCell(Math.floor(centerX / MR2.columnStep));
      const centerZoneY = zoneOriginForCell(Math.floor(centerY / MR2.cellHeight));
      const mapWidth = this.getMapWidth();
      const mapHeight = this.getMapHeight();
      const wrapDist = (a, b, size) => {
        const d = Math.abs(a - b);
        return Math.min(d, size - d);
      };
      origins = origins
        .map((o) => ({
          ...o,
          d: Math.max(wrapDist(o.x, centerZoneX, mapWidth), wrapDist(o.y, centerZoneY, mapHeight)),
        }))
        .sort((left, right) => left.d - right.d)
        .slice(0, 200);
    }
    if (origins.length > 0) {
      try {
        const first = await storageGetServerMap(this.serverName, origins);
        for (const zone of (Array.isArray(first?.zones) ? first.zones : [])) {
          restoredAny = this.hydrateZonePayload(zone) || restoredAny;
        }
      } catch (error) {
        console.warn("[BYM-MR2] Shared map cache unavailable; starting with an empty map.", error);
        return false;
      }
    }

    // The bootstraps await this before dropping the loading overlay, so the
    // map never "unlocks" while cached cells are still streaming in.
    this.cacheHydrationDone = this.hydrateRemainderInBackground();
    return restoredAny;
  }

  // Streams the rest of the explored cache onto the map in idle-time slices.
  // Returns a promise that settles once every cached zone has been hydrated
  // (or the world was switched away mid-hydration). While the loading
  // overlay is up it doubles as the progress source; the overlay's own
  // hidden check makes the reporting a no-op after the overlay drops.
  hydrateRemainderInBackground() {
    const serverName = this.serverName;
    const generation = this.zoneFetchGeneration;
    const idle = (fn) => (window.requestIdleCallback
      ? window.requestIdleCallback(fn, { timeout: 500 })
      : window.setTimeout(fn, 16));

    return storageGetServerMap(serverName).then((payload) => new Promise((resolve) => {
      const zones = Array.isArray(payload?.zones) ? payload.zones : [];
      let index = 0;
      const slice = () => {
        if (this.zoneFetchGeneration !== generation || this.serverName !== serverName) {
          resolve(); // world switched away mid-hydration
          return;
        }
        const end = Math.min(index + 60, zones.length);
        let touched = false;
        for (; index < end; index += 1) {
          touched = this.hydrateZonePayload(zones[index]) || touched;
        }
        if (index < zones.length) {
          if (touched) {
            this.render();
          }
          this.setOverlayProgress({ completed: index, total: zones.length });
          idle(slice);
        } else {
          // Own bases outside the initial viewport are only known now.
          this.rebuildFreshnessZones();
          this.sortZoneQueue();
          this.render();
          // Let the app rebuild anything derived from the full cache
          // (search index, filter options, outpost counts).
          if (typeof this.onCacheHydrated === "function") {
            this.onCacheHydrated();
          }
          resolve();
        }
      };
      idle(slice);
    })).catch((error) => {
      console.warn("[BYM-MR2] Background cache hydration failed.", error);
    });
  }

  markZoneDirty(key) {
    this.dirtyZoneKeys.add(key);
  }

  schedulePersistExploredCache() {
    if (!this.serverName || this.persistTimer) {
      return;
    }

    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      this.persistExploredCache().catch((error) => {
        console.warn("Failed to persist the shared explored-map cache.", error);
      });
    }, 1500);
  }

  // Writes freshly fetched zones back to the shared cache. Only zones marked
  // dirty since the last flush are sent, so concurrent users only ever
  // overwrite the specific zones they just re-fetched.
  async persistExploredCache() {
    if (!this.serverName || !this.dirtyZoneKeys.size) {
      return;
    }

    const serverName = this.serverName;
    const zoneKeys = [...this.dirtyZoneKeys];
    this.dirtyZoneKeys.clear();

    const zones = [];
    for (const key of zoneKeys) {
      const [zoneX, zoneY] = key.split(",").map(Number);
      if (!Number.isFinite(zoneX) || !Number.isFinite(zoneY)) {
        continue;
      }

      const cells = [];
      for (let deltaX = 0; deltaX < MR2.zoneSize; deltaX += 1) {
        for (let deltaY = 0; deltaY < MR2.zoneSize; deltaY += 1) {
          const cell = this.cellCache.get(cellKey(zoneX + deltaX, zoneY + deltaY));
          if (cell) {
            cells.push(minifyCellForCache(cell));
          }
        }
      }

      zones.push({
        x: zoneX,
        y: zoneY,
        fetchedAt: Number(this.loadedZones.get(key) || Date.now()),
        cells,
      });
    }

    if (!zones.length) {
      return;
    }

    try {
      const payload = await storagePostServerZones(serverName, zones);
      // Saving now authenticates, which rotates the game token; hand the
      // echoed current token to the app so the session keeps working.
      if (payload?.token) {
        this.onTokenRefresh?.(payload.token);
      }
    } catch (error) {
      // Re-mark so the next flush retries these zones (unless a new session
      // started against a different server in the meantime).
      if (this.serverName === serverName) {
        for (const key of zoneKeys) {
          this.dirtyZoneKeys.add(key);
        }
      }
      throw error;
    }
  }

  getMapWidth() {
    return Number(this.mapMeta?.width || MR2.mapWidth);
  }

  getMapHeight() {
    return Number(this.mapMeta?.height || MR2.mapHeight);
  }

  scheduleFetch() {
    if (!this.token) {
      return;
    }

    if (this.fetchTimer) {
      window.clearTimeout(this.fetchTimer);
    }

    this.fetchTimer = window.setTimeout(() => {
      this.fetchTimer = null;
      this.ensureCellsForViewport(false).catch((error) => {
        console.warn("Failed to load map zones for the viewport.", error);
      });
    }, FETCH_DEBOUNCE_MS);


  }



  // Queues /worldmapv2/getarea requests for every zone that intersects the
  // current viewport. Zones are 10x10 chunks aligned to multiples of 10,
  // matching what the game client requests.
  async ensureCellsForViewport(force, { waitForCompletion = false, onlyOwn = false } = {}) {
    if (!this.token) {
      return;
    }

    const zones = this.buildZoneRequestList(force, { onlyOwn });
    for (const zone of zones) {
      if (this.queuedZoneKeys.has(zone.key)) {
        // Already queued: keep the better of the two scores (a zone whose
        // tier improved - an ally moved in, say - must not stay demoted).
        this.raiseQueuedZonePriority(zone.key, zone.priority);
      } else if (!this.pendingZones.has(zone.key)) {
        this.zoneQueue.push(zone);
        this.queuedZoneKeys.add(zone.key);
      }
    }
    this.sortZoneQueue();

    if (!this.zoneQueue.length && !this.pendingZones.size) {
      return;
    }

    let completion = null;
    if (waitForCompletion) {
      // A previous caller may still be waiting (e.g. overlapping refreshes);
      // settle it so its promise can't hang forever.
      this.settleZoneWait();
      this.zoneWaitStats = {
        successes: 0,
        failures: 0,
        firstError: null,
        // Everything queued or in flight right now belongs to this wait;
        // drives the overlay progress bar during bootstrap/refresh loads.
        total: this.zoneQueue.length + this.pendingZones.size,
      };
      this.updateOverlayProgress();
      completion = new Promise((resolve, reject) => {
        this.onZonesSettled = { resolve, reject };
      });
    }

    this.pumpZoneQueue();

    if (completion) {
      await completion;
    }
  }

  buildZoneRequestList(force, { onlyOwn = false } = {}) {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const bounds = this.getVisibleCellBounds(width, height);
    const now = Date.now();
    void force; // freshness is now governed solely by the tier rules below
    const zones = [];
    const seen = new Set();

    const minZoneX = zoneOriginForCell(bounds.minX);
    const maxZoneX = zoneOriginForCell(bounds.maxX);
    const minZoneY = zoneOriginForCell(bounds.minY);
    const maxZoneY = zoneOriginForCell(bounds.maxY);

    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();
    for (let zoneX = minZoneX; zoneX <= maxZoneX; zoneX += MR2.zoneSize) {
      for (let zoneY = minZoneY; zoneY <= maxZoneY; zoneY += MR2.zoneSize) {
        // The zone size divides the map size, so wrapped origins stay aligned
        // to the same 10x10 grid the game requests.
        const wrappedZoneX = positiveModulo(zoneX, mapWidth);
        const wrappedZoneY = positiveModulo(zoneY, mapHeight);
        const key = zoneKey(wrappedZoneX, wrappedZoneY);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        const fetchedAt = this.loadedZones.get(key);
        if (
          fetchedAt !== undefined &&
          now - fetchedAt < this.zoneMaxAgeFor(wrappedZoneX, wrappedZoneY)
        ) {
          // Fresh enough for its tier (5 min for own/ally zones, up to 24h
          // for distant wilderness): keep the cached copy. This applies to
          // every caller including sign-in and any manual refresh -
          // "refresh allowed every X" is a hard rule, not a default.
          continue;
        }

        if (onlyOwn && !this.ownZones.has(key)) {
          continue;
        }

        zones.push({
          key,
          x: wrappedZoneX,
          y: wrappedZoneY,
          priority: this.zonePriorityFor(wrappedZoneX, wrappedZoneY),
          // (queued duplicates are promoted in enqueueZones, never demoted)
          enqueuedAt: now,
          // Distance uses the unwrapped viewport-local position so ordering
          // still radiates outward from the viewport center.
          distance:
            Math.abs(zoneX + MR2.zoneSize / 2 - (bounds.minX + bounds.maxX) / 2) +
            Math.abs(zoneY + MR2.zoneSize / 2 - (bounds.minY + bounds.maxY) / 2),
        });
      }
    }

    // Own bases first, then allies, then everything else nearest-first;
    // viewport-centre distance only breaks ties within a band.
    zones.sort((left, right) =>
      (right.priority - left.priority) || (left.distance - right.distance));
    return zones;
  }

  getVisibleCellBounds(width, height) {
    // Cells are 150px wide but columns sit 112.5px apart, so a cell can
    // overhang up to two columns into the viewport from the left.
    const marginX = 2;
    const marginY = 1;
    const minWorldX = this.offsetX;
    const maxWorldX = this.offsetX + width / this.zoom;
    const minWorldY = this.offsetY;
    const maxWorldY = this.offsetY + this.viewWorldHeight(height);

    // Unclamped: indices past the map edges refer to wrap copies of cells on
    // the far side (consumers wrap them with positiveModulo). Cap the span at
    // one full map so an extreme zoom-out can never draw duplicate copies.
    const minX = Math.floor(minWorldX / MR2.columnStep) - marginX;
    const maxX = Math.min(
      Math.ceil(maxWorldX / MR2.columnStep) + marginX,
      minX + this.getMapWidth() - 1,
    );
    const minY = Math.floor((minWorldY - MR2.oddColumnOffset) / MR2.cellHeight) - marginY;
    const maxY = Math.min(
      Math.ceil(maxWorldY / MR2.cellHeight) + marginY,
      minY + this.getMapHeight() - 1,
    );

    return { minX, maxX, minY, maxY };
  }

  // Resolves (or rejects) an outstanding ensureCellsForViewport wait.
  // Rejects only when every requested zone failed (e.g. an auth error);
  // partial failures resolve so one flaky zone can't sink a whole login.
  settleZoneWait(forcedError = null) {
    // Release per-zone waiters first: the queue is being torn down, so their
    // zones will never complete on their own.
    if (this.zoneKeyWaiters.size) {
      for (const key of [...this.zoneKeyWaiters.keys()]) {
        this.notifyZoneKeyDone(key);
      }
    }
    if (!this.onZonesSettled) {
      return;
    }

    const settled = this.onZonesSettled;
    this.onZonesSettled = null;
    const { successes, failures, firstError } = this.zoneWaitStats;

    if (forcedError) {
      settled.reject(forcedError);
      return;
    }

    if (failures > 0 && successes === 0 && firstError) {
      settled.reject(firstError);
      return;
    }

    settled.resolve();
  }

  sortZoneQueue() {
    this.zoneQueue.sort((left, right) =>
      ((right.priority || 0) - (left.priority || 0)) ||
      ((left.distance || 0) - (right.distance || 0)));
  }

  /**
   * Resolves once THIS zone has been fetched (or has failed / been dropped).
   * Independent of the queue-wide settle used by viewport loads: a caller
   * that only needs one zone must not wait for hundreds of unrelated ones.
   */
  awaitZoneKey(key) {
    if (!this.queuedZoneKeys.has(key) && !this.pendingZones.has(key)) {
      return Promise.resolve(); // nothing outstanding for this zone
    }
    return new Promise((resolve) => {
      let waiters = this.zoneKeyWaiters.get(key);
      if (!waiters) {
        waiters = new Set();
        this.zoneKeyWaiters.set(key, waiters);
      }
      waiters.add(resolve);
    });
  }

  /** Wakes anyone awaiting this specific zone. */
  notifyZoneKeyDone(key) {
    const waiters = this.zoneKeyWaiters.get(key);
    if (!waiters) {
      return;
    }
    this.zoneKeyWaiters.delete(key);
    for (const resolve of waiters) {
      resolve();
    }
  }

  /** Raises a queued zone's priority (never lowers it) and re-sorts. */
  raiseQueuedZonePriority(key, priority) {
    const wanted = Number(priority) || 1;
    const entry = this.zoneQueue.find((zone) => zone.key === key);
    if (!entry || entry.priority >= wanted) {
      return false;
    }
    entry.priority = wanted;
    // A promoted zone should not be dropped by the give-up timer either.
    entry.enqueuedAt = Date.now();
    this.sortZoneQueue();
    return true;
  }

  pumpZoneQueue() {
    const generation = this.zoneFetchGeneration;

    while (
      this.zoneQueue.length > 0 &&
      (this.zoneWorkersActive < MR2.zoneFetchConcurrency
        // Top tiers (an explicit reload, or your own main yard) do not queue
        // behind the in-flight panning fetches: they get an extra slot so
        // they go out immediately rather than waiting for one to drain.
        || (Number(this.zoneQueue[0]?.priority) >= ZONE_PACER_BYPASS_PRIORITY
          && this.zoneWorkersActive < MR2.zoneFetchConcurrency + 2))
    ) {
      const zone = this.zoneQueue.shift();
      this.queuedZoneKeys.delete(zone.key);
      if (zone.enqueuedAt && Date.now() - zone.enqueuedAt > MR2.fetchGiveUpMs) {
        // Waited over the give-up window (shared budget was busy with more
        // important zones); the next viewport pass re-queues it if it still
        // matters.
        if (this.zoneWaitStats.total > 0) {
          this.zoneWaitStats.total -= 1;
          this.updateOverlayProgress();
        }
        this.notifyZoneKeyDone(zone.key);
        continue;
      }
      this.pendingZones.add(zone.key);
      this.zoneWorkersActive += 1;

      this.api.getArea(this.token, zone.x, zone.y, this.zoneScope(), zone.priority || 1)
        .then((response) => {
          if (this.zoneFetchGeneration !== generation || !this.token) {
            return;
          }

          this.mergeZoneResponse(response);
          this.loadedZones.set(zone.key, Date.now());
          this.markZoneDirty(zone.key);
          this.zoneWaitStats.successes += 1;
          this.updateOverlayProgress();
          this.render();
          this.schedulePersistExploredCache();
        })
        .catch((error) => {
          // A 429 is the shared budget saying "not now", not a failure of the
          // zone itself: reschedule it for when the server said budget frees
          // (Retry-After), instead of dropping it until the next viewport
          // pass. Anyone awaiting this specific zone is still released in
          // .finally below - the retry refills the map in the background.
          if (Number(error?.status) === 429
            && this.zoneFetchGeneration === generation
            && (zone.retries || 0) < 2) {
            const delayMs = Math.min(120_000,
              Math.max(5_000, (Number(error?.retryAfter) || 15) * 1000));
            this.requeueZoneLater(zone, delayMs, generation);
          }
          console.warn(`Failed to load zone ${zone.key}.`, error);
          this.zoneWaitStats.failures += 1;
          this.updateOverlayProgress();
          if (!this.zoneWaitStats.firstError) {
            this.zoneWaitStats.firstError = error instanceof Error ? error : new Error(String(error));
          }
        })
        .finally(() => {
          this.pendingZones.delete(zone.key);
          this.zoneWorkersActive -= 1;
          this.notifyZoneKeyDone(zone.key);

          if (this.zoneFetchGeneration === generation) {
            this.pumpZoneQueue();
          }

          if (!this.zoneQueue.length && !this.pendingZones.size) {
            this.settleZoneWait();
          }
        });
    }

    if (!this.zoneQueue.length && !this.pendingZones.size) {
      this.settleZoneWait();
    }
  }

  // Re-queues a budget-rejected zone once its Retry-After has elapsed,
  // keeping its priority. Silently drops if the map was torn down (generation
  // changed), the user signed out, or the zone is already queued/in flight.
  requeueZoneLater(zone, delayMs, generation) {
    globalThis.setTimeout(() => {
      if (this.zoneFetchGeneration !== generation || !this.token) {
        return;
      }
      if (this.queuedZoneKeys.has(zone.key) || this.pendingZones.has(zone.key)) {
        return;
      }
      this.zoneQueue.push({
        ...zone,
        retries: (zone.retries || 0) + 1,
        enqueuedAt: Date.now(),
      });
      this.queuedZoneKeys.add(zone.key);
      this.sortZoneQueue();
      this.pumpZoneQueue();
    }, delayMs);
  }

  getCenterCell() {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const worldX = this.offsetX + width / (2 * this.zoom);
    const worldY = this.offsetY + this.viewWorldHeight(height) / 2;
    return this.findGridCellAtWorldPoint(worldX, worldY);
  }

  handlePointerDown(event) {
    if (!this.interactive) {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    this.lastPointer = { x: localX, y: localY };
    this.measurePointerInside = true;
    this.setCoordinatesDisplay(this.findGridCellAtPoint(localX, localY));

    if (event.cancelable) {
      event.preventDefault();
    }

    this.cancelAnimations();
    this.activePointers.set(event.pointerId, {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    });
    this.canvas.setPointerCapture(event.pointerId);

    if (this.activePointers.size >= 2) {
      this.startPinchGesture(rect);
      return;
    }

    this.dragging = true;
    this.dragMoved = false;
    this.dragPointerId = event.pointerId;
    this.dragLastPoint = { x: event.clientX, y: event.clientY };
  }

  handlePointerMove(event) {
    const rect = this.canvas.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;

    if (this.activePointers.has(event.pointerId)) {
      this.activePointers.set(event.pointerId, {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      });
    }

    this.lastPointer = { x: localX, y: localY };
    this.measurePointerInside = true;
    this.setCoordinatesDisplay(this.findGridCellAtPoint(localX, localY));

    if (this.pinchState && this.activePointers.size >= 2) {
      if (event.cancelable) {
        event.preventDefault();
      }

      this.applyPinchGesture(rect);
      return;
    }

    if (this.dragging && this.dragLastPoint && event.pointerId === this.dragPointerId) {
      if (event.cancelable) {
        event.preventDefault();
      }

      const deltaX = event.clientX - this.dragLastPoint.x;
      const deltaY = event.clientY - this.dragLastPoint.y;
      if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
        this.dragMoved = true;
      }
      this.offsetX -= deltaX / this.zoom;
      this.offsetY -= deltaY / this.zoom;
      this.dragLastPoint = { x: event.clientX, y: event.clientY };
      this.clampOffset();
      this.render();
      this.scheduleFetch();
      return;
    }

    const hovered = this.findCellAtPoint(localX, localY);
    const hoveredKey = hovered ? cellKey(hovered.x, hovered.y) : null;
    if (hoveredKey !== this.hoveredCellKey) {
      this.hoveredCellKey = hoveredKey;
      this.onHoverCell(hovered);
      this.render();
    } else if (this.measureMode) {
      // The rubber band and cursor ruler track the pointer continuously, not
      // just on cell boundaries. Same per-move repaint cost as drag-panning.
      this.render();
    }
  }

  handlePointerUp(event) {
    // Touch has no hover: once the finger lifts there is no pointer on the
    // canvas, so the measure ruler and rubber band must stop drawing at the
    // lift position instead of freezing there.
    if (event.pointerType === "touch") {
      this.measurePointerInside = false;
    }
    const wasPinching = Boolean(this.pinchState);
    const wasDraggingPointer = this.dragging && event.pointerId === this.dragPointerId;

    this.releasePointerCapture(event.pointerId);
    this.activePointers.delete(event.pointerId);

    if (wasPinching) {
      this.pinchState = null;

      if (this.activePointers.size >= 2) {
        this.startPinchGesture();
      } else if (this.activePointers.size === 1) {
        this.resumeDragFromActivePointer();
      } else {
        this.dragging = false;
        this.dragMoved = false;
        this.dragPointerId = null;
        this.dragLastPoint = null;
      }
      return;
    }

    if (!wasDraggingPointer) {
      return;
    }

    this.dragging = false;
    this.dragPointerId = null;
    this.dragLastPoint = null;

    if (!this.dragMoved) {
      if (this.measureMode) {
        this.handleMeasureClick(this.findGridCellAtPoint(this.lastPointer.x, this.lastPointer.y));
        return;
      }

      this.jumpMarker = null;
      const hovered = this.findCellAtPoint(this.lastPointer.x, this.lastPointer.y);
      const hoveredKey = hovered ? cellKey(hovered.x, hovered.y) : null;
      if (hoveredKey !== this.hoveredCellKey) {
        this.hoveredCellKey = hoveredKey;
        this.onHoverCell(hovered);
      }
      this.selectedCellKey = hoveredKey;
      this.onSelectCell(this.getSelectedCell());
      this.render();
    }
  }

  handlePointerCancel(event) {
    if (event?.pointerType === "touch") {
      // Same as handlePointerUp: a cancelled touch leaves no pointer on the
      // canvas, so measure-mode pointer visuals must stop drawing.
      this.measurePointerInside = false;
    }
    if (event?.pointerId != null) {
      this.releasePointerCapture(event.pointerId);
      this.activePointers.delete(event.pointerId);
    }

    if (this.activePointers.size >= 2) {
      this.startPinchGesture();
      return;
    }

    this.pinchState = null;

    if (this.activePointers.size === 1) {
      this.resumeDragFromActivePointer();
      return;
    }

    this.dragging = false;
    this.dragMoved = false;
    this.dragPointerId = null;
    this.dragLastPoint = null;
  }

  handlePointerLeave() {
    this.setCoordinatesDisplay(null);
    // The cursor ruler and any rubber band stop drawing once the pointer is
    // off the canvas.
    this.measurePointerInside = false;
    if (this.dragging) {
      return;
    }

    this.hoveredCellKey = null;
    this.onHoverCell(null);
    this.render();
  }

  handleWheel(event) {
    if (!this.interactive) {
      return;
    }

    event.preventDefault();
    this.cancelAnimations();
    const rect = this.canvas.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const multiplier =
      event.deltaY < 0 ? WHEEL_ZOOM_MULTIPLIER : 1 / WHEEL_ZOOM_MULTIPLIER;
    this.setZoom(this.zoom * multiplier, localX, localY);
  }

  startPinchGesture(rect = this.canvas.getBoundingClientRect()) {
    const pointers = this.getActivePinchPointers();
    if (pointers.length < 2) {
      this.pinchState = null;
      return;
    }

    const center = this.getPointerCenter(pointers[0], pointers[1], rect);
    this.pinchState = {
      distance: Math.max(1, this.getPointerDistance(pointers[0], pointers[1])),
      zoom: this.zoom,
      world: this.screenToWorld(center.x, center.y),
    };
    this.dragging = false;
    this.dragMoved = true;
    this.dragPointerId = null;
    this.dragLastPoint = null;
    this.lastPointer = center;
    this.setCoordinatesDisplay(this.findGridCellAtPoint(center.x, center.y));
  }

  applyPinchGesture(rect = this.canvas.getBoundingClientRect()) {
    if (!this.pinchState) {
      return;
    }

    const pointers = this.getActivePinchPointers();
    if (pointers.length < 2) {
      this.pinchState = null;
      return;
    }

    const center = this.getPointerCenter(pointers[0], pointers[1], rect);
    const nextZoom = clamp(
      this.pinchState.zoom * (this.getPointerDistance(pointers[0], pointers[1]) / this.pinchState.distance),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    this.zoom = nextZoom;
    this.offsetX = this.pinchState.world.x - center.x / this.zoom;
    // Inverse of screenToWorld - see setZoom. Pinch drifts the same way.
    this.offsetY = this.pinchState.world.y - this.viewWorldHeight(center.y);
    this.lastPointer = center;
    this.setCoordinatesDisplay(this.findGridCellAtPoint(center.x, center.y));
    this.clampOffset();
    this.render();
    this.scheduleFetch();
  }

  getActivePinchPointers() {
    return [...this.activePointers.values()].slice(0, 2);
  }

  getPointerCenter(firstPointer, secondPointer, rect) {
    return {
      x: (firstPointer.clientX + secondPointer.clientX) * 0.5 - rect.left,
      y: (firstPointer.clientY + secondPointer.clientY) * 0.5 - rect.top,
    };
  }

  getPointerDistance(firstPointer, secondPointer) {
    return Math.hypot(
      secondPointer.clientX - firstPointer.clientX,
      secondPointer.clientY - firstPointer.clientY,
    );
  }

  resumeDragFromActivePointer() {
    const [pointer] = this.activePointers.values();
    if (!pointer) {
      this.dragging = false;
      this.dragMoved = false;
      this.dragPointerId = null;
      this.dragLastPoint = null;
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    this.dragging = true;
    this.dragMoved = true;
    this.dragPointerId = pointer.pointerId;
    this.dragLastPoint = { x: pointer.clientX, y: pointer.clientY };
    this.lastPointer = {
      x: pointer.clientX - rect.left,
      y: pointer.clientY - rect.top,
    };
    this.setCoordinatesDisplay(this.findGridCellAtPoint(this.lastPointer.x, this.lastPointer.y));
  }

  releasePointerCapture(pointerId) {
    if (!this.canvas.hasPointerCapture?.(pointerId)) {
      return;
    }

    try {
      this.canvas.releasePointerCapture(pointerId);
    } catch {
      // Ignore stale pointer capture releases after the browser has already cleaned them up.
    }
  }

  focusHome() {
    const home = this.getHomeCoordinates();
    if (!home) {
      return;
    }

    this.animateViewTo(home.x, home.y, DEFAULT_MAP_ZOOM);
  }

  getHomeCoordinates() {
    if (!this.homeCellKey) {
      return null;
    }

    const [x, y] = this.homeCellKey.split(",").map(Number);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  getHomeCell() {
    return this.homeCellKey ? this.cellCache.get(this.homeCellKey) || null : null;
  }

  // ------------------------------------------------------------------
  // Full-world scan: walks every 10x10 zone with a progress callback.
  // Zones fetched less than an hour ago are skipped (resume-friendly),
  // pacing is enforced by the ApiClient request gate.
  // ------------------------------------------------------------------
  isScanRunning() {
    return Boolean(this.scanState?.active);
  }

  async startWorldScan({ onProgress = null } = {}) {
    if (!this.token || this.isScanRunning()) {
      return null;
    }

    const now = Date.now();
    const zones = [];
    for (let zoneX = 0; zoneX < this.getMapWidth(); zoneX += MR2.zoneSize) {
      for (let zoneY = 0; zoneY < this.getMapHeight(); zoneY += MR2.zoneSize) {
        zones.push({ key: zoneKey(zoneX, zoneY), x: zoneX, y: zoneY });
      }
    }
    // Oldest data first: never-fetched zones lead, then ascending fetch
    // time, so a scan cancelled partway has always bought the maximum
    // possible freshness instead of whatever coordinate order reached.
    zones.sort((a, b) =>
      (this.loadedZones.get(a.key) ?? -Infinity) - (this.loadedZones.get(b.key) ?? -Infinity));

    const state = {
      active: true,
      cancelRequested: false,
      total: zones.length,
      completed: 0,
      fetched: 0,
      skipped: 0,
      failed: 0,
      startedAt: now,
      generation: this.zoneFetchGeneration,
    };
    this.scanState = state;

    const report = () => {
      if (typeof onProgress === "function") {
        onProgress({
          total: state.total,
          completed: state.completed,
          fetched: state.fetched,
          skipped: state.skipped,
          failed: state.failed,
          startedAt: state.startedAt,
          cancelled: state.cancelRequested,
        });
      }
    };

    let nextIndex = 0;
    let sincePersist = 0;
    let sinceRender = 0;

    const worker = async () => {
      while (!state.cancelRequested && state.generation === this.zoneFetchGeneration) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= zones.length) {
          return;
        }

        const zone = zones[index];
        const fetchedAt = this.loadedZones.get(zone.key);
        if (fetchedAt !== undefined && now - fetchedAt < this.zoneMaxAgeFor(zone.x, zone.y)) {
          state.skipped += 1;
          state.completed += 1;
          if (state.completed % 50 === 0) {
            report();
          }
          continue;
        }

        try {
          // Priority 10 by operator choice: Scan World is admin-initiated
          // maintenance and runs at the top of the budget (and past the
          // client zone pacer). Historical note: this once sent 50 under a
          // "never crowd out live traffic" comment, which the server
          // clamped to 10 anyway - now the value says what it does.
          const response = await this.api.getArea(this.token, zone.x, zone.y, this.zoneScope(), 10);
          if (state.generation !== this.zoneFetchGeneration) {
            return;
          }
          this.mergeZoneResponse(response);
          this.loadedZones.set(zone.key, Date.now());
          this.markZoneDirty(zone.key);
          state.fetched += 1;
        } catch (error) {
          state.failed += 1;
          console.warn(`World scan failed for zone ${zone.key}.`, error);
        }

        state.completed += 1;
        sincePersist += 1;
        sinceRender += 1;

        if (sinceRender >= MR2.scanRenderEveryZones) {
          sinceRender = 0;
          this.render();
        }

        if (sincePersist >= MR2.scanPersistEveryZones) {
          sincePersist = 0;
          this.persistExploredCache().catch(() => {});
        }

        report();
      }
    };

    report();
    const workers = Array.from({ length: MR2.scanConcurrency }, () => worker());
    await Promise.all(workers);

    state.active = false;
    this.render();
    this.persistExploredCache().catch(() => {});
    report();
    return {
      total: state.total,
      fetched: state.fetched,
      skipped: state.skipped,
      failed: state.failed,
      cancelled: state.cancelRequested,
    };
  }

  /**
   * Stops all outstanding zone loading, keeping the cells already drawn.
   *
   * Used when the session dies: the queued zones can only produce 401s, and
   * each one would otherwise drive another token-recovery attempt. The map
   * stays visible and pannable from cache; only fetching stops.
   */
  haltZoneLoading() {
    this.zoneQueue = [];
    this.queuedZoneKeys = new Set();
    this.cancelWorldScan();
    // Releases anyone blocked in awaitZoneKey rather than leaving them hanging.
    this.settleZoneWait();
    this.updateOverlayProgress();
  }

  cancelWorldScan() {
    if (this.scanState) {
      this.scanState.cancelRequested = true;
    }
  }

  /**
   * Reloads ONE zone immediately with a dedicated, high-priority request,
   * bypassing the shared panning queue entirely.
   *
   * The base viewer needs the freshest cell (its base id) for the zone it is
   * about to open. Routing that through the normal zone queue is fragile: if
   * the same zone is already in flight at panning priority (1), the queue
   * cannot upgrade an already-dispatched request, so the popup ends up
   * WAITING on that stale low-priority fetch - which itself may be stuck
   * behind the whole panning backlog in the server's budget. That is the
   * multi-second stall on "Reloading zone...". Issuing our own request here
   * sidesteps all of it: it goes straight out at priority 10 (which also
   * skips the client pacer), and whatever the background queue is doing to
   * the same zone is harmless - last write into the cell cache wins.
   */
  async reloadZoneNow(zone, priority = FETCH_PRIORITY.zoneReload) {
    if (!this.token || !zone) {
      return false;
    }
    const key = zoneKey(zone.x, zone.y);

    // Coalesce: two opens of bases in the same zone (the picker does exactly
    // this) must share one fetch, not race two identical ones. A real capture
    // showed three calls for one zone inside 46ms.
    const existing = this.zoneReloadsInFlight.get(key);
    if (existing) {
      return existing;
    }

    // Throttle: this call deliberately bypasses the queue and the freshness
    // tiers so the base viewer gets a fresh `bid`, but "not queued" does not
    // have to mean "unthrottled". Without a floor, every base opened - or
    // reopened - refetched the whole zone: 18 fetches of one zone in four
    // minutes, 37% of all getarea traffic in that session redundant. A base
    // id cannot go stale inside 15s, which is the same floor refetchZones
    // uses for its own forced path.
    const fetchedAt = this.loadedZones.get(key);
    if (fetchedAt !== undefined && Date.now() - fetchedAt < ZONE_RELOAD_MIN_AGE_MS) {
      return false;
    }

    const work = (async () => {
      const response = await this.api.getArea(
        this.token, zone.x, zone.y, this.zoneScope(), priority,
      );
      // A world switch / sign-out mid-flight invalidates this response.
      if (!this.token) {
        return false;
      }
      this.mergeZoneResponse(response);
      this.loadedZones.set(key, Date.now());
      this.markZoneDirty(key);
      this.render();
      this.schedulePersistExploredCache();
      return true;
    })();

    this.zoneReloadsInFlight.set(key, work);
    try {
      return await work;
    } finally {
      this.zoneReloadsInFlight.delete(key);
    }
  }

  // Force-refetches specific zones (used by the watchlist auto-refresh).
  // Refreshes zones from the viewer's SHARED CACHE instead of the game API:
  // no game traffic, so the player never appears online. Applies only zones
  // newer than what is already in memory (other members' live fetches feed
  // the cache), diffs cells exactly like a live merge, and emits ownership
  // changes so watch events, notifications, and the alliance feed all fire.
  async refreshZonesFromSharedCache(zoneOrigins) {
    if (!this.serverName || !Array.isArray(zoneOrigins) || !zoneOrigins.length) {
      return 0;
    }
    let payload;
    try {
      payload = await storageGetServerMap(this.serverName, zoneOrigins);
    } catch (error) {
      debugLog("Cached zone refresh failed.", error);
      return 0;
    }

    const ownershipChanges = [];
    let applied = 0;
    for (const zone of payload?.zones || []) {
      const key = zoneKey(Number(zone.x), Number(zone.y));
      const fetchedAt = Number(zone.fetchedAt || 0);
      if (!fetchedAt || fetchedAt <= Number(this.loadedZones.get(key) || 0)) {
        continue; // cache is not newer than what we already show
      }
      for (const rawCell of zone.cells || []) {
        const x = Number(rawCell?.x);
        const y = Number(rawCell?.y);
        if (Number.isNaN(x) || Number.isNaN(y)) {
          continue;
        }
        const cKey = cellKey(x, y);
        const previous = this.cellCache.get(cKey) || null;
        const current = this.normalizeCell(x, y, rawCell);
        if (this.applyChangeTracking(previous, current)) {
          ownershipChanges.push({ x, y, previous, current });
        }
        this.cellCache.set(cKey, current);
        this.cacheVersion += 1;
        this.worldBitmapDirty.push(current);
      }
      this.loadedZones.set(key, fetchedAt);
      applied += 1;
    }

    if (ownershipChanges.length && typeof this.onCellOwnershipChanges === "function") {
      try {
        this.onCellOwnershipChanges(ownershipChanges);
      } catch (error) {
        console.warn("Ownership-change handler failed.", error);
      }
    }
    if (applied) {
      this.render();
    }
    debugLog(`Cached watch check: ${applied} zone(s) newer in the shared cache.`);
    return applied;
  }

  async refetchZones(zoneOrigins, { force = false, priority = null } = {}) {
    if (!this.token || !Array.isArray(zoneOrigins) || !zoneOrigins.length) {
      return;
    }

    const now = Date.now();
    const requested = [];
    for (const origin of zoneOrigins) {
      const key = zoneKey(origin.x, origin.y);
      const fetchedAt = this.loadedZones.get(key);
      // force (the View Yard/Outpost flow) reloads regardless of the
      // freshness tier, but never more than once per 15s per zone so
      // repeated clicks cannot spam the game API.
      const minAge = force ? 15 * 1000 : this.zoneMaxAgeFor(origin.x, origin.y);
      if (fetchedAt !== undefined && now - fetchedAt < minAge) {
        continue; // still fresh enough
      }
      const wanted = priority ?? this.zonePriorityFor(origin.x, origin.y);
      if (this.queuedZoneKeys.has(key)) {
        // Already waiting: promote it instead of dropping this request on
        // the floor. Priority is only ever raised, never lowered.
        this.raiseQueuedZonePriority(key, wanted);
      } else if (!this.pendingZones.has(key)) {
        this.zoneQueue.push({
          key,
          x: origin.x,
          y: origin.y,
          distance: 0,
          priority: wanted,
          enqueuedAt: now,
        });
        this.queuedZoneKeys.add(key);
      }
      requested.push(key);
    }
    this.sortZoneQueue();

    // Wait for JUST these zones. Waiting on the queue-wide settle (as this
    // used to) meant a caller such as the base viewer sat through every
    // other queued zone finishing - the requested zone was fetched first,
    // but the popup kept saying "Reloading zone..." until the backlog from
    // panning had drained.
    const waits = requested.map((key) => this.awaitZoneKey(key));
    this.pumpZoneQueue();
    await Promise.all(waits);
  }

  // ------------------------------------------------------------------
  // Measure tool: click to place a first point, click again to finish the
  // measurement; any number of measurements can coexist. Clicking a cell
  // that already holds an endpoint picks that point up and it follows the
  // mouse until dropped on another cell. Distances use the same wrap-aware
  // odd-q metric as the game. Everything clears when the mode toggles.
  // ------------------------------------------------------------------
  setMeasureMode(enabled) {
    this.measureMode = Boolean(enabled);
    // Both directions start clean: toggling the button off wipes every
    // measurement, and toggling it on never resurrects an old set.
    this.measurements = [];
    this.measureDraft = null;
    this.measureCarry = null;
    // The dedicated cursor signals the mode even before the first click;
    // the little ruler drawn beside it comes from drawMeasureOverlay.
    this.canvas.style.cursor = this.measureMode ? "crosshair" : "";
    this.notifyMeasureUpdated();
    this.render();
  }

  // Topmost endpoint occupying this cell: the draft first, then newer
  // measurements over older ones.
  findMeasurePointAt(gridCell) {
    if (this.measureDraft &&
        this.measureDraft.x === gridCell.x && this.measureDraft.y === gridCell.y) {
      return { draft: true };
    }
    for (let index = this.measurements.length - 1; index >= 0; index -= 1) {
      for (const end of ["b", "a"]) {
        const point = this.measurements[index][end];
        if (point.x === gridCell.x && point.y === gridCell.y) {
          return { index, end };
        }
      }
    }
    return null;
  }

  handleMeasureClick(gridCell) {
    if (!gridCell) {
      return;
    }

    if (this.measureCarry) {
      // Drop the carried point on this cell.
      const measurement = this.measurements[this.measureCarry.index];
      if (measurement) {
        measurement[this.measureCarry.end] = { x: gridCell.x, y: gridCell.y };
      }
      this.measureCarry = null;
    } else if (this.measureDraft) {
      if (this.measureDraft.x === gridCell.x && this.measureDraft.y === gridCell.y) {
        // Clicking the pending point lifts it again - the hand is empty and
        // the next click places it fresh.
        this.measureDraft = null;
      } else {
        // Second click completes the measurement - even on a cell that
        // already holds another measurement's endpoint, since measuring
        // to a shared landmark is legitimate.
        this.measurements.push({
          a: this.measureDraft,
          b: { x: gridCell.x, y: gridCell.y },
        });
        this.measureDraft = null;
      }
    } else {
      const picked = this.findMeasurePointAt(gridCell);
      if (picked && !picked.draft) {
        // Pick the point up; it follows the mouse until the next click.
        this.measureCarry = { index: picked.index, end: picked.end };
      } else {
        this.measureDraft = { x: gridCell.x, y: gridCell.y };
      }
    }

    this.notifyMeasureUpdated();
    this.render();
  }

  notifyMeasureUpdated() {
    if (typeof this.onMeasureUpdated !== "function") {
      return;
    }

    let mode = "idle";
    if (this.measureCarry) {
      mode = "carry";
    } else if (this.measureDraft) {
      mode = "draft";
    }
    this.onMeasureUpdated({
      mode,
      count: this.measurements.length,
      draft: this.measureDraft ? { ...this.measureDraft } : null,
    });
  }

  drawMeasureOverlay() {
    if (!this.measureMode) {
      return;
    }

    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const periodX = this.getWorldPeriodX();
    const periodY = this.getWorldPeriodY();

    // Projects a grid cell to screen px, wrap-resolved against an anchor so
    // a line never draws the long way around the torus. The anchor defaults
    // to the view centre; passing the line's other endpoint keeps both ends
    // on the same wrap copy.
    const projectCell = (point, anchor = null) => {
      const anchorX = anchor ? anchor.worldX : this.offsetX + width / (2 * this.zoom);
      const anchorY = anchor ? anchor.worldY : this.offsetY + this.viewWorldHeight(height) / 2;
      const world = this.cellToWorld(point.x, point.y);
      const worldX = this.nearestWrappedValue(world.x + MR2.cellWidth / 2, anchorX, periodX);
      const worldY = this.nearestWrappedValue(world.y + MR2.cellHeight / 2, anchorY, periodY);
      return {
        worldX,
        worldY,
        x: (worldX - this.offsetX) * this.zoom,
        y: (worldY - this.offsetY) * this.zoom,
      };
    };

    const ctx = this.ctx;
    const dotRadius = Math.max(4, 6 * this.zoom);
    const font = `bold ${Math.max(12, 13 * this.zoom)}px Verdana, Geneva, 'DejaVu Sans', Tahoma, sans-serif`;

    const drawDot = (point, { ghost = false } = {}) => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = ghost ? "rgba(255, 170, 60, 0.45)" : "rgba(255, 170, 60, 0.95)";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
      ctx.setLineDash([]);
      ctx.stroke();
    };

    const drawLine = (from, to, { live = false } = {}) => {
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.lineWidth = Math.max(2, 2.6 * this.zoom);
      ctx.strokeStyle = live ? "rgba(255, 200, 110, 0.9)" : "rgba(255, 170, 60, 0.95)";
      ctx.setLineDash([8 * this.zoom, 5 * this.zoom]);
      ctx.stroke();
      ctx.setLineDash([]);
    };

    const drawLabel = (text, x, y) => {
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
      ctx.strokeText(text, x, y);
      ctx.fillStyle = "#ffd9a0";
      ctx.fillText(text, x, y);
    };

    ctx.save();

    const pointerRaw = this.measurePointerInside ? this.lastPointer : null;
    // The overlay draws inside the mcBG transform (Y scaled by MCBG_ASPECT),
    // so the CSS-pixel pointer must be unstretched before it can share a
    // line with projected cells.
    const pointer = pointerRaw
      ? { x: pointerRaw.x, y: pointerRaw.y / MCBG_ASPECT }
      : null;
    const pointerCell = pointerRaw
      ? this.findGridCellAtPoint(pointerRaw.x, pointerRaw.y)
      : null;

    // Completed measurements. A measurement whose endpoint is currently in
    // hand draws as a rubber band from its fixed end to the mouse instead.
    this.measurements.forEach((measurement, index) => {
      const carried = this.measureCarry && this.measureCarry.index === index
        ? this.measureCarry.end
        : null;

      if (!carried) {
        const pointA = projectCell(measurement.a);
        const pointB = projectCell(measurement.b, pointA);
        drawLine(pointA, pointB);
        drawDot(pointA);
        drawDot(pointB);
        drawLabel(
          `${this.getWrappedHexDistance(measurement.a.x, measurement.a.y, measurement.b.x, measurement.b.y)} cells`,
          (pointA.x + pointB.x) / 2,
          (pointA.y + pointB.y) / 2 - 10,
        );
        return;
      }

      const fixed = measurement[carried === "a" ? "b" : "a"];
      const fixedPoint = projectCell(fixed);
      drawDot(fixedPoint);
      if (pointer) {
        drawLine(fixedPoint, pointer, { live: true });
        drawDot(pointer, { ghost: true });
        if (pointerCell) {
          drawLabel(
            `${this.getWrappedHexDistance(fixed.x, fixed.y, pointerCell.x, pointerCell.y)} cells`,
            (fixedPoint.x + pointer.x) / 2,
            (fixedPoint.y + pointer.y) / 2 - 10,
          );
        }
      }
    });

    // In-progress measurement: first point placed, second end following the
    // mouse with a live cell count.
    if (this.measureDraft) {
      const draftPoint = projectCell(this.measureDraft);
      drawDot(draftPoint);
      if (pointer) {
        drawLine(draftPoint, pointer, { live: true });
        if (pointerCell) {
          drawLabel(
            `${this.getWrappedHexDistance(this.measureDraft.x, this.measureDraft.y, pointerCell.x, pointerCell.y)} cells`,
            (draftPoint.x + pointer.x) / 2,
            (draftPoint.y + pointer.y) / 2 - 10,
          );
        }
      }
    }

    // Small ruler beside the pointer whenever measure mode is armed, so the
    // mode is visible even before the first click. Raw CSS px on purpose:
    // the glyph resets to a uniform transform so it is never aspect-warped.
    if (pointerRaw) {
      this.drawMeasureCursorRuler(pointerRaw.x + 16, pointerRaw.y + 12);
    }

    ctx.restore();
  }

  // A tilted ruler glyph (rounded body + tick marks) drawn in screen space
  // next to the mouse. Fixed size on purpose: it is cursor adornment, not
  // map content, so it must not scale with zoom.
  drawMeasureCursorRuler(x, y) {
    const ctx = this.ctx;
    ctx.save();
    // Cursor adornment lives in plain CSS-pixel space: the surrounding
    // overlay transform carries the mcBG vertical stretch, which would both
    // misplace the glyph and shear its rotation.
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    ctx.translate(x, y);
    ctx.rotate(-Math.PI / 5);
    const bodyWidth = 26;
    const bodyHeight = 11;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(0, 0, bodyWidth, bodyHeight, 2.5);
    } else {
      ctx.rect(0, 0, bodyWidth, bodyHeight);
    }
    ctx.fillStyle = "rgba(255, 208, 130, 0.95)";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(60, 38, 8, 0.9)";
    ctx.stroke();
    ctx.beginPath();
    for (let tick = 1; tick <= 4; tick += 1) {
      const tickX = (bodyWidth / 5) * tick;
      ctx.moveTo(tickX, 0);
      ctx.lineTo(tickX, tick % 2 ? bodyHeight * 0.45 : bodyHeight * 0.62);
    }
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }

  // Jumps the camera to arbitrary coordinates, even if the cell has not
  // been loaded yet; the zone fetch will fill it in. A marker ring is drawn
  // on the target until the user clicks elsewhere.
  jumpToCoordinates(cellX, cellY, { animate = true } = {}) {
    // Coordinates wrap around the map edges (e.g. 805 -> 5, -1 -> 799).
    const x = positiveModulo(Math.round(Number(cellX) || 0), this.getMapWidth());
    const y = positiveModulo(Math.round(Number(cellY) || 0), this.getMapHeight());

    this.jumpMarker = { x, y };

    const cached = this.cellCache.get(cellKey(x, y));
    if (cached && this.shouldDisplayBaseCell(cached)) {
      this.selectedCellKey = cellKey(x, y);
      this.onSelectCell(this.getSelectedCell());
    }

    if (animate) {
      this.animateViewTo(x, y, Math.max(this.zoom, DEFAULT_MAP_ZOOM));
    } else {
      this.centerOnCell(x, y);
      this.render();
      this.scheduleFetch();
    }

    return { x, y };
  }

  clearJumpMarker() {
    if (this.jumpMarker) {
      this.jumpMarker = null;
      this.render();
    }
  }

  focusCell(cell, { animate = true, resetZoom = false } = {}) {
    if (!cell) {
      return;
    }

    this.cancelAnimations();
    this.selectedCellKey = cellKey(cell.x, cell.y);
    this.onSelectCell(this.getSelectedCell());

    if (animate) {
      if (resetZoom) {
        this.animateViewTo(cell.x, cell.y, DEFAULT_MAP_ZOOM);
        return;
      }

      this.animatePanTo(cell.x, cell.y);
      return;
    }

    if (resetZoom) {
      this.zoom = DEFAULT_MAP_ZOOM;
    }
    this.centerOnCell(cell.x, cell.y);
    this.render();
    this.scheduleFetch();
  }

  clearSelection() {
    const hadSelection = Boolean(this.selectedCellKey);
    const hadHover = Boolean(this.hoveredCellKey);
    this.selectedCellKey = null;
    this.hoveredCellKey = null;
    this.onHoverCell(null);
    this.onSelectCell(null);

    if (hadSelection || hadHover) {
      this.render();
    }
  }

  getSearchablePlayerBases() {
    const home = this.getHomeCoordinates();
    const bases = [];

    for (const cell of this.cellCache.values()) {
      if (Number(cell.b) !== MR2.yardTypes.main || !this.doesContainDisplayableBase(cell)) {
        continue;
      }
      if (this.isCellHidden(cell)) {
        continue;
      }

      const name = String(cell.n || "").trim();
      if (!name) {
        continue;
      }

      bases.push({
        cell,
        ownerId: Number(cell.uid || 0),
        username: name,
        normalizedUsername: name.toLocaleLowerCase(),
        level: Number(cell.l || 0),
        distance: home ? this.getWrappedHexDistance(home.x, home.y, cell.x, cell.y) : null,
      });
    }

    return bases;
  }

  // The MR2 world wraps toroidally, so the shortest path may cross a map
  // edge. The map dimensions are even, which keeps column parity (and with
  // it the odd-q distance math) intact when shifting by a full map width.
  getWrappedHexDistance(x1, y1, x2, y2) {
    const width = this.getMapWidth();
    const height = this.getMapHeight();
    let best = Infinity;

    for (const shiftX of [-width, 0, width]) {
      for (const shiftY of [-height, 0, height]) {
        best = Math.min(best, getHexDistance(x1, y1, x2 + shiftX, y2 + shiftY));
      }
    }

    return best;
  }

  // Aggregates everything known about a player from the explored cache.
  /**
   * The cached cell at (x, y), regardless of who owns it.
   *
   * getPlayerProfile() is scoped to one player AND returns null outright when
   * any of that player's cells is hidden, so it is the wrong lookup for
   * "what is the terrain here" - it answers "nothing" for cases where the
   * cache plainly holds the cell.
   */
  getCachedCell(x, y) {
    return this.cellCache.get(cellKey(Number(x), Number(y))) || null;
  }

  getPlayerProfile(ownerId) {
    const uid = Number(ownerId || 0);
    if (uid <= 0) {
      return null;
    }

    const home = this.getHomeCoordinates();
    const cells = [];
    let name = "";
    let empireValue = 0;

    for (const cell of this.cellCache.values()) {
      if (Number(cell.uid || 0) !== uid) {
        continue;
      }
      if (this.isCellHidden(cell)) {
        return null;
      }

      if (String(cell.n || "").trim()) {
        name = String(cell.n).trim();
      }
      empireValue = Math.max(empireValue, Number(cell.v || 0));

      cells.push(cell);
    }

    if (!cells.length) {
      return null;
    }

    cells.sort((left, right) => {
      // Main yard first, then outposts by distance from it.
      const leftMain = Number(left.b) === MR2.yardTypes.main ? 0 : 1;
      const rightMain = Number(right.b) === MR2.yardTypes.main ? 0 : 1;
      if (leftMain !== rightMain) {
        return leftMain - rightMain;
      }
      return (left.x - right.x) || (left.y - right.y);
    });

    const main = cells.find((cell) => Number(cell.b) === MR2.yardTypes.main) || null;
    return {
      ownerId: uid,
      name: name || `Player ${uid}`,
      empireValue,
      main,
      outposts: cells.filter((cell) => Number(cell.b) === MR2.yardTypes.outpost),
      cells,
      distanceFromHome: home && main ? this.getWrappedHexDistance(home.x, home.y, main.x, main.y) : null,
    };
  }

  getOwnedBaseCounts(ownerId) {
    const normalizedOwnerId = Number(ownerId || 0);
    const counts = {
      outpost: 0,
    };

    if (normalizedOwnerId <= 0) {
      return counts;
    }

    for (const cell of this.cellCache.values()) {
      if (Number(cell.uid || 0) !== normalizedOwnerId || !this.doesContainDisplayableBase(cell)) {
        continue;
      }

      if (Number(cell.b) === MR2.yardTypes.outpost) {
        counts.outpost += 1;
      }
    }

    return counts;
  }

  /**
   * Viewport height in world units. Vertical extent is not simply px/zoom any
   * more: the mcBG matrix stretches the map ~6% vertically at draw time, so a
   * given number of screen pixels covers proportionally fewer world rows.
   */
  viewWorldHeight(pixels) {
    return (pixels / MCBG_ASPECT) / this.zoom;
  }

  screenToWorld(screenX, screenY) {
    return {
      x: this.offsetX + screenX / this.zoom,
      // Undo the mcBG vertical stretch applied at draw time, so a pointer
      // position maps back to the cell that is actually under it.
      y: this.offsetY + (screenY / MCBG_ASPECT) / this.zoom,
    };
  }

  // MR2 grid: columns are columnStep apart and odd columns are shifted down
  // half a cell ("odd-q" layout, mirroring the original client).
  cellToWorld(cellX, cellY) {
    return {
      x: cellX * MR2.columnStep,
      y: cellY * MR2.cellHeight + (cellX % 2 ? MR2.oddColumnOffset : 0),
    };
  }

  // The MR2 world is a torus; the camera wraps instead of clamping. The map
  // dimensions are even, so shifting by one full map width/height preserves
  // odd-q column parity and the hex pattern tiles seamlessly across the seam.
  getWorldPeriodX() {
    return this.getMapWidth() * MR2.columnStep;
  }

  getWorldPeriodY() {
    return this.getMapHeight() * MR2.cellHeight;
  }

  // Returns the equivalent of `value` (mod period) closest to `reference` --
  // used to pick which wrap copy of a target to animate toward or draw.
  nearestWrappedValue(value, reference, period) {
    return value + period * Math.round((reference - value) / period);
  }

  clampOffset() {
    this.offsetX = positiveModulo(this.offsetX, this.getWorldPeriodX());
    this.offsetY = positiveModulo(this.offsetY, this.getWorldPeriodY());
  }

  getClampedOffset(offsetX, offsetY) {
    return {
      x: positiveModulo(offsetX, this.getWorldPeriodX()),
      y: positiveModulo(offsetY, this.getWorldPeriodY()),
    };
  }

  // All render() calls coalesce into at most one real draw per animation
  // frame; the deferred draw always reads current state, so batching never
  // shows stale frames. High-poll-rate mice used to trigger several full
  // redraws per displayed frame during drags.
  // Full-fidelity offscreen render for exports: the real draw pipeline
  // (both LODs, tiles, markers, labels, highlights, disguises) pointed at
  // a target canvas with an explicit camera, then everything restored.
  renderToCanvas(target, { offsetX, offsetY, zoom, forceDetailed = false }) {
    // Re-entrancy guard: this method swaps live renderer state (ctx,
    // canvas, camera, dpr) and restores it in finally. A nested or
    // concurrent call would restore the FIRST call's saved state on top of
    // the second's, leaving the live view pointed at a dead canvas.
    if (this.exportRenderInFlight) {
      throw new Error("An export render is already running - wait for it to finish.");
    }
    this.exportRenderInFlight = true;
    const saved = {
      ctx: this.ctx,
      canvas: this.canvas,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
      zoom: this.zoom,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
    };
    const width = target.width;
    const height = target.height;
    // Not in the DOM, so give it a rect; force dpr 1 so pixels match 1:1.
    target.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
    let dprRestore = null;
    try {
      const dprDesc = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
      Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
      dprRestore = () => {
        if (dprDesc) Object.defineProperty(window, "devicePixelRatio", dprDesc);
        else delete window.devicePixelRatio;
      };
    } catch { dprRestore = null; }
    try {
      this.canvas = target;
      this.forceDetailedExport = forceDetailed;
      this.ctx = target.getContext("2d", { alpha: false });
      this.offsetX = offsetX;
      this.offsetY = offsetY;
      this.zoom = zoom;
      // Pre-set the viewport so the resize compensation doesn't shift the
      // camera we just placed.
      this.viewportWidth = width;
      this.viewportHeight = height;
      this.renderNow();
    } finally {
      if (dprRestore) dprRestore();
      this.exportRenderInFlight = false;
      this.forceDetailedExport = false;
      this.ctx = saved.ctx;
      this.canvas = saved.canvas;
      this.offsetX = saved.offsetX;
      this.offsetY = saved.offsetY;
      this.zoom = saved.zoom;
      this.viewportWidth = saved.viewportWidth;
      this.viewportHeight = saved.viewportHeight;
      this.render();
    }
  }

  isDetailedZoom() {
    return this.zoom >= LOD_SIMPLE_ZOOM;
  }

  detailedMinZoom() {
    return LOD_SIMPLE_ZOOM;
  }

  render() {
    if (this.renderQueued) {
      return;
    }
    this.renderQueued = true;
    const raf = window.requestAnimationFrame
      ? window.requestAnimationFrame.bind(window)
      : (fn) => window.setTimeout(fn, 16);
    raf(() => {
      this.renderQueued = false;
      this.renderNow();
    });
  }

  renderNow() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;
    const previousWidth = this.viewportWidth;
    const previousHeight = this.viewportHeight;

    if (
      this.token &&
      previousWidth > 0 &&
      previousHeight > 0 &&
      (previousWidth !== width || previousHeight !== height)
    ) {
      const centerWorldX = this.offsetX + previousWidth / (2 * this.zoom);
      const centerWorldY = this.offsetY + this.viewWorldHeight(previousHeight) / 2;
      this.offsetX = centerWorldX - width / (2 * this.zoom);
      this.offsetY = centerWorldY - this.viewWorldHeight(height) / 2;
      this.clampOffset();
    }

    this.viewportWidth = width;
    this.viewportHeight = height;

    if (this.canvas.width !== Math.floor(width * dpr) || this.canvas.height !== Math.floor(height * dpr)) {
      this.canvas.width = Math.floor(width * dpr);
      this.canvas.height = Math.floor(height * dpr);
    }

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, width, height);

    if (!this.interactive) {
      this.ctx.fillStyle = "#101414";
      this.ctx.fillRect(0, 0, width, height);
      return;
    }

    this.drawBackground(width, height);

    // Everything from here is _cellContainer, which lives inside mcBG and so
    // inherits its matrix. Applied once, around the whole composition, exactly
    // as the client does - not folded into per-cell maths. Only the ratio is
    // visible (a uniform component is indistinguishable from zoom), so the X
    // scale stays 1 and Y carries MCBG_ASPECT.
    this.ctx.save();
    this.ctx.setTransform(dpr, 0, 0, dpr * MCBG_ASPECT, 0, 0);

    // Simplified view: the terrain comes from a prerendered world bitmap and
    // only base cells are enumerated, so the per-frame grid scan - by far the
    // largest cost at this zoom - does not happen at all.
    const visibleCells = this.zoom < LOD_SIMPLE_ZOOM
      ? []
      : this.getVisibleCells(width, height);

    this.pendingMainLabels.length = 0;
    if (this.guestMode) {
      this.drawUncachedZones(width, height);
    }
    if (this.zoom < LOD_SIMPLE_ZOOM && !this.forceDetailedExport) {
      this.drawWorldBitmap(width, height);
      // Flinger reach reads on the far-zoom bitmap only: one combined
      // path, one fill, so adjacent cells can't stack their alpha.
      this.drawOwnFlingerRange(width, height);
    } else {
      this.drawTerrainBatched(visibleCells);
      this.drawGlowPass(visibleCells);
    }

    // MapRoomPopup's own depth sort: cell.depth = cell.y * 1000 + cell.x, on
    // the FLAT staggered position. Sorting by cellY alone ignores the 37.5px
    // odd-column stagger, so an odd column drew behind the even column beside
    // it even though it sits lower on screen.
    //
    // Skipped entirely in the simplified view: it is flat and its markers do
    // not overlap, so paint order carries no information there - and that is
    // exactly the zoom with the most cells to sort.
    if (this.zoom >= LOD_SIMPLE_ZOOM) {
      // Key precomputed once per cell rather than derived inside the
      // comparator, which was allocating two objects per comparison.
      for (const entry of visibleCells) {
        entry.depth = entry.cellY * MR2.cellHeight
          + (entry.cellX % 2 ? MR2.oddColumnOffset : 0) + entry.cellX / 100000;
      }
      visibleCells.sort((left, right) => left.depth - right.depth);
    }
    for (const entry of (this.zoom < LOD_SIMPLE_ZOOM
      ? this.visibleBaseCells(width, height)
      : visibleCells)) {
      this.drawCellContents(entry);
    }

    this.drawJumpMarker();
    this.drawMeasureOverlay();
    this.drawPendingMainLabels();
    this.ctx.restore();
  }

  // Ally mains get a label shadow in the ally color, enemy mains in enemy
  // red; everyone else keeps the default black shadow.
  getMainLabelStrokeColor(cell) {
    // Your own main reads in your map blue at every LOD.
    if (Number(cell.mine || 0) === 1) {
      return "rgba(90, 169, 255, 0.95)";
    }
    const role = this.getPlayerHighlightColor(cell);
    if (role === "ally") {
      return ALLY_STROKE;
    }
    if (role === "enemy") {
      return ENEMY_STROKE;
    }
    return "rgba(0, 0, 0, 0.7)";
  }

  // MR2's flinger reach, straight from ApplyRangeHighlighting: the map is
  // an odd-q offset HEX grid, and a base covers every cell within hex
  // distance getFlingerRange(f, isMain) = isMain ? 2 + 2f : f. Cells in
  // range of any of your bases get a light wash.
  computeOwnFlingerRange() {
    this.ownRangeDirty = false;
    const cells = new Set();
    const toCube = (x, y) => {
      const q = x;
      const r = y - (x - (x & 1)) / 2;
      return { q, r };
    };
    for (const cell of this.cellCache.values()) {
      if (Number(cell.mine || 0) !== 1) continue;
      const bt = Number(cell.b);
      const isMain = bt === MR2.yardTypes.main;
      if (!isMain && bt !== MR2.yardTypes.outpost) continue;
      const f = Number(cell.f) || 0;
      const range = isMain ? 2 + 2 * f : f;
      if (range <= 0) continue;
      const c0 = toCube(Number(cell.x), Number(cell.y));
      for (let dq = -range; dq <= range; dq++) {
        const lo = Math.max(-range, -dq - range);
        const hi = Math.min(range, -dq + range);
        for (let dr = lo; dr <= hi; dr++) {
          const q = c0.q + dq;
          const r = c0.r + dr;
          const x = q;
          const y = r + (q - (q & 1)) / 2;
          cells.add(`${x},${y}`);
        }
      }
    }
    this.ownRangeCells = cells;
  }

  drawOwnFlingerRange(width, height) {
    if (this.zoom >= LOD_SIMPLE_ZOOM) return;
    if (this.ownRangeDirty || !this.ownRangeCells) this.computeOwnFlingerRange();
    if (!this.ownRangeCells.size) return;
    const cw = MR2.cellWidth * this.zoom;
    const chh = MR2.cellHeight * this.zoom;
    this.ctx.save();
    this.ctx.beginPath();
    for (const key of this.ownRangeCells) {
      const [cx, cy] = key.split(",").map(Number);
      const world = this.cellToWorld(cx, cy);
      const worldX = this.nearestWrappedValue(
        world.x, this.offsetX + width / (2 * this.zoom), this.getWorldPeriodX());
      const worldY = this.nearestWrappedValue(
        world.y, this.offsetY + this.viewWorldHeight(height) / 2, this.getWorldPeriodY());
      const sx = (worldX - this.offsetX) * this.zoom;
      const sy = (worldY - this.offsetY) * this.zoom;
      if (sx + cw < 0 || sy + chh < 0 || sx > width || sy > height) continue;
      this.ctx.rect(sx, sy, cw, chh);
    }
    // Single nonzero fill: overlapping rects lighten exactly once.
    this.ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
    this.ctx.fill();
    this.ctx.restore();
  }

  drawPendingMainLabels() {
    for (const entry of this.pendingMainLabels) {
      this.drawLabel(entry.cell, entry.screenX, entry.screenY, entry.stroke);
    }
  }

  drawJumpMarker() {
    if (!this.jumpMarker) {
      return;
    }

    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const world = this.cellToWorld(this.jumpMarker.x, this.jumpMarker.y);
    const worldX = this.nearestWrappedValue(
      world.x,
      this.offsetX + width / (2 * this.zoom),
      this.getWorldPeriodX(),
    );
    const worldY = this.nearestWrappedValue(
      world.y,
      this.offsetY + this.viewWorldHeight(height) / 2,
      this.getWorldPeriodY(),
    );
    const screenX = (worldX - this.offsetX) * this.zoom;
    const screenY = (worldY - this.offsetY) * this.zoom;

    this.ctx.save();
    this.ctx.strokeStyle = "rgba(120, 220, 255, 0.95)";
    this.ctx.fillStyle = "rgba(120, 220, 255, 0.12)";
    this.ctx.lineWidth = Math.max(2.2, 3.2 * this.zoom);
    this.ctx.lineJoin = "round";
    this.ctx.setLineDash([10 * this.zoom, 6 * this.zoom]);
    this.ctx.shadowColor = "rgba(120, 220, 255, 0.5)";
    this.ctx.shadowBlur = 10 * this.zoom;
    this.traceHexPath(screenX, screenY, CELL_HEX_VERTICES);
    this.ctx.fill();
    this.ctx.stroke();
    this.ctx.restore();
  }

  drawBackground(width, height) {
    const background = this.assets.get(ASSET_PATHS.background);
    if (!background) {
      this.ctx.fillStyle = "#15272e";
      this.ctx.fillRect(0, 0, width, height);
      return;
    }

    const scaledWidth = Math.max(1, Math.round(background.width * this.zoom));
    const scaledHeight = Math.max(1, Math.round(background.height * this.zoom));
    const startX = positiveModulo(-(this.offsetX * this.zoom), scaledWidth) - scaledWidth;
    const startY = positiveModulo(-(this.offsetY * this.zoom), scaledHeight) - scaledHeight;

    this.ctx.save();
    for (let drawY = startY; drawY < height + scaledHeight; drawY += scaledHeight) {
      for (let drawX = startX; drawX < width + scaledWidth; drawX += scaledWidth) {
        this.ctx.drawImage(background, drawX, drawY, scaledWidth, scaledHeight);
      }
    }
    this.ctx.restore();

    this.ctx.fillStyle = "rgba(8, 14, 16, 0.32)";
    this.ctx.fillRect(0, 0, width, height);
  }

  // Iterates only the coordinate range that intersects the viewport instead
  // of the whole cell cache. Unloaded cells simply have no entry yet. Each
  // entry pairs the cached cell (wrapped map coords) with the unwrapped grid
  // position it should be drawn at, so cells render on both sides of the
  // wrap seam.
  /**
   * The whole world's simplified terrain, prerendered once per cache change.
   *
   * Resolution is one pixel per COLUMN and two per ROW - 800 x 1600 for a
   * standard world, ~5 MB. That is not a compromise, it is exact: the
   * simplified view paints one flat band colour per cell, so a pixel per cell
   * is lossless, and two rows per cell is the minimum that can express the
   * 37.5px odd-column stagger (exactly half a row) without rounding. A larger
   * buffer - 3200 x 3200, say - would store each cell as a 4x4 block of
   * identical pixels: 16x the memory for no additional information.
   *
   * Drawn with smoothing off, so cells land as crisp blocks. Blockiness is
   * correct here rather than an artifact: a simplified cell IS a flat
   * rectangle of one colour, which is what the per-cell fillRect drew.
   */
  buildWorldBitmap() {
    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();
    const w = mapWidth;
    const h = mapHeight * 2;
    if (!this.worldBitmap || this.worldBitmap.width !== w || this.worldBitmap.height !== h) {
      this.worldBitmap = document.createElement("canvas");
      this.worldBitmap.width = w;
      this.worldBitmap.height = h;
    }
    const ctx = this.worldBitmap.getContext("2d", { willReadFrequently: false });
    const image = ctx.createImageData(w, h);
    const data = image.data;

    // Band colours resolved once, not per cell.
    const rgb = TERRAIN_BANDS.map((band) => {
      const hex = band.fill.replace("#", "");
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    });
    const bandFor = (height) => {
      for (let i = 0; i < TERRAIN_BANDS.length; i += 1) {
        if (height < TERRAIN_BANDS[i].max) return i;
      }
      return TERRAIN_BANDS.length - 1;
    };

    for (const cell of this.cellCache.values()) {
      const x = Number(cell.x);
      const y = Number(cell.y);
      if (x < 0 || x >= mapWidth || y < 0 || y >= mapHeight) {
        continue;
      }
      const [r, g, b] = rgb[bandFor(this.terrainHeightFor(cell))];
      // Two source rows per cell; odd columns start half a cell lower.
      const top = y * 2 + (x % 2 ? 1 : 0);
      for (let row = 0; row < 2; row += 1) {
        const py = (top + row) % h;
        const offset = (py * w + x) * 4;
        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
        data[offset + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    this.worldBitmapVersion = this.cacheVersion;
    return this.worldBitmap;
  }

  worldBitmapFor() {
    if (this.worldBitmap && this.worldBitmapVersion === this.cacheVersion) {
      return this.worldBitmap;
    }
    if (this.worldBitmap && this.worldBitmapDirty.length
        && this.worldBitmapDirty.length <= WORLD_BITMAP_PATCH_LIMIT) {
      this.patchWorldBitmap(this.worldBitmapDirty);
      this.worldBitmapDirty = [];
      this.worldBitmapVersion = this.cacheVersion;
      return this.worldBitmap;
    }
    this.buildWorldBitmap();
    this.worldBitmapDirty = [];
    return this.worldBitmap;
  }

  /** Repaints just the cells that changed since the last build. */
  patchWorldBitmap(cells) {
    const ctx = this.worldBitmap.getContext("2d");
    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();
    for (const cell of cells) {
      const x = Number(cell.x);
      const y = Number(cell.y);
      if (x < 0 || x >= mapWidth || y < 0 || y >= mapHeight) {
        continue;
      }
      ctx.fillStyle = getTerrainBand(this.terrainHeightFor(cell)).fill;
      ctx.fillRect(x, y * 2 + (x % 2 ? 1 : 0), 1, 2);
    }
  }

  /**
   * Blits the world bitmap over the viewport, repeating across the torus
   * seam the same way the background does.
   */
  drawWorldBitmap(width, height) {
    const bitmap = this.worldBitmapFor();
    if (!bitmap) {
      return;
    }
    const periodX = this.getWorldPeriodX();
    const periodY = this.getWorldPeriodY();
    const worldW = periodX * this.zoom;
    const worldH = periodY * this.zoom;
    if (worldW <= 0 || worldH <= 0) {
      return;
    }
    const startX = -this.offsetX * this.zoom;
    const startY = -this.offsetY * this.zoom;
    const viewH = this.viewWorldHeight(height) * this.zoom;

    const smoothing = this.ctx.imageSmoothingEnabled;
    this.ctx.imageSmoothingEnabled = false;
    let originX = startX - Math.ceil(startX / worldW) * worldW;
    for (let x = originX; x < width; x += worldW) {
      let originY = startY - Math.ceil(startY / worldH) * worldH;
      for (let y = originY; y < viewH; y += worldH) {
        this.ctx.drawImage(bitmap, x, y, worldW, worldH);
      }
    }
    this.ctx.imageSmoothingEnabled = smoothing;
  }

  /**
   * Base cells only, for the simplified view's markers. Wild tribes are not
   * drawn at that zoom, so this is a few thousand entries at most instead of
   * the ~110,000 the grid scan produced.
   */
  visibleBaseCells(width, height) {
    if (this.baseCellVersion !== this.cacheVersion) {
      this.baseCellIndex = [];
      for (const cell of this.cellCache.values()) {
        const type = Number(cell.b);
        if (type === MR2.yardTypes.main || type === MR2.yardTypes.outpost) {
          this.baseCellIndex.push({ cell, cellX: Number(cell.x), cellY: Number(cell.y) });
        }
      }
      this.baseCellVersion = this.cacheVersion;
    }
    if (width === undefined) {
      return this.baseCellIndex;
    }

    // The world is a torus and the viewport can straddle the seam, so a base
    // near x = 799 has to be drawn again at x = -1 when the camera is looking
    // across the join. The grid scan used to produce those repeats for free
    // because it iterated unwrapped coordinates; enumerating the cache does
    // not, so the copies are emitted here.
    const bounds = this.getVisibleCellBounds(width, height);
    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();
    const out = [];
    for (const entry of this.baseCellIndex) {
      for (let dx = Math.floor(bounds.minX / mapWidth); dx <= Math.floor(bounds.maxX / mapWidth); dx += 1) {
        const cellX = entry.cellX + dx * mapWidth;
        if (cellX < bounds.minX || cellX > bounds.maxX) {
          continue;
        }
        for (let dy = Math.floor(bounds.minY / mapHeight); dy <= Math.floor(bounds.maxY / mapHeight); dy += 1) {
          const cellY = entry.cellY + dy * mapHeight;
          if (cellY < bounds.minY || cellY > bounds.maxY) {
            continue;
          }
          out.push({ cell: entry.cell, cellX, cellY });
        }
      }
    }
    return out;
  }

  getVisibleCells(width, height) {
    const bounds = this.getVisibleCellBounds(width, height);
    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();
    const entries = [];

    for (let cellX = bounds.minX; cellX <= bounds.maxX; cellX += 1) {
      const wrappedX = positiveModulo(cellX, mapWidth);
      for (let cellY = bounds.minY; cellY <= bounds.maxY; cellY += 1) {
        const cell = this.cellCache.get(cellKey(wrappedX, positiveModulo(cellY, mapHeight)));
        if (cell) {
          entries.push({ cell, cellX, cellY });
        }
      }
    }

    return entries;
  }

  // Groups hexes by terrain band and fills each band with a single path,
  // which keeps large viewports smooth despite drawing thousands of cells.
  // Guest view: zones the shared cache has never seen are painted grey with
  // a "Not Cached" label (label only once a zone is large enough on screen
  // to fit it). Cached zones draw their normal terrain on top.
  drawUncachedZones(width, height) {
    const bounds = this.getVisibleCellBounds(width, height);
    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();
    const minZoneX = zoneOriginForCell(bounds.minX);
    const maxZoneX = zoneOriginForCell(bounds.maxX);
    const minZoneY = zoneOriginForCell(bounds.minY);
    const maxZoneY = zoneOriginForCell(bounds.maxY);

    const zonePixelWidth = MR2.zoneSize * MR2.columnStep * this.zoom;
    const zonePixelHeight = MR2.zoneSize * MR2.cellHeight * this.zoom;
    const showLabel = zonePixelWidth >= 84;
    const fontSize = clamp(zonePixelWidth * 0.11, 10, 18);
    const labels = [];

    this.ctx.save();
    this.ctx.fillStyle = "#2d2d2d";
    for (let zoneX = minZoneX; zoneX <= maxZoneX; zoneX += MR2.zoneSize) {
      for (let zoneY = minZoneY; zoneY <= maxZoneY; zoneY += MR2.zoneSize) {
        const key = zoneKey(positiveModulo(zoneX, mapWidth), positiveModulo(zoneY, mapHeight));
        if (this.loadedZones.has(key)) {
          continue;
        }

        const world = this.cellToWorld(zoneX, zoneY);
        const screenX = (world.x - this.offsetX) * this.zoom;
        const screenY = (world.y - this.offsetY) * this.zoom;
        // Cover the full odd-q footprint: cells overhang the column grid by
        // (cellWidth - columnStep) and odd columns shift down half a cell.
        const drawWidth = zonePixelWidth + (MR2.cellWidth - MR2.columnStep) * this.zoom;
        const drawHeight = zonePixelHeight + MR2.oddColumnOffset * this.zoom;
        this.ctx.fillRect(screenX, screenY, drawWidth + 1, drawHeight + 1);
        if (showLabel) {
          labels.push({
            x: screenX + drawWidth / 2,
            y: screenY + drawHeight / 2,
          });
        }
      }
    }

    if (labels.length) {
      this.ctx.fillStyle = "rgba(255, 255, 255, 0.34)";
      this.ctx.font = `600 ${fontSize}px Verdana, Geneva, 'DejaVu Sans', Tahoma, sans-serif`;
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
      for (const label of labels) {
        this.ctx.fillText("Not Cached", label.x, label.y);
      }
    }
    this.ctx.restore();
  }

  drawTerrainBatched(entries) {
    const byBand = new Map();

    for (const entry of entries) {
      const band = getTerrainBand(this.terrainHeightFor(entry.cell));
      let bucket = byBand.get(band.key);
      if (!bucket) {
        bucket = { band, cells: [] };
        byBand.set(band.key, bucket);
      }
      bucket.cells.push(entry);
    }

    if (this.zoom < LOD_SIMPLE_ZOOM && !this.forceDetailedExport) {
      // Simplified terrain: one rectangle per cell, batched per band. The hex
      // silhouette is invisible at this scale and rects are far cheaper.
      for (const bucket of byBand.values()) {
        this.ctx.fillStyle = bucket.band.fill;
        for (const entry of bucket.cells) {
          const world = this.cellToWorld(entry.cellX, entry.cellY);
          this.ctx.fillRect(
            (world.x - this.offsetX) * this.zoom,
            // Simplified view is deliberately FLAT: every cell sits on its own
            // row at a uniform height (liftFor returns 0 below the LOD
            // threshold). Relief at these zooms turns a tidy grid into a
            // ragged one for a few pixels of depth that read as noise. Only
            // the geometry is flattened - band colours are untouched.
            (world.y - this.offsetY + this.liftFor(entry.cell)) * this.zoom,
            MR2.cellWidth * this.zoom + 1,
            MR2.cellHeight * this.zoom + 1,
          );
        }
      }
      return;
    }

    // Zoomed in: the game's own painted terrain bitmaps.
    this.terrainTilesDrawn = this.drawTerrainTiles(entries);
    if (this.terrainTilesDrawn) {
      return;
    }

    // Fallback while the tile art is still loading - the flat band fills.
    for (const bucket of byBand.values()) {
      this.ctx.beginPath();
      for (const entry of bucket.cells) {
        const world = this.cellToWorld(entry.cellX, entry.cellY);
        const screenX = (world.x - this.offsetX) * this.zoom;
        const screenY = (world.y - this.offsetY + this.liftFor(entry.cell)) * this.zoom;
        this.appendHexPath(screenX, screenY, CELL_HEX_VERTICES);
      }
      this.ctx.fillStyle = bucket.band.fill;
      this.ctx.fill();
      if (this.zoom >= 0.32) {
        this.ctx.strokeStyle = bucket.band.edge;
        this.ctx.lineWidth = Math.max(0.6, 1 * this.zoom);
        this.ctx.stroke();
      }
    }
  }

  /**
   * The cell's vertical artwork offset (MapRoomCell.Update's mc.y).
   *
   * Zero in the simplified view, which is deliberately flat. Putting the test
   * here rather than at each call site keeps drawing and HIT TESTING in
   * agreement - a flat grid that was still hit-tested against lifted hexes
   * would mis-target by up to most of a row.
   */
  liftFor(cell) {
    if (this.zoom < LOD_SIMPLE_ZOOM && !this.forceDetailedExport) {
      return 0;
    }
    return cellLift(this.terrainHeightFor(cell));
  }

  /**
   * Terrain as the game draws it: eleven painted 151x101 bitmaps, one per
   * height band, composited back-to-front.
   *
   * Order is not optional here. A 101px-tall tile against a 75px row pitch
   * overhangs the row below by 26px, and elevation relief widens that further,
   * so the painter's sort is what keeps the overlaps right. The game does the
   * same with `cell.depth = cell.y * 1000 + cell.x` - note that is the FLAT
   * staggered y, before mc.y relief, so a raised cell never jumps its row.
   *
   * Returns false if any needed tile has not loaded yet, so the caller can
   * fall back to flat fills rather than drawing a half-tiled map.
   */
  drawTerrainTiles(entries) {
    const ordered = entries
      .map((entry) => {
        const world = this.cellToWorld(entry.cellX, entry.cellY);
        return { entry, world, depth: world.y * 1000 + world.x };
      })
      .sort((left, right) => left.depth - right.depth);

    const tiles = new Map();
    for (const item of ordered) {
      const frame = terrainFrameFor(this.terrainHeightFor(item.entry.cell));
      if (!tiles.has(frame)) {
        tiles.set(frame, this.assets.get(TERRAIN_TILE_PATH + frame + ".png"));
      }
      item.frame = frame;
    }
    if ([...tiles.values()].some((image) => !image)) {
      return false;
    }

    for (const item of ordered) {
      const height = this.terrainHeightFor(item.entry.cell);
      const screenX = (item.world.x - this.offsetX) * this.zoom;
      const screenY = (item.world.y - this.offsetY + cellLift(height)) * this.zoom;
      this.ctx.drawImage(
        tiles.get(item.frame),
        screenX, screenY,
        TERRAIN_TILE_W * this.zoom, TERRAIN_TILE_H * this.zoom,
      );
      // The cyan surface plane rides on a fixed plane while the bed sinks,
      // which is what makes deep water read darker.
      if (height < 100) {
        const surfaceY = (item.world.y - this.offsetY + cellLift(height)
          + waterSurfaceLift(height)) * this.zoom;
        this.ctx.fillStyle = WATER_SURFACE_FILL;
        this.ctx.beginPath();
        this.appendHexPath(screenX, surfaceY, CELL_HEX_VERTICES);
        this.ctx.fill();
      }
      // mcGlow is depth 3 INSIDE this cell's mc, so it belongs in the
      // per-cell painter order - not in a pass of its own after all the
      // terrain. Drawn separately, a glow on a cell further back painted over
      // the terrain of a taller cell in front of it; here the next cell's
      // tile covers it, exactly as the client composites.
      const glow = this.getGlowState(item.entry.cell);
      if (glow) {
        this.drawGlow(glow, screenX, screenY);
      }
    }
    return true;
  }

  // Flinger range outlines for the signed-in player's own bases.
  // Range rules come from BUILDING5.getFlingerRange; iteration mirrors
  // MapRoomPopup.GetCellsInRange (odd-q offset -> axial -> cube ring).
  /**
   * ApplyRangeHighlighting - which cells fall inside a flinger's reach.
   *
   * Ported verbatim: odd-q offset in, axial for the distance metric, odd-q
   * back out. `(x - (x & 1)) / 2` is the odd-q shove; distance is the cube
   * metric max(|q|, |r|, |s|) with s = -q - r.
   *
   * Two rules that are easy to miss and both matter:
   *   - the origin is skipped (`deltaQ == 0 && deltaR == 0` continues), and
   *   - water NEVER highlights (`if (cell && !cell._water)`).
   *
   * The 0.35 band exists only with the ALLIANCE_DECLAREWAR powerup, which
   * makes baseRange = range - 2. Without it every enumerated cell satisfies
   * distance <= baseRange, so the whole area is a uniform 0.5 - that is the
   * case here, since this viewer has no powerup state.
   */
  /**
   * Cached wrapper around computeRangeHighlight().
   *
   * The set only changes when the cell cache changes - a new zone arriving,
   * an own base appearing, a flinger level updating - or when the hidden
   * player list changes. It was being recomputed on every frame, walking the
   * WHOLE cache each time: 17ms per frame on a fully scanned world, for a
   * result that is identical until something merges.
   */
  rangeHighlight() {
    if (this.rangeHighlightVersion !== this.cacheVersion) {
      this.rangeHighlightKeys = this.computeRangeHighlight();
      this.rangeHighlightVersion = this.cacheVersion;
    }
    return this.rangeHighlightKeys;
  }

  computeRangeHighlight() {
    return this.computeFlingerReach((cell) => Number(cell.mine || 0) === 1);
  }

  // The flinger-range filter's anchor set: every yard owned by the chosen
  // relation groups (me / allies / enemies / other), radiating through the
  // same verbatim GetCellsInRange port as the own-range rings, so the
  // filter and the drawn rings can never disagree.
  computeFlingerReachFor(groups, relSets) {
    const wanted = new Set(groups || []);
    return this.computeFlingerReach((cell) => {
      const isMain = Number(cell.b) === MR2.yardTypes.main;
      if (!isMain && Number(cell.b) !== MR2.yardTypes.outpost) {
        return false;
      }
      let rel = "other";
      if (Number(cell.mine || 0) === 1) {
        rel = "me";
      } else {
        const owner = String(cell.n || "").trim().toLocaleLowerCase();
        if (relSets?.own?.has(owner)) rel = "me";
        else if (relSets?.enemies?.has(owner)) rel = "enemies";
        else if (relSets?.allies?.has(owner)) rel = "allies";
      }
      return wanted.has(rel);
    });
  }

  computeFlingerReach(anchorPredicate) {
    const keys = new Set();
    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();

    for (const cell of this.cellCache.values()) {
      if (!anchorPredicate(cell) || !this.doesContainDisplayableBase(cell)) {
        continue;
      }
      const isMain = Number(cell.b) === MR2.yardTypes.main;
      const range = getFlingerRange(cell.f, isMain);
      if (range <= 0) {
        continue;
      }

      // Optimistic home highlighting marks the home cell itself before it
      // radiates; the radiate loop below then skips its own origin.
      if (isMain) {
        keys.add(cellKey(Number(cell.x), Number(cell.y)));
      }

      const startX = Number(cell.x);
      const startY = Number(cell.y);
      const startAxialQ = startX;
      const startAxialR = startY - (startX - (startX & 1)) / 2;

      for (let deltaQ = -range; deltaQ <= range; deltaQ += 1) {
        const minDeltaR = Math.max(-range, -deltaQ - range);
        const maxDeltaR = Math.min(range, -deltaQ + range);
        for (let deltaR = minDeltaR; deltaR <= maxDeltaR; deltaR += 1) {
          if (deltaQ === 0 && deltaR === 0) {
            continue;
          }
          const currentX = startAxialQ + deltaQ;
          const currentY = (startAxialR + deltaR) + (currentX - (currentX & 1)) / 2;
          const wrappedX = positiveModulo(currentX, mapWidth);
          const wrappedY = positiveModulo(currentY, mapHeight);
          const target = this.cellCache.get(cellKey(wrappedX, wrappedY));
          // GetCell returns only instantiated cells, and water is excluded.
          if (!target || Number(this.terrainHeightFor(target)) < 100) {
            continue;
          }
          keys.add(cellKey(wrappedX, wrappedY));
        }
      }
    }

    return keys;
  }

  /**
   * mcGlow, drawn between terrain and cell contents - it is depth 3 inside
   * `mc`, above the terrain shape but below mcPlayer at depth 22.
   */
  drawGlowPass(entries) {
    // Only for the flat-fill fallback path: when the painted tiles are up,
    // drawTerrainTiles interleaves the glow per cell instead. Nothing glows
    // in the simplified view.
    if (this.terrainTilesDrawn || this.zoom < LOD_SIMPLE_ZOOM) {
      return;
    }
    for (const entry of entries) {
      const state = this.getGlowState(entry.cell);
      if (!state) {
        continue;
      }
      const world = this.cellToWorld(entry.cellX, entry.cellY);
      this.drawGlow(
        state,
        (world.x - this.offsetX) * this.zoom,
        (world.y - this.offsetY + this.liftFor(entry.cell)) * this.zoom,
      );
    }
  }

  drawCellContents({ cell: rawCell, cellX, cellY }) {
    // A hidden base draws as the wild monster cell it masquerades as, so the
    // marker, tribe art, level and name all come from one substituted cell.
    const cell = this.displayCell(rawCell);
    const world = this.cellToWorld(cellX, cellY);
    const screenX = (world.x - this.offsetX) * this.zoom;
    // Cell contents ride the terrain: mcPlayer and everything anchored to it
    // are children of the same `mc` that MapRoomCell.Update lifts, so a base
    // on high ground sits with its ground, not floating above it.
    const simplified = this.zoom < LOD_SIMPLE_ZOOM;
    // liftFor is already zero in the simplified view, so markers land on the
    // same uniform rows as the ground beneath them.
    const screenY = (world.y - this.offsetY + this.liftFor(rawCell)) * this.zoom;

    if (!this.shouldDisplayBaseCell(cell)) {
      return;
    }

    if (simplified) {
      this.drawSimpleBaseMarker(cell, screenX, screenY);
      return;
    }


    const highlightStyle = this.getHighlightStyle(cell);
    if (highlightStyle) {
      this.drawHighlight(highlightStyle, screenX, screenY);
    }

    // No hex outlines or tinted overlays on owned bases any more: the
    // relationship is carried by the name bar's own colour instead, which is
    // where the client puts it (SetupAlliance's frame labels).

    const iconPaths = this.getIconPathsForCell(cell);
    if (iconPaths) {
      const isWild = Number(cell.b) === MR2.yardTypes.wildMonster;
      const faded = isWild && Number(cell.d || 0) === 1;
      if (faded) {
        this.ctx.save();
        this.ctx.globalAlpha = 0.45;
      }
      this.drawCellArt(iconPaths, screenX, screenY);
      if (faded) {
        this.ctx.restore();
      }
    }

    // The bubble is depth 2 inside mcPlayer, above the base artwork. Wild
    // monster cells have no protected frame, so they keep the flat badge.
    if (Number(cell.p || 0) === 1 && Number(cell.b) === MR2.yardTypes.wildMonster) {
      this.drawCenteredIcon(ASSET_PATHS.damageProtection, screenX, screenY);
    } else {
      this.drawProtectionBubble(cell, screenX, screenY);
    }

    // mcFlag is depth 7 and mcLevel depth 28, both ABOVE the base artwork at
    // depth 1 - which is the draw order corrected during the research.
    this.drawNameBar(cell, screenX, screenY);
    this.drawLevelStar(cell, screenX, screenY);

    // Names are drawn on the bar by drawNameBar, exactly as mcFlag.txt does.
    // The floating white label under the cell was this viewer's own invention
    // and duplicated it, so it is gone.

    // Loot pills are main-yards-only: outposts stay quiet even with the
    // map overlay on.
    if (this.showLoot && this.zoom >= LABEL_RENDER_ZOOM_MIN
      && Number(cell.b) === MR2.yardTypes.main) {
      this.drawLootLabel(cell, screenX, screenY);
    }
    if (this.showOutpostTypes && this.zoom >= LABEL_RENDER_ZOOM_MIN
      && Number(cell.b) === MR2.yardTypes.outpost) {
      this.drawOutpostTypeLabel(cell, screenX, screenY);
    }
    this.drawIdleWorker(cell, screenX, screenY);
  }

  // The game's idle-worker figure (mcWorker) on OWN outposts with no
  // housing job running - shown exactly per MapRoomCell.as:
  // !workerBusy && base == 3 && mine, where busy means the housing
  // finishtime is still in the future. Position replicates the SWF's
  // placement chain: mcPlayer at (61.5, 41) + mcWorker at (47.25,
  // -24.75) = (108.75, 16.25) from the cell origin, art 27x27.
  drawIdleWorker(cell, screenX, screenY) {
    if (!this.showIdleWorkers) return;
    if (Number(cell.b) !== MR2.yardTypes.outpost || Number(cell.mine || 0) !== 1) return;
    const finishAt = Number(cell.mft || 0);
    if (finishAt > Date.now() / 1000) return;          // worker busy
    const image = this.assets.get(MAPROOM_UI.workerIdle);
    if (!image) return;
    this.ctx.drawImage(
      image,
      screenX + 108.75 * this.zoom,
      screenY + 16.25 * this.zoom,
      27 * this.zoom,
      27 * this.zoom,
    );
  }

  // Kit-tier text over the owner name on outposts, sharing the raised
  // loot-pill spot. Colours per tier; Ultra is black with a purple
  // outline so it reads on any terrain.
  drawOutpostTypeLabel(cell, screenX, screenY) {
    const key = getOutpostKitKey(Number(cell.v || 0));
    // Ultra carries an extra white halo outside the black outline, at half
    // the black ring's visible thickness, so it pops on any terrain.
    const styles = {
      none: { label: "NO KIT", fill: "#ff4a3d", stroke: "rgba(0,0,0,0.85)" },
      regular: { label: "REGULAR", fill: "#7fd4ff", stroke: "rgba(0,0,0,0.85)" },
      mega: { label: "MEGA", fill: "#ffd700", stroke: "rgba(0,0,0,0.85)" },
      ultra: { label: "ULTRA", fill: "#8a2be2", stroke: "#ffffff", halo: "rgba(0,0,0,0.85)" },
    };
    const style = styles[key] || styles.none;
    // Same color per family; the subtier only extends the text ("MEGA++").
    const label = style.label + getOutpostKitSuffix(Number(cell.v || 0));
    const fontSize = Math.max(9, Math.round(13 * this.zoom));
    const centerX = screenX + (MR2.cellWidth * this.zoom) / 2;
    // Same below-the-name-bar spot as the loot pill.
    const textY = screenY + 61 * this.zoom;
    this.ctx.save();
    this.ctx.font = `700 ${fontSize}px Verdana, Geneva, 'DejaVu Sans', Tahoma, sans-serif`;
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    if (style.halo) {
      // Outer stroke draws first. 4.5 over an inner 1.5 leaves the outer
      // ring twice as thick as the inner one.
      this.ctx.lineWidth = 4.5;
      this.ctx.strokeStyle = style.halo;
      this.ctx.strokeText(label, centerX, textY);
    }
    this.ctx.lineWidth = style.halo ? 1.5 : 3;
    this.ctx.strokeStyle = style.stroke;
    this.ctx.strokeText(label, centerX, textY);
    this.ctx.fillStyle = style.fill;
    this.ctx.fillText(label, centerX, textY);
    this.ctx.restore();
  }

  // Purple halo drawn around every main yard, underneath any group
  // highlight stroke so both remain visible.

  // Far-zoom base marker: a small colored square that keeps ownership and
  // group information readable when icons would be sub-pixel noise.
  drawSimpleBaseMarker(cell, screenX, screenY) {
    if (!Number(cell?.b)) {
      return;
    }

    // Wild tribe camps are pure noise at far zoom (they cover most of the
    // map); their purple markers are skipped entirely. They reappear as
    // camp art once the zoom crosses LOD_SIMPLE_ZOOM.
    if (Number(cell.b) === MR2.yardTypes.wildMonster) {
      return;
    }

    const role = this.getPlayerHighlightColor(cell);
    const isMainYard = Number(cell.b) === MR2.yardTypes.main;
    const isOutpost = Number(cell.b) === MR2.yardTypes.outpost;
    let color = "#c9c2ae";
    if (Number(cell.mine || 0) === 1) {
      color = "#5aa9ff";
    } else if (role === "enemy") {
      color = isOutpost ? "#96201a" : "#ff5c4a";
    } else if (role === "ally") {
      color = "#34d6ec";
    } else if (isOutpost) {
      color = "#ffd640";
    } else if (isMainYard) {
      color = "#f0a35e";
    }

    // Main yards are the thing worth finding at far zoom, so they keep a
    // floor of 3px while outposts may shrink away. The new zoom range reaches
    // 0.038, where 0.42 of a cell is well under a pixel.
    const scaled = MR2.cellWidth * this.zoom * 0.42;
    const size = isMainYard ? Math.max(3, scaled) : Math.max(2, scaled);
    const markerX = screenX + (MR2.cellWidth * this.zoom - size) / 2;
    const markerY = screenY + (MR2.cellHeight * this.zoom - size) / 2;

    // A main yard reads as the larger marker with a dark keyline; the purple
    // halo is gone along with the rest of the purple scheme.
    this.ctx.fillStyle = color;
    this.ctx.fillRect(markerX, markerY, size, size);
    if (isMainYard) {
      this.ctx.strokeStyle = "rgba(0, 0, 0, 0.65)";
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(markerX + 0.5, markerY + 0.5, size - 1, size - 1);
    }

    // Main yard names stay visible even in far-zoom simplified mode; they
    // are collected and drawn on top of all markers.
    if (isMainYard) {
      this.pendingMainLabels.push({
        cell,
        screenX,
        screenY,
        stroke: this.getMainLabelStrokeColor(cell),
      });
    }
  }

  // Sorted loot totals across every cached cell that shows a loot pill.
  // Rebuilt lazily when the cache grows or after 60s, so refreshed zones
  // fold in without resorting on every frame. Same coverage caveat as the
  // kit tallies: it only knows cells this viewer has cached.
  getLootDistribution() {
    const now = Date.now();
    const cached = this.lootDistribution;
    if (cached && cached.cellCount === this.cellCache.size && now - cached.builtAt < 60_000) {
      return cached.values;
    }
    const values = [];
    for (const cell of this.cellCache.values()) {
      const loot = getCellLootTotal(cell);
      if (loot > 0) {
        values.push(loot);
      }
    }
    values.sort((a, b) => a - b);
    this.lootDistribution = { values, builtAt: now, cellCount: this.cellCache.size };
    return values;
  }

  // "Top 1%" / "Bottom 10%" style label for a cell's total loot, against the
  // whole cached population. The ladder mirrors at the median: at or above
  // it reads Top, below it reads Bottom, each snapped to the smallest band
  // that contains the cell.
  getLootTierLabel(loot) {
    const values = this.getLootDistribution();
    const n = values.length;
    if (!n) {
      return null;
    }
    // Binary searches for the tie-safe counts on each side.
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (values[mid] < loot) lo = mid + 1; else hi = mid; }
    const strictlyBelow = lo;
    hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (values[mid] <= loot) lo = mid + 1; else hi = mid; }
    const atOrBelow = lo;
    const BANDS = [0.1, 1, 5, 10, 25, 50];
    // At or above the median reads Top; ties straddling it snap to Top 50%.
    if (atOrBelow / n >= 0.5) {
      const topShare = ((n - strictlyBelow) / n) * 100;
      const band = BANDS.find((b) => topShare <= b) ?? 50;
      return `Top ${band}%`;
    }
    const bottomShare = (atOrBelow / n) * 100;
    const band = BANDS.find((b) => bottomShare <= b) ?? 50;
    return `Bottom ${band}%`;
  }

  drawLootLabel(cell, screenX, screenY) {
    const style = LOOT_RESOURCE_STYLES[this.lootResource] || LOOT_RESOURCE_STYLES.total;
    const tierMode = this.lootResource === "tier";
    const loot = (tierMode || this.lootResource === "total")
      ? getCellLootTotal(cell)
      : (Number(cell?.r?.[this.lootResource]) || 0);
    if (loot <= 0) {
      return;
    }

    let text;
    let pillColor = style.color;
    if (tierMode) {
      text = this.getLootTierLabel(loot);
      if (!text) {
        return;
      }
      // Bright gold for the truly rich, muted for the bottom half, so the
      // tiers scan at a glance without reading every pill.
      if (text === "Top 0.1%" || text === "Top 1%") {
        pillColor = "#ffd700";
      } else if (text.startsWith("Bottom")) {
        pillColor = "#c9c9c9";
      }
    } else {
      text = formatCompactNumber(loot);
    }
    const fontSize = Math.max(9, Math.round(13 * this.zoom));
    // Centred on the yard/outpost rather than hanging below it: the pill is
    // about that cell, and below the tile it collided with the owner label
    // and read as belonging to whatever sat underneath.
    const centerX = screenX + (MR2.cellWidth * this.zoom) / 2;
    // Just below the name/health bar (plate bottom sits at 53 world px
    // from the cell origin); world units scaled by zoom keep the spot
    // fixed on the cell at any zoom.
    const textY = screenY + 61 * this.zoom;

    this.ctx.save();
    this.ctx.font = `700 ${fontSize}px Verdana, Geneva, 'DejaVu Sans', Tahoma, sans-serif`;
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    const paddingX = 5;
    const width = this.ctx.measureText(text).width + paddingX * 2;
    this.ctx.fillStyle = "rgba(20, 16, 8, 0.72)";
    this.ctx.beginPath();
    this.ctx.roundRect(centerX - width / 2, textY - fontSize * 0.72, width, fontSize * 1.44, 4);
    this.ctx.fill();
    this.ctx.fillStyle = pillColor;
    this.ctx.fillText(text, centerX, textY);
    this.ctx.restore();
  }



  // Draws base art centered on the cell, scaled down (never up) to fit the
  // hex footprint while preserving aspect ratio; tall art may overhang the
  // top like in the original game.
  drawCellArt(paths, screenX, screenY) {
    let image = null;
    let matched = null;
    for (const path of paths) {
      image = this.assets.get(path);
      if (image) {
        matched = path;
        break;
      }
    }
    if (!image) {
      return;
    }

    // Anchored at mcPlayer, at the frame's own bounds - not scaled to fit the
    // cell and centred in it, which is what this used to do and why the art
    // sat low and small in its diamond.
    const bounds = CELL_ART_BOUNDS[CELL_ART_PLACEMENT[matched]] || null;
    if (!bounds) {
      // Unknown art: fall back to natural size on the anchor.
      this.ctx.drawImage(
        image,
        screenX + MC_PLAYER_ANCHOR.x * this.zoom,
        screenY + MC_PLAYER_ANCHOR.y * this.zoom,
        image.width * this.zoom, image.height * this.zoom,
      );
      return;
    }
    // A PNG wider than its bounds has a stroke baked in that grew it evenly.
    const bleedX = (image.width - bounds.width) / 2;
    const bleedY = (image.height - bounds.height) / 2;
    this.ctx.drawImage(
      image,
      screenX + (MC_PLAYER_ANCHOR.x + bounds.x - bleedX) * this.zoom,
      screenY + (MC_PLAYER_ANCHOR.y + bounds.y - bleedY) * this.zoom,
      image.width * this.zoom,
      image.height * this.zoom,
    );
  }

  drawCenteredIcon(path, screenX, screenY) {
    const image = this.assets.get(path);
    if (!image) {
      return;
    }

    const drawX = screenX + (MR2.cellWidth - image.width) * 0.5 * this.zoom;
    const drawY = screenY + (MR2.cellHeight - image.height) * 0.5 * this.zoom;
    this.ctx.drawImage(image, drawX, drawY, image.width * this.zoom, image.height * this.zoom);
  }

  /**
   * mcPlayer.mcFlag.nameBar - the name/health bar.
   *
   * Geometry is the SWF's: a 101x26 mcBG plate with mcBar over it, the whole
   * nameBar at (-34, -4) from mcPlayer scaled 0.95013 x 0.64. Update() sets
   * `mcBar.width = Math.max(0, 100 - _damage)` in nameBar space, so the fill
   * is a straight percentage of 100 units, NOT of the plate's own width.
   *
   * The bar is drawn for every base, not only damaged ones: the undamaged
   * branch of Update() is `mcBar.width = 100`, a full bar, which is what
   * carries the alliance colour.
   *
   * Colour comes from SetupAlliance()'s label: wmyard for wild tribes, player
   * for your own, none otherwise (this viewer has no alliance relationships to
   * resolve). The destroyed swap is deliberately inside `if (_base == 1)` in
   * the client, so player yards and outposts keep their normal colour when
   * destroyed - only wild tribes repaint.
   */
  drawNameBar(cell, screenX, screenY) {
    const base = Number(cell.b || 0);
    if (base <= 0) {
      return;
    }
    // Clamped for display only: anything above the ceiling renders as the
    // ceiling, so a heavily damaged base still shows a readable sliver.
    const damage = clamp(Number(cell.dm || 0), 0, NAME_BAR_MAX_DISPLAY_DAMAGE);
    const destroyed = Number(cell.d || 0) === 1;

    // SetupAlliance's frame labels. The ally and hostile frames exist in the
    // SWF but the client only reaches them from real alliance relationships;
    // here they are driven by this viewer's own ally/enemy lists, which is
    // what the removed hex outlines used to convey.
    let label = "none";
    if (base === MR2.yardTypes.wildMonster) {
      label = destroyed ? "destroyed" : "wmyard";
    } else if (Number(cell.mine || 0) === 1) {
      label = "player";
    } else {
      const role = this.getPlayerHighlightColor(cell);
      if (role === "ally") {
        label = "ally";
      } else if (role === "enemy") {
        label = "hostile";
      }
    }
    const colours = NAME_BAR_COLOURS[label] || NAME_BAR_COLOURS.none;

    const originX = screenX + (MC_PLAYER_ANCHOR.x + NAME_BAR.offsetX) * this.zoom;
    const originY = screenY + (MC_PLAYER_ANCHOR.y + NAME_BAR.offsetY) * this.zoom;
    const scaleX = NAME_BAR.scaleX * this.zoom;
    const scaleY = NAME_BAR.scaleY * this.zoom;

    // Every label's plate is the same box - 100 x 25 at the nameBar origin.
    // `none` and `wmyard` reach it through a scaled generic rectangle whose
    // translation and bounds cancel out; see NAME_BAR in shared.js.
    this.ctx.save();
    // Where the authored plate and fill are indistinguishable, the exposed
    // part is darkened so the depletion actually reads. See
    // NAME_BAR_EMPTY_DARKEN - the one deviation from the client here.
    this.ctx.fillStyle = colourDistance(colours.bg, colours.bar) < NAME_BAR_CONTRAST_THRESHOLD
      ? darkenHex(colours.bg, NAME_BAR_EMPTY_DARKEN)
      : colours.bg;
    this.ctx.fillRect(
      originX + NAME_BAR.bgX * scaleX, originY + NAME_BAR.bgY * scaleY,
      NAME_BAR.bgWidth * scaleX, NAME_BAR.bgHeight * scaleY,
    );

    // mcBar.width = max(0, 100 - dm), in nameBar space: a straight percentage
    // of 100 units, not of the plate's own width.
    const filled = Math.max(0, NAME_BAR.barFullWidth - damage);
    if (filled > 0) {
      this.ctx.fillStyle = colours.bar;
      this.ctx.fillRect(
        originX, originY + NAME_BAR.barY * scaleY,
        filled * scaleX, NAME_BAR.barHeight * scaleY,
      );
    }
    // The plate's outline. The #120 shape is a soft stroke that peaks at
    // alpha 95, and scaled down to the bar's 0.64 vertical it washed out to
    // grey; in game the border reads as solid black, so it is drawn as a
    // crisp 1px stroke instead of the bitmap.
    this.ctx.strokeStyle = NAME_BAR_OUTLINE;
    this.ctx.lineWidth = Math.max(1, this.zoom);
    this.ctx.strokeRect(
      originX + 0.5, originY + 0.5,
      NAME_BAR.bgWidth * scaleX - 1, NAME_BAR.bgHeight * scaleY - 1,
    );
    this.ctx.restore();

    // mcFlag.txt sits on the bar, centred, 8px Verdana Bold in black.
    const name = String(cell.n || "").trim();
    if (name) {
      this.ctx.save();
      this.ctx.font = `bold ${NAME_TEXT.fontSize * this.zoom}px Verdana, Geneva, 'DejaVu Sans', Tahoma, sans-serif`;
      this.ctx.fillStyle = NAME_TEXT.colour;
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
      this.ctx.fillText(
        name,
        screenX + (MC_PLAYER_ANCHOR.x + NAME_TEXT.centreX) * this.zoom,
        screenY + (MC_PLAYER_ANCHOR.y + NAME_TEXT.centreY) * this.zoom,
      );
      this.ctx.restore();
    }
  }

  /**
   * mcPlayer.mcLevel - the level star.
   *
   * Frame 1 (grey #B9B9B9 star, #333333 text) for wild tribes, frame 2 (gold
   * #D3A000, #80500A text) for players. Update() asserts
   * `mcLevel.visible = false` and re-enables it only when `_level > 0`.
   */
  drawLevelStar(cell, screenX, screenY) {
    const level = Number(cell.l || 0);
    if (level <= 0) {
      return;
    }
    const wild = Number(cell.b) === MR2.yardTypes.wildMonster;
    const style = wild ? LEVEL_PLACEMENT.wild : LEVEL_PLACEMENT.player;
    const star = this.assets.get(MAPROOM_UI[style.star]);
    if (!star) {
      return;
    }

    const centreX = screenX + LEVEL_PLACEMENT.x * this.zoom;
    const centreY = screenY + LEVEL_PLACEMENT.y * this.zoom;
    this.ctx.drawImage(
      star,
      centreX + LEVEL_PLACEMENT.starOffsetX * this.zoom,
      centreY + LEVEL_PLACEMENT.starOffsetY * this.zoom,
      LEVEL_PLACEMENT.starWidth * this.zoom,
      LEVEL_PLACEMENT.starHeight * this.zoom,
    );

    this.ctx.save();
    this.ctx.font = `bold ${LEVEL_PLACEMENT.fontSize * this.zoom}px Verdana, Geneva, 'DejaVu Sans', Tahoma, sans-serif`;
    this.ctx.fillStyle = style.text;
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    if ("letterSpacing" in this.ctx) {
      this.ctx.letterSpacing = `${LEVEL_PLACEMENT.letterSpacing * this.zoom}px`;
    }
    this.ctx.fillText(
      String(level),
      centreX + LEVEL_PLACEMENT.textOffsetX * this.zoom,
      centreY + LEVEL_PLACEMENT.textOffsetY * this.zoom,
    );
    this.ctx.restore();
  }

  /**
   * The damage-protection bubble (#151 wrapping shape #150).
   *
   * Authored once at 80x64 and stretched per footprint - it is BIGGER than the
   * base artwork it covers (95.7x78.5 over an 87x76 main yard), which is why
   * it cannot be baked into the -protected cell frames and has to be drawn
   * separately. That omission is why no bubble appeared at all.
   */
  drawProtectionBubble(cell, screenX, screenY) {
    if (Number(cell.p || 0) !== 1) {
      return;
    }
    const base = Number(cell.b);
    const placement = base === MR2.yardTypes.main
      ? PROTECTION_PLACEMENT.main
      : (base === MR2.yardTypes.outpost ? PROTECTION_PLACEMENT.outpost : null);
    if (!placement) {
      return;
    }
    const bubble = this.assets.get(MAPROOM_UI.protection);
    if (!bubble) {
      return;
    }
    // The shape's bounds offset lives INSIDE #151's scaled space, so it is
    // added before the stretch. The export carries the usual half-pixel bleed
    // on each side, which is backed out the same way as the cell art.
    const bleedX = (bubble.width - PROTECTION_BOUNDS.width) / 2;
    const bleedY = (bubble.height - PROTECTION_BOUNDS.height) / 2;
    this.ctx.drawImage(
      bubble,
      screenX + (MC_PLAYER_ANCHOR.x + placement.x
        + (PROTECTION_BOUNDS.x - bleedX) * placement.scaleX) * this.zoom,
      screenY + (MC_PLAYER_ANCHOR.y + placement.y
        + (PROTECTION_BOUNDS.y - bleedY) * placement.scaleY) * this.zoom,
      bubble.width * placement.scaleX * this.zoom,
      bubble.height * placement.scaleY * this.zoom,
    );
  }

  drawLabel(cell, screenX, screenY, strokeStyle = "rgba(0, 0, 0, 0.7)") {
    const name = String(cell.n || "").trim();
    if (!name) {
      return;
    }

    // Level lives on mcLevel's star now, exactly as the client draws it, so
    // the text label is just the name.
    const label = name;
    this.ctx.save();
    this.ctx.font = `${Math.max(11, 11 * this.zoom)}px Verdana, Geneva, 'DejaVu Sans', Tahoma, sans-serif`;
    this.ctx.textAlign = "center";
    this.ctx.fillStyle = "#ffffff";
    this.ctx.strokeStyle = strokeStyle;
    this.ctx.lineWidth = 3;
    const labelX = screenX + MR2.cellWidth * 0.5 * this.zoom;
    const labelY = screenY + (MR2.cellHeight - 6) * this.zoom;
    this.ctx.strokeText(label, labelX, labelY);
    this.ctx.fillText(label, labelX, labelY);
    this.ctx.restore();
  }

  setShowIdleWorkers(flag) {
    this.showIdleWorkers = Boolean(flag);
    this.render();
  }

  setShowOutpostTypes(flag) {
    this.showOutpostTypes = Boolean(flag);
    this.render();
  }

  setShowLoot(flag) {
    this.showLoot = Boolean(flag);
    this.render();
  }

  setLootResource(key) {
    this.lootResource = LOOT_RESOURCE_KEYS.includes(key) ? key : "total";
    this.render();
  }

  setHiddenPlayers(names = []) {
    this.hiddenPlayerNames = new Set(
      names.map((name) => String(name).trim().toLocaleLowerCase()).filter(Boolean),
    );
    // Disguises are computed from coordinates now, so there is no memo to
    // invalidate here - but the range-highlight set depends on which cells
    // are displayable, so it does have to be rebuilt.
    this.cacheVersion += 1;
    this.render();
  }

  /**
   * The wild monster cell a hidden base is rendered as.
   *
   * This used to copy the NEAREST loaded tribe and blend a fake height from
   * the neighbours, which had three problems: it memoized a live reference to
   * another cell object (so a merge left the disguise stale), it needed a
   * tribe to be loaded before it could disguise anything, and the result was
   * an approximation that a player who knew the generator could spot.
   *
   * MR2 generation makes all of that unnecessary. Tribe and level are pure
   * functions of (x + y), so the cell that WOULD have generated here can be
   * computed exactly, offline, with no cache lookups and nothing to memoize.
   * The height passes through untouched: userCell and wildMonsterCell both
   * emit the same seeded terrainHeight, so a hidden base already carries the
   * exact height its wild counterpart would have had. Blending it was what
   * made these tiles conspicuous in the first place.
   */
  hiddenDisguiseFor(cell) {
    return generatedWildCell(cell.x, cell.y, this.terrainHeightFor(cell));
  }

  /**
   * What to draw for this cell. A hidden base returns the wild monster cell
   * it is masquerading as, so every read - terrain, marker, tribe, level -
   * comes from one consistent source rather than a half-substituted cell.
   */
  displayCell(cell) {
    if (!cell || !this.isCellHidden(cell)) {
      return cell;
    }
    return { ...this.hiddenDisguiseFor(cell), hiddenDisguised: true };
  }

  terrainHeightFor(cell) {
    if (!this.isCellHidden(cell) || this.hiddenTileStyle !== "water") {
      // Real terrain height, hidden or not: it is generated from position, so
      // it is identical to the wild cell's and gives the disguise away to
      // nobody. Legacy caches may still carry a blendedHeight from the old
      // scheme; it is deliberately ignored rather than trusted.
      return cell.i;
    }
    return 60; // water1 band - mirrors the server's HIDDEN_WATER_HEIGHT
  }

  isCellHidden(cell) {
    if (!this.hiddenPlayerNames.size) {
      return false;
    }
    const name = String(cell?.n || "").trim().toLocaleLowerCase();
    return Boolean(name) && this.hiddenPlayerNames.has(name);
  }

  setPlayerHighlights({ allies = [], enemies = [] } = {}) {
    this.highlightNames = {
      allies: new Set(allies.map((name) => String(name).trim().toLocaleLowerCase()).filter(Boolean)),
      enemies: new Set(enemies.map((name) => String(name).trim().toLocaleLowerCase()).filter(Boolean)),
    };
    // The full-cache rebuild costs ~100ms on a well-explored world; alliance
    // polls call this every cycle with identical rosters, so only rebuild
    // when the sets genuinely changed (merges keep them updated in between,
    // and reloads rebuild explicitly during bootstrap).
    const signature = [...this.highlightNames.allies].sort().join("|")
      + "//" + [...this.highlightNames.enemies].sort().join("|");
    if (signature !== this.highlightSignature) {
      this.highlightSignature = signature;
      this.rebuildFreshnessZones();
    }
    this.render();
  }

  // True when the cached copy of a 10x10 zone contains a base owned by an
  // ally (which always includes the signed-in player). Such zones are never
  // treated as fresh by the 1-hour cache rule.
  // ---- tiered zone freshness ------------------------------------------
  rebuildFreshnessZones() {
    this.ownZones = new Set();
    this.allyZones = new Set();
    this.ownMainZones = new Set();
    this.ownOutpostZones = new Set();
    // The home cell is known from the session even before its zone loads.
    if (this.homeCellKey) {
      const [homeX, homeY] = this.homeCellKey.split(",").map(Number);
      if (Number.isFinite(homeX) && Number.isFinite(homeY)) {
        const homeZone = zoneKey(
          Math.floor(homeX / MR2.zoneSize) * MR2.zoneSize,
          Math.floor(homeY / MR2.zoneSize) * MR2.zoneSize,
        );
        this.ownMainZones.add(homeZone);
        this.ownZones.add(homeZone);
      }
    }
    for (const cell of this.cellCache.values()) {
      this.noteFreshnessCell(cell);
    }
  }

  noteFreshnessCell(cell) {
    const baseType = Number(cell?.b);
    if (baseType !== MR2.yardTypes.main && baseType !== MR2.yardTypes.outpost) {
      return;
    }
    const key = zoneKey(
      Math.floor(cell.x / MR2.zoneSize) * MR2.zoneSize,
      Math.floor(cell.y / MR2.zoneSize) * MR2.zoneSize,
    );
    if (Number(cell.mine || 0) === 1) {
      this.ownZones.add(key);
      if (baseType === MR2.yardTypes.main) {
        this.ownMainZones.add(key);
      } else {
        this.ownOutpostZones.add(key);
      }
    }
    const name = String(cell.n || "").trim().toLocaleLowerCase();
    if (name && this.highlightNames.allies.has(name)) {
      this.allyZones.add(key);
    }
  }

  // Minimum Chebyshev distance in zone units from any own-base zone,
  // wrap-aware. Infinity when the player owns nothing we know of.
  zoneRingDistance(zoneX, zoneY, fromZones = this.ownZones) {
    if (!fromZones.size) {
      return Infinity;
    }
    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();
    let best = Infinity;
    for (const key of fromZones) {
      const [ownX, ownY] = key.split(",").map(Number);
      const dx = Math.abs(zoneX - ownX);
      const dy = Math.abs(zoneY - ownY);
      const wrappedDx = Math.min(dx, mapWidth - dx) / MR2.zoneSize;
      const wrappedDy = Math.min(dy, mapHeight - dy) / MR2.zoneSize;
      best = Math.min(best, Math.max(wrappedDx, wrappedDy));
    }
    return best;
  }

  // Fetch priority for the shared, server-scheduled API budget: 1 (lowest)
  // to 10 (highest), applied globally across every signed-in user. Own bases
  // beat allied bases, and proximity to either beats open wilderness:
  //
  //    9  the zone holding your main yard (10 is reserved for clicks)
  //    8  zones holding your outposts
  //    7  zones holding allied bases
  //    6  within 2 zones of your own bases
  //    5  within 2 zones of allied bases
  //    4  within 4 zones of your own bases
  //    3  within 4 zones of allied bases
  //    2  within 6 zones of your own or allied bases
  //    1  everything else
  //
  // (A zone fetched to open a base viewer is forced to 10 by its caller.)
  zonePriorityFor(zoneX, zoneY) {
    const key = zoneKey(zoneX, zoneY);
    if (this.ownMainZones.has(key)) {
      // 9, not 10: tier 10 is reserved for requests a person is actively
      // waiting on, so a background refresh of your own zone cannot land in
      // front of a base you just clicked.
      return 9;
    }
    if (this.ownOutpostZones.has(key)) {
      return 8;
    }
    if (this.allyZones.has(key)) {
      return 7;
    }
    const own = this.zoneRingDistance(zoneX, zoneY, this.ownZones);
    const ally = this.zoneRingDistance(zoneX, zoneY, this.allyZones);
    // A zone can satisfy several tiers at once (e.g. near your own bases AND
    // near an ally's). Always take the HIGHEST matching tier, never a lower.
    let best = 1;
    if (own <= 6 || ally <= 6) best = Math.max(best, 2);
    if (ally <= 4) best = Math.max(best, 3);
    if (own <= 4) best = Math.max(best, 4);
    if (ally <= 2) best = Math.max(best, 5);
    if (own <= 2) best = Math.max(best, 6);
    return best;
  }

  zoneMaxAgeFor(zoneX, zoneY) {
    const key = zoneKey(zoneX, zoneY);
    if (this.ownZones.has(key) || this.allyZones.has(key)) {
      return MR2.zoneFreshness.ownAllyMs;
    }
    const ring = this.zoneRingDistance(zoneX, zoneY);
    if (ring <= 2) {
      return MR2.zoneFreshness.ring2Ms;
    }
    if (ring <= 4) {
      return MR2.zoneFreshness.ring4Ms;
    }
    return MR2.zoneFreshness.farMs;
  }

  zoneContainsAlly(zoneX, zoneY) {
    if (!this.highlightNames.allies.size) {
      return false;
    }

    for (let deltaX = 0; deltaX < MR2.zoneSize; deltaX += 1) {
      for (let deltaY = 0; deltaY < MR2.zoneSize; deltaY += 1) {
        const cell = this.cellCache.get(cellKey(zoneX + deltaX, zoneY + deltaY));
        if (!cell) {
          continue;
        }

        const baseType = Number(cell.b);
        if (baseType !== MR2.yardTypes.main && baseType !== MR2.yardTypes.outpost) {
          continue;
        }

        const name = String(cell.n || "").trim().toLocaleLowerCase();
        if (name && this.highlightNames.allies.has(name)) {
          return true;
        }
      }
    }

    return false;
  }

  // Returns "enemy" | "ally" | null for player-owned cells whose owner name
  // is on a group list. Enemy wins when a name is on both lists. Applies to
  // main yards and outposts (both carry the owner name in `n`). The player's
  // own bases keep their blue "mine" overlay even though the player is
  // always part of the Allies group.
  getPlayerHighlightColor(cell) {
    const baseType = Number(cell.b);
    if (baseType !== MR2.yardTypes.main && baseType !== MR2.yardTypes.outpost) {
      return null;
    }

    if (Number(cell.mine || 0) === 1) {
      return null;
    }

    const name = String(cell.n || "").trim().toLocaleLowerCase();
    if (!name) {
      return null;
    }

    if (this.highlightNames.enemies.has(name)) {
      return "enemy";
    }

    if (this.highlightNames.allies.has(name)) {
      return "ally";
    }

    return null;
  }

  /**
   * mcGlow's state for this cell.
   *
   * MapRoomPopup.Update() resets `mcGlow.alpha = _over ? 0.5 : 0` every
   * non-dragging pass, then ApplyRangeHighlighting raises in-range cells back
   * to 0.5. The frame picks the artwork:
   *
   *   1 (#68)  idle              - fully transparent, draws nothing
   *   2 (#69)  hovered           - white
   *   3 (#69)  in range          - white (frame 3 has no PlaceObject and
   *                                inherits frame 2's shape)
   *   4 (#70)  in range + hover  - red
   *
   * The bitmaps carry their own alpha (white peaks at 180, red at 255) and
   * the 0.5 multiplies on top, so an in-range cell lands at ~0.353 effective
   * white - the grey wash the feature is known by, not a bright outline.
   */
  getGlowState(cell) {
    // The simplified view has neither: a cell is a few pixels across, a wash
    // over it reads as noise rather than information, and skipping it means
    // the range set is never even computed at the zoom where walking the
    // cache costs the most.
    if (this.zoom < LOD_SIMPLE_ZOOM && !this.forceDetailedExport) {
      return null;
    }
    const key = cellKey(cell.x, cell.y);
    const hovered = key === this.hoveredCellKey;
    const inRange = this.rangeHighlight().has(key);
    if (!hovered && !inRange) {
      return null;
    }
    return {
      asset: hovered && inRange ? MAPROOM_UI.glowRed : MAPROOM_UI.glowWhite,
      alpha: 0.5,
    };
  }

  /** Selection is this viewer's own affordance, not a client state. */
  getHighlightStyle(cell) {
    if (cellKey(cell.x, cell.y) === this.selectedCellKey) {
      return {
        fill: "rgba(255, 255, 255, 0.12)",
        stroke: "rgba(255, 255, 255, 0.78)",
      };
    }
    return null;
  }

  /**
   * Draws mcGlow over the hex top face. The shape is 151x76 and sits at the
   * cell origin, matching the terrain diamond it overlays.
   */
  drawGlow(state, screenX, screenY) {
    const image = this.assets.get(state.asset);
    if (!image) {
      return;
    }
    this.ctx.save();
    this.ctx.globalAlpha = state.alpha;
    this.ctx.drawImage(
      image, screenX, screenY,
      image.width * this.zoom, image.height * this.zoom,
    );
    this.ctx.restore();
  }

  drawHighlight(style, screenX, screenY) {
    this.ctx.save();
    this.ctx.fillStyle = style.fill;
    this.ctx.strokeStyle = style.stroke;
    this.ctx.lineWidth = Math.max(1.6, 2.4 * this.zoom);
    this.ctx.shadowColor = style.stroke;
    this.ctx.shadowBlur = 8 * this.zoom;
    this.traceHexPath(screenX, screenY, CELL_HEX_VERTICES);
    this.ctx.fill();
    this.ctx.stroke();
    this.ctx.restore();
  }

  appendHexPath(screenX, screenY, vertices, targetCtx = this.ctx) {
    vertices.forEach(([x, y], index) => {
      const drawX = screenX + x * this.zoom;
      const drawY = screenY + y * this.zoom;
      if (index === 0) {
        targetCtx.moveTo(drawX, drawY);
      } else {
        targetCtx.lineTo(drawX, drawY);
      }
    });
    targetCtx.closePath();
  }

  traceHexPath(screenX, screenY, vertices) {
    this.ctx.beginPath();
    this.appendHexPath(screenX, screenY, vertices);
  }

  recordHexBoundaryEdges(worldX, worldY, vertices, edges, edgeMap) {
    const worldVertices = vertices.map(([x, y]) => [worldX + x, worldY + y]);

    for (const [startIndex, endIndex] of edges) {
      const [startX, startY] = worldVertices[startIndex];
      const [endX, endY] = worldVertices[endIndex];
      const key = makeEdgeKey(startX, startY, endX, endY);
      const existing = edgeMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        edgeMap.set(key, {
          count: 1,
          ax: startX,
          ay: startY,
          bx: endX,
          by: endY,
        });
      }
    }
  }

  buildBoundaryLoops(edges) {
    const normalizedEdges = edges.map((edge, index) => ({
      ...edge,
      id: index,
      aKey: vertexKey(edge.ax, edge.ay),
      bKey: vertexKey(edge.bx, edge.by),
    }));
    const adjacency = new Map();
    const visited = new Set();
    const loops = [];

    for (const edge of normalizedEdges) {
      if (!adjacency.has(edge.aKey)) {
        adjacency.set(edge.aKey, []);
      }
      if (!adjacency.has(edge.bKey)) {
        adjacency.set(edge.bKey, []);
      }
      adjacency.get(edge.aKey).push(edge);
      adjacency.get(edge.bKey).push(edge);
    }

    for (const edge of normalizedEdges) {
      if (visited.has(edge.id)) {
        continue;
      }

      const startKey = edge.aKey;
      const loop = [parseVertexKey(startKey)];
      let currentKey = edge.bKey;
      let currentEdge = edge;
      let guard = 0;
      visited.add(edge.id);

      while (currentKey !== startKey && guard < normalizedEdges.length + 4) {
        loop.push(parseVertexKey(currentKey));
        const candidates = adjacency.get(currentKey) || [];
        const nextEdge = candidates.find((candidate) => candidate.id !== currentEdge.id && !visited.has(candidate.id));
        if (!nextEdge) {
          break;
        }

        visited.add(nextEdge.id);
        currentKey = nextEdge.aKey === currentKey ? nextEdge.bKey : nextEdge.aKey;
        currentEdge = nextEdge;
        guard += 1;
      }

      if (currentKey === startKey && loop.length >= 3) {
        loops.push(loop);
      }
    }

    return loops;
  }

  traceBoundaryLoops(loops, targetCtx = this.ctx) {
    targetCtx.beginPath();
    for (const loop of loops) {
      this.appendLoopPath(loop, targetCtx);
    }
  }

  appendLoopPath(points, targetCtx = this.ctx) {
    if (points.length < 3) {
      return;
    }

    const screenPoints = points.map((point) => ({
      x: (point.x - this.offsetX) * this.zoom,
      y: (point.y - this.offsetY) * this.zoom,
    }));

    targetCtx.moveTo(screenPoints[0].x, screenPoints[0].y);
    for (let index = 1; index < screenPoints.length; index += 1) {
      const current = screenPoints[index];
      targetCtx.lineTo(current.x, current.y);
    }
    targetCtx.closePath();
  }

  simplifyBoundaryLoop(points) {
    if (points.length < 3) {
      return points;
    }

    const cleaned = [];
    for (const point of points) {
      const previous = cleaned[cleaned.length - 1];
      if (!previous || !samePoint(previous, point)) {
        cleaned.push(point);
      }
    }

    if (cleaned.length < 3) {
      return cleaned;
    }

    const simplified = [];
    const count = cleaned.length;
    for (let index = 0; index < count; index += 1) {
      const previous = cleaned[(index - 1 + count) % count];
      const current = cleaned[index];
      const next = cleaned[(index + 1) % count];

      if (isCollinear(previous, current, next)) {
        continue;
      }

      simplified.push(current);
    }

    return simplified.length >= 3 ? simplified : cleaned;
  }

  // Returns [preferred, fallback] art paths for a cell, mirroring the game
  // client's frame selection: intact / damaged (any damage) / destroyed
  // (>= 90%) variants for mains and outposts, and per-tribe camp art for
  // wild bases. The fallback generic icon is used if bundled art fails to
  // load.
  getIconPathsForCell(cell) {
    const damaged = Number(cell.dm || 0) > 0;
    const destroyed = Number(cell.d || 0) === 1;
    const protectedBase = Number(cell.p || 0) === 1;

    // MapRoomCell's own precedence: protected outranks destroyed, which
    // outranks damaged. A destroyed base under protection shows the grey
    // protected frame, not the rubble - so the map never advertises that
    // someone who cannot currently be attacked is already flattened.
    switch (Number(cell.b)) {
      case MR2.yardTypes.main: {
        const path = protectedBase
          ? ASSET_PATHS.mainProtected
          : destroyed
            ? ASSET_PATHS.mainDestroyed
            : damaged
              ? ASSET_PATHS.mainDamaged
              : ASSET_PATHS.mainBase;
        return [path, ASSET_PATHS.playerBase];
      }
      case MR2.yardTypes.outpost: {
        const path = protectedBase
          ? ASSET_PATHS.outpostProtected
          : destroyed
            ? ASSET_PATHS.outpostDestroyed
            : damaged
              ? ASSET_PATHS.outpostDamaged
              : ASSET_PATHS.outpostBase;
        return [path, ASSET_PATHS.outpost];
      }
      case MR2.yardTypes.wildMonster: {
        const tribeKey = getTribeKey(cell);
        const path = (tribeKey && TRIBE_CELL_ASSETS[tribeKey]) || ASSET_PATHS.wildMonsterBase;
        return [path, ASSET_PATHS.wildMonsterBase];
      }
      default:
        return null;
    }
  }

  getPrimaryIconPath(cell) {
    const paths = this.getIconPathsForCell(cell);
    return paths ? paths[0] : null;
  }

  doesContainDisplayableBase(cell) {
    const baseType = Number(cell.b || 0);
    return (
      baseType === MR2.yardTypes.wildMonster ||
      baseType === MR2.yardTypes.main ||
      baseType === MR2.yardTypes.outpost
    );
  }

  setCoordinatesDisplay(cell) {
    if (!this.coordsEl) {
      return;
    }

    if (!this.interactive || !cell) {
      this.coordsEl.hidden = true;
      return;
    }

    this.coordsEl.hidden = false;
    let text = `Cell ${cell.x}, ${cell.y}`;
    if (this.guestMode) {
      // Guests see cached data only, so surface how stale the hovered
      // zone is (or that it was never cached at all).
      const key = zoneKey(zoneOriginForCell(cell.x), zoneOriginForCell(cell.y));
      const fetchedAt = this.loadedZones.get(key);
      text += fetchedAt
        ? ` - cached ${formatRelativeTime(fetchedAt)}`
        : " - not cached";
    }
    this.coordsEl.textContent = text;
  }

  findGridCellAtPoint(screenX, screenY) {
    const world = this.screenToWorld(screenX, screenY);
    return this.findGridCellAtWorldPoint(world.x, world.y);
  }

  findGridCellAtWorldPoint(worldX, worldY) {
    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();
    // Estimates are in unwrapped grid space (cellToWorld handles negative and
    // out-of-range columns correctly, including odd-column parity); results
    // are wrapped back onto the map.
    const estimatedX = Math.floor(worldX / MR2.columnStep);
    const columnOffset = estimatedX % 2 ? MR2.oddColumnOffset : 0;
    const estimatedY = Math.floor((worldY - columnOffset) / MR2.cellHeight);

    for (let deltaY = -RELIEF_PROBE_ROWS; deltaY <= RELIEF_PROBE_ROWS; deltaY += 1) {
      for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
        const cellX = estimatedX + deltaX;
        const cellY = estimatedY + deltaY;
        const world = this.cellToWorld(cellX, cellY);
        const cached = this.cellCache.get(
          cellKey(positiveModulo(cellX, mapWidth), positiveModulo(cellY, mapHeight)),
        );
        const lift = cached ? this.liftFor(cached) : cellLift(undefined);
        if (pointInHex(worldX, worldY, world.x, world.y + lift, 1)) {
          return { x: positiveModulo(cellX, mapWidth), y: positiveModulo(cellY, mapHeight) };
        }
      }
    }

    return { x: positiveModulo(estimatedX, mapWidth), y: positiveModulo(estimatedY, mapHeight) };
  }

  findCellAtPoint(screenX, screenY) {
    const world = this.screenToWorld(screenX, screenY);
    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();
    const estimatedX = Math.floor(world.x / MR2.columnStep);
    const columnOffset = estimatedX % 2 ? MR2.oddColumnOffset : 0;
    const estimatedY = Math.floor((world.y - columnOffset) / MR2.cellHeight);

    // Relief moves a cell's artwork up to ~52px up (i=188) or ~64px down
    // (i=54) from its flat row, which is most of a 75px row pitch - so the
    // old 3x3 probe could miss the cell the pointer is actually over. Widen
    // the row span to cover the full range.
    const candidates = [];
    for (let deltaY = -RELIEF_PROBE_ROWS; deltaY <= RELIEF_PROBE_ROWS; deltaY += 1) {
      for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
        candidates.push({ x: estimatedX + deltaX, y: estimatedY + deltaY });
      }
    }
    // Cells later in draw order sit on top, so test candidates in reverse of
    // the depth sort used to draw them.
    candidates.sort((left, right) => {
      const a = this.cellToWorld(left.x, left.y);
      const b = this.cellToWorld(right.x, right.y);
      return (b.y - a.y) || (b.x - a.x);
    });

    for (const candidate of candidates) {
      const cell = this.cellCache.get(
        cellKey(positiveModulo(candidate.x, mapWidth), positiveModulo(candidate.y, mapHeight)),
      );
      if (!cell || !this.shouldDisplayBaseCell(cell)) {
        continue;
      }

      const cellWorld = this.cellToWorld(candidate.x, candidate.y);
      // Test against where the cell was DRAWN, not its flat row.
      if (pointInHex(world.x, world.y, cellWorld.x, cellWorld.y + this.liftFor(cell), 1)) {
        return cell;
      }
    }

    return null;
  }
}
