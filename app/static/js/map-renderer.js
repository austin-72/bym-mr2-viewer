import {
  ASSET_PATHS,
  CELL_HEX_EDGES,
  CELL_HEX_VERTICES,
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
  getHexDistance,
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
  total: { label: "Loot", color: "#ffd97a" },
  r1: { label: "Twigs", color: "#e6c98a" },
  r2: { label: "Pebbles", color: "#a9c2d6" },
  r3: { label: "Putty", color: "#e3a6d4" },
  r4: { label: "Goo", color: "#8fd6a0" },
};
const LOOT_RESOURCE_KEYS = ["total", "r1", "r2", "r3", "r4"];
const MIN_ZOOM = 0.08;
// Below this zoom the renderer switches to a simplified level-of-detail:
// terrain as rectangles and bases as markers, so deep zoom-out stays smooth.
const LOD_SIMPLE_ZOOM = 0.16;

// Group color scheme:
//  - allies: bright blue with a green tint (cyan-teal)
//  - enemy mains: bright red; enemy outposts: dark red
//  - neutral player outposts: yellow; own bases: blue
//  - every main yard gets a purple halo outline
const ALLY_STROKE = "rgba(52, 214, 236, 0.95)";
const ALLY_FILL = "rgba(52, 214, 236, 0.16)";
const ENEMY_STROKE = "rgba(255, 92, 74, 0.95)";
const ENEMY_FILL = "rgba(255, 92, 74, 0.14)";
const ENEMY_OUTPOST_STROKE = "rgba(150, 26, 18, 0.95)";
const ENEMY_OUTPOST_FILL = "rgba(150, 26, 18, 0.22)";
const MAIN_OUTLINE_COLOR = "rgba(178, 102, 255, 0.9)";
const MAX_ZOOM = 1.5;
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
const CELL_CACHE_DROP_KEYS = new Set(["m", "mine", "blendedHeight"]);
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
    this.hiddenTileStyle = "blend";
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
    this.lootResource = "total";
    // Players hidden from the map for normal users (moderation). Empty for
    // administrators, who see everything.
    this.hiddenPlayerNames = new Set();
    // Main-yard name labels are collected during the cell pass and drawn
    // last, so they sit on top of every cell, overlay, and highlight.
    this.pendingMainLabels = [];
    this.onViewStateChanged = null;
    this.viewStateSaveTimer = null;
    this.onCellOwnershipChanges = null;
    this.scanState = null;
    this.measureMode = false;
    this.measurePoints = [];
    this.onMeasureUpdated = null;
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
    this.loadedZones.clear();
    this.pendingZones.clear();
    this.zoneQueue = [];
    this.queuedZoneKeys = new Set();
    this.dirtyZoneKeys.clear();
    this.homeCellKey = null;
    this.hoveredCellKey = null;
    this.selectedCellKey = null;
    this.jumpMarker = null;
    this.zoom = DEFAULT_MAP_ZOOM;
    this.setOverlay("Loading cached map...");

    this.centerOnCell(Math.floor(this.getMapWidth() / 2), Math.floor(this.getMapHeight() / 2));
    let restored = false;
    if (this.serverName) {
      restored = await this.restoreExploredCache();
      this.rebuildFreshnessZones();
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
      this.loadedZones.clear();
    }
    this.cancelAnimations();
    this.cancelWorldScan();
    this.token = session.token;
    this.currentUserId = Number(session.user.userid || 0);
    this.mapMeta = session.map;
    this.settleZoneWait();
    this.cellCache.clear();
    this.loadedZones.clear();
    this.pendingZones.clear();
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

    const restoredView = this.restoreViewState(session.viewState);
    if (!restoredView) {
      if (this.homeCellKey) {
        const home = this.getHomeCoordinates();
        this.centerOnCell(home.x, home.y);
      } else {
        this.centerOnCell(Math.floor(this.getMapWidth() / 2), Math.floor(this.getMapHeight() / 2));
      }
    }

    await this.restoreExploredCache();
    this.rebuildFreshnessZones();
    this.render();

    // Cached cells display immediately, but a fresh login always re-fetches
    // the zones in view so the player starts with current data.
    // Stage 1: live-fetch only zones holding the player's own bases and
    // wait for them - that is the data worth blocking the overlay on. The
    // rest of the viewport paints from cache and refreshes in the
    // background: allies first, then by proximity (stage 2/3 fall out of
    // the priority ordering).
    await this.ensureCellsForViewport(true, { waitForCompletion: true, onlyOwn: true });
    this.ensureCellsForViewport(true).catch((error) => {
      console.warn("Background zone refresh failed.", error);
    });

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
    this.measurePoints = [];
    this.token = null;
    this.currentUserId = null;
    this.mapMeta = null;
    this.guestMode = false;
    this.cellCache.clear();
    this.loadedZones.clear();
    this.pendingZones.clear();
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
    if (this.viewStateSaveTimer) {
      window.clearTimeout(this.viewStateSaveTimer);
      this.viewStateSaveTimer = null;
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
      this.baseFilter.tribes.size > 0 ||
      Number(this.baseFilter.levelMin || 0) > 0 ||
      Number(this.baseFilter.levelMax || 0) > 0 ||
      Boolean(this.baseFilter.bigOwners) ||
      Number(this.baseFilter.playerOwnerId || 0) > 0 ||
      Boolean(this.baseFilter.inactiveNames)
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
      return false;
    }

    if (!this.hasActiveBaseFilter()) {
      return true;
    }

    if (this.isAlwaysVisibleOwnedBase(cell)) {
      return true;
    }

    return this.matchesBaseFilter(cell);
  }

  matchesPlayerOwnerFilter(cell) {
    const ownerId = Number(this.baseFilter.playerOwnerId || 0);
    if (ownerId <= 0) {
      return false;
    }

    if (Number(cell.uid || 0) !== ownerId) {
      return false;
    }

    return Number(cell.b) === MR2.yardTypes.main || Number(cell.b) === MR2.yardTypes.outpost;
  }

  matchesBaseFilter(cell) {
    if (Number(this.baseFilter.playerOwnerId || 0) > 0 && !this.matchesPlayerOwnerFilter(cell)) {
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

    const needsMetadata = (
      this.baseFilter.types.size > 0 ||
      this.baseFilter.tribes.size > 0 ||
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

    if (
      this.baseFilter.tribes.size > 0 &&
      (!metadata.tribe || !this.baseFilter.tribes.has(metadata.tribe))
    ) {
      return false;
    }

    const levelMin = Number(this.baseFilter.levelMin || 0);
    const levelMax = Number(this.baseFilter.levelMax || 0);
    if (levelMin > 0 && (metadata.level <= 0 || metadata.level < levelMin)) {
      return false;
    }

    if (levelMax > 0 && (metadata.level <= 0 || metadata.level > levelMax)) {
      return false;
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
    const level = Number(cell.l || 0);
    return { type, tribe, level };
  }

  // Outpost count per player across the explored map - the data behind the
  // "big fish" outpost filter (lowercased name -> count).
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

  setOverlay(message) {
    this.buildOverlayContent();
    this.overlayMessageEl.textContent = message || "";
    this.overlayEl.hidden = !message;
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
    this.offsetY = before.y - localFocusY / this.zoom;
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
      this.offsetY = centerWorldY - height / (2 * this.zoom);
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
    const offsetY = world.y - height / (2 * zoom) + MR2.cellHeight * 0.5;
    return this.getClampedOffset(offsetX, offsetY);
  }

  centerOnCell(cellX, cellY) {
    const centeredOffset = this.getCenteredOffset(cellX, cellY);
    this.offsetX = centeredOffset.x;
    this.offsetY = centeredOffset.y;
  }

  // Converts a /worldmapv2/getarea response ({ x: { y: cell } }) into
  // normalized cells keyed by coordinates.
  mergeZoneResponse(response) {
    const data = response?.data;
    if (!data || typeof data !== "object") {
      return;
    }

    const ownershipChanges = [];

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
        this.noteFreshnessCell(current);

        // Report ownership transitions (captures / losses) for cells we had
        // prior data on. A change means the owner uid differs, which covers
        // wild -> player, player -> wild, and player -> player takeovers.
        if (previous && Number(previous.uid || 0) !== Number(current.uid || 0)) {
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
    if (Array.isArray(zone.cells)) {
      for (const cell of zone.cells) {
        if (cell && Number.isFinite(Number(cell.x)) && Number.isFinite(Number(cell.y))) {
          this.cellCache.set(cellKey(cell.x, cell.y), this.normalizeCell(Number(cell.x), Number(cell.y), cell));
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
      const centerY = this.offsetY + height / (2 * this.zoom);
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

    this.hydrateRemainderInBackground();
    return restoredAny;
  }

  hydrateRemainderInBackground() {
    const serverName = this.serverName;
    const generation = this.zoneFetchGeneration;
    const idle = (fn) => (window.requestIdleCallback
      ? window.requestIdleCallback(fn, { timeout: 500 })
      : window.setTimeout(fn, 16));

    storageGetServerMap(serverName).then((payload) => {
      const zones = Array.isArray(payload?.zones) ? payload.zones : [];
      let index = 0;
      const slice = () => {
        if (this.zoneFetchGeneration !== generation || this.serverName !== serverName) {
          return; // world switched away mid-hydration
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
        }
      };
      idle(slice);
    }).catch((error) => {
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

    this.scheduleViewStateSave();
  }

  // Debounced notification so the app can persist the camera position.
  scheduleViewStateSave() {
    if (typeof this.onViewStateChanged !== "function") {
      return;
    }

    if (this.viewStateSaveTimer) {
      window.clearTimeout(this.viewStateSaveTimer);
    }

    this.viewStateSaveTimer = window.setTimeout(() => {
      this.viewStateSaveTimer = null;
      if (!this.token) {
        return;
      }

      const center = this.getCenterCell();
      this.onViewStateChanged({ x: center.x, y: center.y, zoom: this.zoom });
    }, 700);
  }

  restoreViewState(viewState) {
    if (!viewState) {
      return false;
    }

    const x = Number(viewState.x);
    const y = Number(viewState.y);
    const zoom = Number(viewState.zoom);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return false;
    }

    if (Number.isFinite(zoom) && zoom > 0) {
      this.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    }

    this.centerOnCell(
      clamp(Math.round(x), 0, this.getMapWidth() - 1),
      clamp(Math.round(y), 0, this.getMapHeight() - 1),
    );
    return true;
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
    const maxWorldY = this.offsetY + height / this.zoom;

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
    const worldY = this.offsetY + height / (2 * this.zoom);
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
    }
  }

  handlePointerUp(event) {
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
    this.offsetY = this.pinchState.world.y - center.y / this.zoom;
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
          // Priority 50: a maintenance scan must never crowd out anybody's
          // live map traffic on the shared budget.
          const response = await this.api.getArea(this.token, zone.x, zone.y, this.zoneScope(), 50);
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
        this.cellCache.set(cKey, current);
        if (previous && Number(previous.uid || 0) !== Number(current.uid || 0)) {
          ownershipChanges.push({ x, y, previous, current });
        }
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
  // Measure tool: two clicks pick endpoints; distance uses the same
  // wrap-aware odd-q metric as the game.
  // ------------------------------------------------------------------
  setMeasureMode(enabled) {
    this.measureMode = Boolean(enabled);
    if (!this.measureMode) {
      this.measurePoints = [];
      this.notifyMeasureUpdated();
    }
    this.render();
  }

  handleMeasureClick(gridCell) {
    if (!gridCell) {
      return;
    }

    if (this.measurePoints.length >= 2) {
      this.measurePoints = [];
    }
    this.measurePoints.push({ x: gridCell.x, y: gridCell.y });
    this.notifyMeasureUpdated();
    this.render();
  }

  notifyMeasureUpdated() {
    if (typeof this.onMeasureUpdated !== "function") {
      return;
    }

    const [a, b] = this.measurePoints;
    this.onMeasureUpdated({
      a: a || null,
      b: b || null,
      distance: a && b ? this.getWrappedHexDistance(a.x, a.y, b.x, b.y) : null,
    });
  }

  drawMeasureOverlay() {
    if (!this.measureMode || !this.measurePoints.length) {
      return;
    }

    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    let anchorX = this.offsetX + width / (2 * this.zoom);
    let anchorY = this.offsetY + height / (2 * this.zoom);
    const points = this.measurePoints.map((point) => {
      const world = this.cellToWorld(point.x, point.y);
      const worldX = this.nearestWrappedValue(world.x + MR2.cellWidth / 2, anchorX, this.getWorldPeriodX());
      const worldY = this.nearestWrappedValue(world.y + MR2.cellHeight / 2, anchorY, this.getWorldPeriodY());
      anchorX = worldX;
      anchorY = worldY;
      return {
        x: (worldX - this.offsetX) * this.zoom,
        y: (worldY - this.offsetY) * this.zoom,
      };
    });

    this.ctx.save();
    this.ctx.strokeStyle = "rgba(255, 170, 60, 0.95)";
    this.ctx.fillStyle = "rgba(255, 170, 60, 0.95)";
    this.ctx.lineWidth = Math.max(2, 2.6 * this.zoom);
    this.ctx.setLineDash([8 * this.zoom, 5 * this.zoom]);

    for (const point of points) {
      this.ctx.beginPath();
      this.ctx.arc(point.x, point.y, Math.max(4, 6 * this.zoom), 0, Math.PI * 2);
      this.ctx.fill();
    }

    if (points.length === 2) {
      this.ctx.beginPath();
      this.ctx.moveTo(points[0].x, points[0].y);
      this.ctx.lineTo(points[1].x, points[1].y);
      this.ctx.stroke();

      const [a, b] = this.measurePoints;
      const label = `${this.getWrappedHexDistance(a.x, a.y, b.x, b.y)} cells`;
      const midX = (points[0].x + points[1].x) / 2;
      const midY = (points[0].y + points[1].y) / 2 - 10;
      this.ctx.setLineDash([]);
      this.ctx.font = `bold ${Math.max(12, 13 * this.zoom)}px Verdana, Geneva, 'DejaVu Sans', Tahoma, sans-serif`;
      this.ctx.textAlign = "center";
      this.ctx.lineWidth = 4;
      this.ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
      this.ctx.strokeText(label, midX, midY);
      this.ctx.fillStyle = "#ffd9a0";
      this.ctx.fillText(label, midX, midY);
    }

    this.ctx.restore();
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

  screenToWorld(screenX, screenY) {
    return {
      x: this.offsetX + screenX / this.zoom,
      y: this.offsetY + screenY / this.zoom,
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
      const centerWorldY = this.offsetY + previousHeight / (2 * this.zoom);
      this.offsetX = centerWorldX - width / (2 * this.zoom);
      this.offsetY = centerWorldY - height / (2 * this.zoom);
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
    const visibleCells = this.getVisibleCells(width, height);

    this.pendingMainLabels.length = 0;
    if (this.guestMode) {
      this.drawUncachedZones(width, height);
    }
    this.drawTerrainBatched(visibleCells);
    this.drawOwnedRangeOverlays(width, height);

    visibleCells.sort((left, right) => (left.cellY - right.cellY) || (left.cellX - right.cellX));
    for (const entry of visibleCells) {
      this.drawCellContents(entry);
    }

    this.drawJumpMarker();
    this.drawMeasureOverlay();
    this.drawPendingMainLabels();
  }

  // Ally mains get a label shadow in the ally color, enemy mains in enemy
  // red; everyone else keeps the default black shadow.
  getMainLabelStrokeColor(cell) {
    const role = this.getPlayerHighlightColor(cell);
    if (role === "ally") {
      return ALLY_STROKE;
    }
    if (role === "enemy") {
      return ENEMY_STROKE;
    }
    return "rgba(0, 0, 0, 0.7)";
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
      this.offsetY + height / (2 * this.zoom),
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

    if (this.zoom < LOD_SIMPLE_ZOOM) {
      // Simplified terrain: one rectangle per cell, batched per band. The hex
      // silhouette is invisible at this scale and rects are far cheaper.
      for (const bucket of byBand.values()) {
        this.ctx.fillStyle = bucket.band.fill;
        for (const entry of bucket.cells) {
          const world = this.cellToWorld(entry.cellX, entry.cellY);
          this.ctx.fillRect(
            (world.x - this.offsetX) * this.zoom,
            (world.y - this.offsetY) * this.zoom,
            MR2.cellWidth * this.zoom + 1,
            MR2.cellHeight * this.zoom + 1,
          );
        }
      }
      return;
    }

    for (const bucket of byBand.values()) {
      this.ctx.beginPath();
      for (const entry of bucket.cells) {
        const world = this.cellToWorld(entry.cellX, entry.cellY);
        const screenX = (world.x - this.offsetX) * this.zoom;
        const screenY = (world.y - this.offsetY) * this.zoom;
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

  // Flinger range outlines for the signed-in player's own bases.
  // Range rules come from BUILDING5.getFlingerRange; iteration mirrors
  // MapRoomPopup.GetCellsInRange (odd-q offset -> axial -> cube ring).
  drawOwnedRangeOverlays(width, height) {
    const sources = [];
    for (const cell of this.cellCache.values()) {
      if (Number(cell.mine || 0) !== 1) {
        continue;
      }

      const range = getFlingerRange(cell.f, Number(cell.b) === MR2.yardTypes.main);
      if (range <= 0 || !this.doesContainDisplayableBase(cell)) {
        continue;
      }

      sources.push({ x: cell.x, y: cell.y, range });
    }

    if (!sources.length) {
      return;
    }

    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();
    const marginX = MR2.cellWidth * 2;
    const marginY = MR2.cellHeight * 2;
    const minWorldX = this.offsetX - marginX;
    const maxWorldX = this.offsetX + width / this.zoom + marginX;
    const minWorldY = this.offsetY - marginY;
    const maxWorldY = this.offsetY + height / this.zoom + marginY;
    const rangeCells = new Map();

    for (const source of sources) {
      const [startQ, startR] = offsetToCube(source.x, source.y);

      for (let deltaQ = -source.range; deltaQ <= source.range; deltaQ += 1) {
        const minDeltaR = Math.max(-source.range, -deltaQ - source.range);
        const maxDeltaR = Math.min(source.range, -deltaQ + source.range);
        for (let deltaR = minDeltaR; deltaR <= maxDeltaR; deltaR += 1) {
          const offset = cubeToOffset(startQ + deltaQ, startR + deltaR);
          const cellX = positiveModulo(offset.x, mapWidth);
          const cellY = positiveModulo(offset.y, mapHeight);

          const cached = this.cellCache.get(cellKey(cellX, cellY));
          if (cached && Number(cached.i || 0) <= MR2.waterMaxHeight && Number(cached.b || 0) <= 0) {
            continue;
          }

          // A range region can straddle the wrap seam, so consider every wrap
          // copy of the cell and keep those intersecting the viewport. Cells
          // adjacent across the seam land at adjacent unwrapped positions, so
          // shared edges still cancel and the outline stays continuous.
          const base = this.cellToWorld(cellX, cellY);
          for (const shiftX of [-this.getWorldPeriodX(), 0, this.getWorldPeriodX()]) {
            for (const shiftY of [-this.getWorldPeriodY(), 0, this.getWorldPeriodY()]) {
              const worldX = base.x + shiftX;
              const worldY = base.y + shiftY;
              if (
                worldX > maxWorldX ||
                worldX + MR2.cellWidth < minWorldX ||
                worldY > maxWorldY ||
                worldY + MR2.cellHeight < minWorldY
              ) {
                continue;
              }

              rangeCells.set(`${cellX},${cellY},${shiftX},${shiftY}`, { worldX, worldY });
            }
          }
        }
      }
    }

    if (!rangeCells.size) {
      return;
    }

    const boundaryEdges = new Map();
    for (const entry of rangeCells.values()) {
      this.recordHexBoundaryEdges(entry.worldX, entry.worldY, CELL_HEX_VERTICES, CELL_HEX_EDGES, boundaryEdges);
    }

    const rawLoops = this.buildBoundaryLoops([...boundaryEdges.values()].filter((edge) => edge.count === 1))
      .map((loop) => this.simplifyBoundaryLoop(loop))
      .filter((loop) => loop.length >= 3);
    if (!rawLoops.length) {
      return;
    }

    this.ctx.save();
    this.ctx.fillStyle = "rgba(102, 178, 255, 0.18)";
    this.traceBoundaryLoops(rawLoops);
    this.ctx.fill("evenodd");
    this.ctx.restore();

    this.ctx.save();
    this.ctx.strokeStyle = "rgba(176, 236, 255, 0.72)";
    this.ctx.lineWidth = clamp(3 * this.zoom, 1.8, 3.8);
    this.ctx.lineJoin = "round";
    this.ctx.lineCap = "round";
    this.ctx.shadowColor = "rgba(156, 220, 255, 0.26)";
    this.ctx.shadowBlur = clamp(3 * this.zoom, 2, 4);
    this.traceBoundaryLoops(rawLoops);
    this.ctx.stroke();
    this.ctx.restore();
  }

  drawCellContents({ cell, cellX, cellY }) {
    const world = this.cellToWorld(cellX, cellY);
    const screenX = (world.x - this.offsetX) * this.zoom;
    const screenY = (world.y - this.offsetY) * this.zoom;

    if (!this.shouldDisplayBaseCell(cell)) {
      return;
    }

    if (this.zoom < LOD_SIMPLE_ZOOM) {
      this.drawSimpleBaseMarker(cell, screenX, screenY);
      return;
    }

    if (Number(cell.b) === MR2.yardTypes.main) {
      this.drawMainOutline(screenX, screenY);
    }

    const highlightStyle = this.getHighlightStyle(cell);
    if (highlightStyle) {
      this.drawHighlight(highlightStyle, screenX, screenY);
    }

    const playerHighlight = this.getPlayerHighlightColor(cell);
    if (playerHighlight) {
      this.drawPlayerHighlight(cell, playerHighlight, screenX, screenY);
    } else {
      this.drawOwnershipOverlay(cell, screenX, screenY);
    }

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

    if (Number(cell.p || 0) === 1) {
      this.drawCenteredIcon(ASSET_PATHS.damageProtection, screenX, screenY);
    }

    if (Number(cell.dm || 0) > 0) {
      this.drawDamageBar(cell, screenX, screenY);
    }

    const isMainYard = Number(cell.b) === MR2.yardTypes.main;

    if (isMainYard) {
      // Main yard names stay visible at every zoom level and are drawn on
      // top of everything after the cell pass completes.
      this.pendingMainLabels.push({
        cell,
        screenX,
        screenY,
        stroke: this.getMainLabelStrokeColor(cell),
      });
    } else if (this.zoom >= LABEL_RENDER_ZOOM_MIN) {
      this.drawLabel(cell, screenX, screenY);
    }

    if (this.showLoot && this.zoom >= LABEL_RENDER_ZOOM_MIN) {
      this.drawLootLabel(cell, screenX, screenY);
    }
  }

  // Purple halo drawn around every main yard, underneath any group
  // highlight stroke so both remain visible.
  drawMainOutline(screenX, screenY) {
    this.ctx.save();
    this.ctx.strokeStyle = MAIN_OUTLINE_COLOR;
    this.ctx.lineWidth = Math.max(4, 6.5 * this.zoom);
    this.ctx.lineJoin = "round";
    this.traceHexPath(screenX, screenY, CELL_HEX_VERTICES);
    this.ctx.stroke();
    this.ctx.restore();
  }

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

    const size = Math.max(2.5, MR2.cellWidth * this.zoom * 0.42);
    const markerX = screenX + (MR2.cellWidth * this.zoom - size) / 2;
    const markerY = screenY + (MR2.cellHeight * this.zoom - size) / 2;

    if (isMainYard) {
      this.ctx.strokeStyle = MAIN_OUTLINE_COLOR;
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(markerX - 2, markerY - 2, size + 4, size + 4);
    }

    this.ctx.fillStyle = color;
    this.ctx.fillRect(markerX, markerY, size, size);

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

  drawLootLabel(cell, screenX, screenY) {
    const style = LOOT_RESOURCE_STYLES[this.lootResource] || LOOT_RESOURCE_STYLES.total;
    const loot = this.lootResource === "total"
      ? getCellLootTotal(cell)
      : (Number(cell?.r?.[this.lootResource]) || 0);
    if (loot <= 0) {
      return;
    }

    const text = formatCompactNumber(loot);
    const fontSize = Math.max(9, Math.round(13 * this.zoom));
    // Centred on the yard/outpost rather than hanging below it: the pill is
    // about that cell, and below the tile it collided with the owner label
    // and read as belonging to whatever sat underneath.
    const centerX = screenX + (MR2.cellWidth * this.zoom) / 2;
    const textY = screenY + (MR2.cellHeight * this.zoom) / 2;

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
    this.ctx.fillStyle = style.color;
    this.ctx.fillText(text, centerX, textY);
    this.ctx.restore();
  }

  drawPlayerHighlight(cell, role, screenX, screenY) {
    const isEnemy = role === "enemy";
    const isOutpost = Number(cell.b) === MR2.yardTypes.outpost;
    const overlayPath = isEnemy ? ASSET_PATHS.overlayRed : ASSET_PATHS.overlayBlue;
    const image = this.assets.get(overlayPath);
    if (image) {
      this.ctx.drawImage(image, screenX, screenY, MR2.cellWidth * this.zoom, MR2.cellHeight * this.zoom);
    }

    const stroke = isEnemy ? (isOutpost ? ENEMY_OUTPOST_STROKE : ENEMY_STROKE) : ALLY_STROKE;
    const fill = isEnemy ? (isOutpost ? ENEMY_OUTPOST_FILL : ENEMY_FILL) : ALLY_FILL;
    this.ctx.save();
    this.ctx.fillStyle = fill;
    this.ctx.strokeStyle = stroke;
    this.ctx.lineWidth = Math.max(2, 3 * this.zoom);
    this.ctx.lineJoin = "round";
    this.traceHexPath(screenX, screenY, CELL_HEX_VERTICES);
    this.ctx.fill();
    this.ctx.stroke();
    this.ctx.restore();
  }

  drawOwnershipOverlay(cell, screenX, screenY) {
    let overlayPath = null;
    if (Number(cell.mine || 0) === 1) {
      overlayPath = ASSET_PATHS.overlayBlue;
    } else if (Number(cell.t || 0) > Math.floor(Date.now() / 1000)) {
      // Active truce with this player.
      overlayPath = ASSET_PATHS.overlayGreen;
    } else if (Number(cell.d || 0) === 1) {
      overlayPath = ASSET_PATHS.overlayRed;
    } else if (Number(cell.b) === MR2.yardTypes.outpost) {
      // Default (neutral) player outposts are marked yellow.
      overlayPath = ASSET_PATHS.overlayYellow;
    }

    if (!overlayPath) {
      return;
    }

    const image = this.assets.get(overlayPath);
    if (!image) {
      return;
    }

    this.ctx.drawImage(
      image,
      screenX,
      screenY,
      MR2.cellWidth * this.zoom,
      MR2.cellHeight * this.zoom,
    );
  }

  // Draws base art centered on the cell, scaled down (never up) to fit the
  // hex footprint while preserving aspect ratio; tall art may overhang the
  // top like in the original game.
  drawCellArt(paths, screenX, screenY) {
    let image = null;
    for (const path of paths) {
      image = this.assets.get(path);
      if (image) {
        break;
      }
    }
    if (!image) {
      return;
    }

    const maxWidth = MR2.cellWidth;
    const maxHeight = 112;
    const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    const drawX = screenX + (MR2.cellWidth - width) * 0.5 * this.zoom;
    const drawY = screenY + (MR2.cellHeight - height) * 0.5 * this.zoom;
    this.ctx.drawImage(image, drawX, drawY, width * this.zoom, height * this.zoom);
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

  drawDamageBar(cell, screenX, screenY) {
    const sprite = this.assets.get(ASSET_PATHS.damageBar);
    if (!sprite) {
      return;
    }

    const damage = clamp(Number(cell.dm || 0) / 100, 0, 0.99);
    const segmentHeight = 4;
    const segmentCount = Math.floor(sprite.height / segmentHeight);
    const segmentIndex = Math.min(Math.floor(segmentCount * damage), segmentCount - 1);
    const sourceY = segmentIndex * segmentHeight;
    const drawX = screenX + (MR2.cellWidth - sprite.width) * 0.5 * this.zoom;
    const drawY = screenY + (MR2.cellHeight - segmentHeight) * 0.5 * this.zoom;

    this.ctx.drawImage(
      sprite,
      0,
      sourceY,
      sprite.width,
      segmentHeight,
      drawX,
      drawY,
      sprite.width * this.zoom,
      segmentHeight * this.zoom,
    );
  }

  drawLabel(cell, screenX, screenY, strokeStyle = "rgba(0, 0, 0, 0.7)") {
    const name = String(cell.n || "").trim();
    if (!name) {
      return;
    }

    const label = `${name} (${Number(cell.l || 0)})`;
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
    this.render();
  }

  // True when the cell belongs to a moderation-hidden player.
  // Display height for terrain: hidden players' cells blend into their
  // surroundings by averaging the plain-terrain neighbours instead of using
  // the tile's true (elevated) base height, which would paint a lone grey
  // mountain hex marking the hidden base. Memoized per cell object; merges
  // replace the object, which naturally invalidates it.
  terrainHeightFor(cell) {
    if (!this.isCellHidden(cell)) {
      return cell.i;
    }
    if (this.hiddenTileStyle === "water") {
      return 60; // water1 band - mirrors the server's HIDDEN_WATER_HEIGHT
    }
    if (cell.blendedHeight !== undefined) {
      return cell.blendedHeight;
    }
    let sum = 0;
    let count = 0;
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dy = -2; dy <= 2; dy += 1) {
        if (!dx && !dy) {
          continue;
        }
        const neighbor = this.cellCache.get(cellKey(cell.x + dx, cell.y + dy));
        if (
          neighbor &&
          !this.isCellHidden(neighbor) &&
          Number(neighbor.uid || 0) === 0 &&
          (neighbor.b === null || neighbor.b === undefined) &&
          Number(neighbor.i || 0) > 0
        ) {
          sum += Number(neighbor.i);
          count += 1;
        }
      }
    }
    const blended = count
      ? Math.round(sum / count)
      : Math.min(Number(cell.i || 0) || 120, 140);
    cell.blendedHeight = blended;
    return blended;
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

  getHighlightStyle(cell) {
    const key = cellKey(cell.x, cell.y);
    if (key === this.selectedCellKey) {
      return {
        fill: "rgba(255, 255, 255, 0.12)",
        stroke: "rgba(255, 255, 255, 0.78)",
      };
    }

    if (key === this.hoveredCellKey) {
      return {
        fill: "rgba(255, 255, 255, 0.08)",
        stroke: "rgba(255, 255, 255, 0.42)",
      };
    }

    return null;
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

    switch (Number(cell.b)) {
      case MR2.yardTypes.main: {
        const path = destroyed
          ? ASSET_PATHS.mainDestroyed
          : damaged
            ? ASSET_PATHS.mainDamaged
            : ASSET_PATHS.mainBase;
        return [path, ASSET_PATHS.playerBase];
      }
      case MR2.yardTypes.outpost: {
        const path = destroyed
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

    for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
      for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
        const cellX = estimatedX + deltaX;
        const cellY = estimatedY + deltaY;
        const world = this.cellToWorld(cellX, cellY);
        if (pointInHex(worldX, worldY, world.x, world.y, 1)) {
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

    // Cells later in draw order sit on top, so test candidates in reverse.
    const candidates = [];
    for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
      for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
        candidates.push({ x: estimatedX + deltaX, y: estimatedY + deltaY });
      }
    }
    candidates.sort((left, right) => (right.y - left.y) || (right.x - left.x));

    for (const candidate of candidates) {
      const cell = this.cellCache.get(
        cellKey(positiveModulo(candidate.x, mapWidth), positiveModulo(candidate.y, mapHeight)),
      );
      if (!cell || !this.shouldDisplayBaseCell(cell)) {
        continue;
      }

      const cellWorld = this.cellToWorld(candidate.x, candidate.y);
      if (pointInHex(world.x, world.y, cellWorld.x, cellWorld.y, 1)) {
        return cell;
      }
    }

    return null;
  }
}
