export const TOKEN_STORAGE_KEY = "bym-mr2-viewer-token";
// Device-local preferences (sidebar state, selected leaderboard world, watch
// toggle) stay in localStorage. Everything user-specific (highlights,
// bookmarks, filters, camera, watch history) lives on the viewer server in
// users/{username}/settings.json; the explored map cache is shared between
// all users in server_{servername}/ on the viewer server.
export const UI_PREFS_STORAGE_KEY = "bym-mr2-viewer-ui-prefs";
export const SEARCH_RESULT_LIMIT = 100;
export const DEFAULT_VIEWER_CONFIG = Object.freeze({
  bymBaseUrl: "http://localhost:3001",
  cdnBaseUrl: "http://localhost:3001",
  apiVersion: "v1.6.8-beta",
});
export const STABLE_VIEWER_CONFIG = Object.freeze({
  bymBaseUrl: "https://server.bymrefitted.com",
  cdnBaseUrl: "https://cdn.bymrefitted.com",
  apiVersion: DEFAULT_VIEWER_CONFIG.apiVersion,
});

// All game-API calls are routed through the viewer backend (same origin) under
// this prefix; dev_server.py forwards them to the configured BYM server. This
// avoids browser CORS/Cloudflare issues and keeps the upstream server-side.
// Only CDN assets (cdnBaseUrl) still go direct to the CDN.
export const API_PROXY_PREFIX = "/proxy";

// Map Room 2 grid constants, taken from the original game client
// (com/monsters/maproom_advanced). MR2 uses 150x75 hex cells laid out in an
// "odd-q" column-staggered grid: columns are 112.5px apart (cellWidth * 0.75)
// and odd columns are shifted down by half a cell.
export const MR2 = {
  mapWidth: 800,
  mapHeight: 800,
  cellWidth: 150,
  cellHeight: 75,
  columnStep: 112.5,
  oddColumnOffset: 37.5,
  zoneSize: 10,
  // Loaded zones are considered fresh for an hour; within that window they
  // are never refetched during normal browsing. The manual Refresh button
  // still forces a refetch of the visible area.
  // Tiered zone freshness: how old a zone may be before a refetch is
  // allowed, by its relationship to the player's own and allied bases.
  // Distances are Chebyshev, in zones, wrap-aware, measured from zones
  // holding the player's OWN bases/outposts.
  zoneFreshness: {
    ownAllyMs: 5 * 60 * 1000,        // zone holds own or allied bases
    ring2Ms: 60 * 60 * 1000,         // within 2 zones of an own-base zone
    ring4Ms: 4 * 60 * 60 * 1000,     // within 4 zones
    farMs: 24 * 60 * 60 * 1000,      // everything else
  },
  zoneFetchConcurrency: 4,
  // Shared client-side pacing across viewport loading, world scans, and
  // watchlist refreshes. ~10 req/s puts a full 6,400-zone world scan at
  // roughly 11 minutes without hammering the server.
  // Client-side pacing default; adopted from the server's admin-configured
  // limit at sign-in. The server enforces the real ceiling either way.
  zoneRequestsPerMinute: 30,
  zoneRequestWindowMs: 60_000,
  // A queued zone fetch that could not get budget for this long is dropped;
  // the next viewport pass re-queues it if it is still worth having.
  fetchGiveUpMs: 10 * 60 * 1000,
  scanConcurrency: 4,
  scanPersistEveryZones: 200,
  scanRenderEveryZones: 15,
  // One quick burst per HOUR, not a rolling 2-minute cycle: constant zone
  // fetches kept the player's session "active", so the game never marked
  // them offline and their main base could not be attacked. An hourly burst
  // finishes in seconds; the game flags the player offline again ~5 minutes
  // later, leaving them attackable for the other ~55 minutes.
  watchRefreshIntervalMs: 60 * 60 * 1000,
  // Cached checks hit only the viewer's own shared cache - zero game API
  // traffic, so they cannot make the player look online. They pick up
  // whatever other members' viewers observed, every 10 minutes.
  watchCachedIntervalMs: 10 * 60 * 1000,
  // Per-burst budget. At one burst per hour this is tiny API traffic and
  // comfortably covers a large alliance's zones; the global rate gate paces
  // the burst itself.
  watchMaxZonesPerCycle: 60,
  watchEventListLimit: 50,
  waterMaxHeight: 99,
  yardTypes: {
    wildMonster: 1,
    main: 2,
    outpost: 3,
  },
  terrain: {
    water1: 80,
    water2: 90,
    water3: 99,
    sand1: 105,
    sand2: 110,
    land1: 120,
    land2: 140,
    land3: 160,
    land4: 170,
    land5: 175,
  },
};

// A full-cell hexagon that tiles exactly across the 112.5 x 75 odd-q grid so
// shared edges cancel when tracing range boundaries.
export const CELL_HEX_VERTICES = [
  [37.5, 0],
  [112.5, 0],
  [150, 37.5],
  [112.5, 75],
  [37.5, 75],
  [0, 37.5],
];

export const CELL_HEX_EDGES = CELL_HEX_VERTICES.map((_, index) => [
  index,
  (index + 1) % CELL_HEX_VERTICES.length,
]);

// Terrain colors per height band (bands from MapRoomCell.Update in the
// original client). Each entry is [minHeightInclusive, fill, edge].
export const TERRAIN_BANDS = [
  { max: 80, key: "water1", fill: "#123c49", edge: "#0e313c" },
  { max: 90, key: "water2", fill: "#175062", edge: "#123f4e" },
  { max: 100, key: "water3", fill: "#1e6478", edge: "#174e5e" },
  { max: 105, key: "sand1", fill: "#c9b377", edge: "#a6935f" },
  { max: 110, key: "sand2", fill: "#bda667", edge: "#9b8852" },
  { max: 120, key: "land1", fill: "#86ab58", edge: "#6d8c47" },
  { max: 140, key: "land2", fill: "#75a04d", edge: "#5e8340" },
  { max: 160, key: "land3", fill: "#659344", edge: "#527838" },
  { max: 170, key: "land4", fill: "#568539", edge: "#456c2f" },
  { max: 175, key: "land5", fill: "#8d8878", edge: "#736f60" },
  { max: Infinity, key: "land6", fill: "#7a7563", edge: "#615d4e" },
];

export function getTerrainBand(height) {
  const normalizedHeight = Number(height || 0);
  for (const band of TERRAIN_BANDS) {
    if (normalizedHeight < band.max) {
      return band;
    }
  }

  return TERRAIN_BANDS[TERRAIN_BANDS.length - 1];
}

// Paths starting with "/" are served by the viewer itself (bundled art,
// extracted from the original game client); all other paths are fetched from
// the BYM server's asset CDN.
export const ASSET_PATHS = {
  background: "worldmap/background.jpg",
  damageBar: "worldmap/cell_health_bar.png",
  overlayBlue: "worldmap/overlays/glow_blue.png",
  overlayGreen: "worldmap/overlays/glow_green.png",
  overlayRed: "worldmap/overlays/glow_red.png",
  overlayYellow: "worldmap/overlays/glow_yellow.png",
  playerBase: "worldmap/icons/player_base.png",
  outpost: "worldmap/icons/resource_cell.png",
  wildMonsterBase: "worldmap/icons/wild_monster_base_v2.png",
  damageProtection: "worldmap/icons/damage_protection.png",
  // Original Map Room 2 cell art (intact / damaged / destroyed), matching the
  // game client's main, main-damaged, main-destroyed frame set.
  mainBase: "/assets/cells/main.png",
  mainDamaged: "/assets/cells/main-damaged.png",
  mainDestroyed: "/assets/cells/main-destroyed.png",
  outpostBase: "/assets/cells/outpost.png",
  outpostDamaged: "/assets/cells/outpost-damaged.png",
  outpostDestroyed: "/assets/cells/outpost-destroyed.png",
};

// Per-tribe camp art for wild monster bases, keyed by getTribeKey() values.
export const TRIBE_CELL_ASSETS = {
  kozu: "/assets/cells/tribe-kozu.png",
  legionnaire: "/assets/cells/tribe-legionnaire.png",
  abunakki: "/assets/cells/tribe-abunakki.png",
  dreadnaut: "/assets/cells/tribe-dreadnaut.png",
};

export const TYPE_FILTER_OPTIONS = [
  { key: "wild", label: "Wild monster tribe" },
  { key: "main", label: "Player main yard" },
  { key: "outpost", label: "Player outpost" },
];

export const TRIBE_FILTER_OPTIONS = [
  { key: "kozu", label: "Kozu" },
  { key: "legionnaire", label: "Legionnaire" },
  { key: "abunakki", label: "Abunakki" },
  { key: "dreadnaut", label: "Dreadnaut" },
];

export function debugLog(...args) {
  console.info("[BYM-MR2]", ...args);
}

export async function fetchJson(url, options = {}) {
  const method = options?.method || "GET";
  debugLog(`-> ${method} ${url}`);

  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    console.error(`[BYM-MR2] Network failure for ${method} ${url}:`, error);
    throw new Error(error?.message ? `Unable to reach BYM server: ${error.message}` : "Unable to reach BYM server.");
  }

  const rawBody = await response.text();
  const payload = parseJsonPayload(rawBody);

  if (!response.ok) {
    const message = extractErrorMessage(payload) || response.statusText || "Request failed";
    // Many BYM errors carry an `errorDetails` object explaining *why* (e.g. an
    // expired/invalid session, a missing scope). Serialize it inline so it is
    // visible in the log rather than collapsed as "{…}".
    let detailText = "";
    const details = payload && typeof payload === "object" ? payload.errorDetails : null;
    if (details && typeof details === "object") {
      try { detailText = ` details=${JSON.stringify(details)}`; } catch { detailText = ""; }
    } else if (details) {
      detailText = ` details=${String(details)}`;
    }
    console.error(`[BYM-MR2] <- ${response.status} ${method} ${url}: ${message}${detailText}`, payload);
    // Carry the HTTP status (and payload) on the error so callers can tell an
    // expired/rotated session (401/403) from a genuine failure and recover.
    const failure = new Error(message);
    failure.status = response.status;
    failure.payload = payload;
    // Budget 429s from the viewer server carry a Retry-After estimate;
    // surface it so zone fetches can reschedule instead of just dropping.
    const retryAfter = Number(response.headers.get("Retry-After"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      failure.retryAfter = retryAfter;
    }
    throw failure;
  }

  debugLog(`<- ${response.status} ${method} ${url}`);
  return payload;
}

export function getViewerConfig() {
  if (getViewerConfig.cached) {
    return getViewerConfig.cached;
  }

  getViewerConfig.cached = getLocalViewerConfig();

  return getViewerConfig.cached;
}

export function setViewerConfig(config) {
  getViewerConfig.cached = normalizeViewerConfig(config);
  return getViewerConfig.cached;
}

export function getLocalViewerConfig() {
  const runtimeConfig =
    typeof window !== "undefined" && typeof window.BYM_MR_VIEWER_CONFIG === "object"
      ? window.BYM_MR_VIEWER_CONFIG
      : {};

  return normalizeViewerConfig({
    bymBaseUrl: runtimeConfig.bymBaseUrl || DEFAULT_VIEWER_CONFIG.bymBaseUrl,
    cdnBaseUrl: runtimeConfig.cdnBaseUrl || runtimeConfig.bymBaseUrl || DEFAULT_VIEWER_CONFIG.cdnBaseUrl,
    apiVersion: runtimeConfig.apiVersion || DEFAULT_VIEWER_CONFIG.apiVersion,
  });
}

export function normalizeViewerConfig(config) {
  return {
    bymBaseUrl: normalizeBaseUrl(config?.bymBaseUrl || DEFAULT_VIEWER_CONFIG.bymBaseUrl),
    cdnBaseUrl: normalizeBaseUrl(
      config?.cdnBaseUrl || config?.bymBaseUrl || DEFAULT_VIEWER_CONFIG.cdnBaseUrl,
    ),
    apiVersion: normalizeApiVersion(config?.apiVersion || DEFAULT_VIEWER_CONFIG.apiVersion),
  };
}

export function buildBymUrl(path, query = null) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  // Same-origin relative URL: the viewer backend proxies /proxy/* to the
  // configured BYM server. The old per-config bymBaseUrl is no longer used for
  // API URLs (it still namespaces the stored token and shared cache); the
  // backend decides the upstream target.
  let url = `${API_PROXY_PREFIX}${normalizedPath}`;

  if (query && typeof query === "object") {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, String(value));
      }
    });
    const qs = params.toString();
    if (qs) {
      url += `?${qs}`;
    }
  }

  return url;
}

export function buildSessionPayload(loginResponse, baseData) {
  const basePayload = baseData && typeof baseData === "object" ? baseData : {};

  const worldSize = Array.isArray(basePayload.worldsize) && basePayload.worldsize.length === 2
    ? basePayload.worldsize.map(Number)
    : [MR2.mapHeight, MR2.mapWidth];

  const homebase = Array.isArray(basePayload.homebase) && basePayload.homebase.length === 2
    ? basePayload.homebase.map(Number)
    : null;

  const outposts = Array.isArray(basePayload.outposts)
    ? basePayload.outposts
        .filter((entry) => Array.isArray(entry) && entry.length >= 2)
        .map((entry) => ({ x: Number(entry[0]), y: Number(entry[1]), baseid: entry[2] }))
    : [];

  const worldId =
    basePayload.worldid ||
    basePayload.worldId ||
    loginResponse?.worldid ||
    loginResponse?.worldId ||
    "";

  return {
    token: loginResponse?.token || "",
    user: {
      userid: loginResponse?.userid ?? loginResponse?.userId ?? null,
      username: loginResponse?.username || "",
      email: loginResponse?.email || "",
      pic_square: loginResponse?.pic_square || "",
    },
    map: {
      // WORLD_SIZE on the server is [height, width].
      height: worldSize[0] || MR2.mapHeight,
      width: worldSize[1] || MR2.mapWidth,
      worldid: worldId,
      homebase,
      outposts,
    },
  };
}

export function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

/**
 * localStorage that cannot take the app down with it.
 *
 * getItem/setItem throw - not return null - when storage is disabled, when the
 * origin is opaque, or when the quota is exhausted. Three call sites were
 * reading and writing the session token bare, and the first of them runs
 * inside restoreSession() before anything is on screen, so a throw there took
 * out sign-in entirely rather than degrading to "no remembered session".
 */
export function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

export function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn("[BYM-MR2] Could not write to localStorage.", error);
    return false;
  }
}

export function storageRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    /* nothing to clean up if storage is unavailable */
  }
}

export function buildTokenStorageKey(config) {
  return `${TOKEN_STORAGE_KEY}:${normalizeBaseUrl(config?.bymBaseUrl || DEFAULT_VIEWER_CONFIG.bymBaseUrl)}`;
}

export function normalizeApiVersion(value) {
  return String(value || DEFAULT_VIEWER_CONFIG.apiVersion).replace(/^\/+|\/+$/g, "");
}

export function parseJsonPayload(rawBody) {
  const text = String(rawBody || "").trim();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return { raw: text };
  }
}

export function extractErrorMessage(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error;
  }

  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message;
  }

  if (
    payload.errorDetails &&
    typeof payload.errorDetails === "object" &&
    typeof payload.errorDetails.message === "string" &&
    payload.errorDetails.message.trim()
  ) {
    return payload.errorDetails.message;
  }

  if (payload.details && typeof payload.details === "object") {
    return extractErrorMessage(payload.details);
  }

  if (typeof payload.raw === "string" && payload.raw.trim()) {
    return payload.raw;
  }

  return null;
}

export function cellKey(cellX, cellY) {
  return `${cellX},${cellY}`;
}

export function zoneKey(zoneX, zoneY) {
  return `${zoneX},${zoneY}`;
}

export function zoneOriginForCell(cellValue) {
  return Math.floor(cellValue / MR2.zoneSize) * MR2.zoneSize;
}

// MR2 uses an "odd-q" offset grid (odd columns shifted down). Distance math
// mirrors MapRoomPopup.GetCellsInRange in the original client: convert to
// axial coordinates and take the cube-space Chebyshev distance.
export function offsetToCube(x, y) {
  const q = x;
  const r = y - (x - (x & 1)) / 2;
  return [q, r, -q - r];
}

export function getHexDistance(x1, y1, x2, y2) {
  const [q1, r1, s1] = offsetToCube(x1, y1);
  const [q2, r2, s2] = offsetToCube(x2, y2);
  return Math.max(Math.abs(q1 - q2), Math.abs(r1 - r2), Math.abs(s1 - s2));
}

export function cubeToOffset(q, r) {
  return { x: q, y: r + (q - (q & 1)) / 2 };
}

// Flinger range rules from BUILDING5.getFlingerRange in the original client:
// main yards reach 2 + 2 * flingerLevel cells, outposts reach flingerLevel.
export function getFlingerRange(flingerLevel, isMainBase) {
  const level = Number(flingerLevel || 0);
  if (level <= 0) {
    return 0;
  }

  return isMainBase ? 2 + 2 * level : level;
}

export function makeEdgeKey(ax, ay, bx, by) {
  const start = vertexKey(ax, ay);
  const end = vertexKey(bx, by);
  return start < end ? `${start}|${end}` : `${end}|${start}`;
}

export function vertexKey(x, y) {
  return `${x},${y}`;
}

export function parseVertexKey(key) {
  const [x, y] = key.split(",").map(Number);
  return { x, y };
}

export function samePoint(left, right) {
  return left.x === right.x && left.y === right.y;
}

export function isCollinear(previous, current, next) {
  const cross = (current.x - previous.x) * (next.y - current.y) - (current.y - previous.y) * (next.x - current.x);
  return Math.abs(cross) < 0.001;
}

export function createEmptyBaseFilter() {
  return {
    types: [],
    tribes: [],
    levelMin: null,
    levelMax: null,
    outpostMin: null,
    outpostMax: null,
    playerOwnerId: null,
    playerUsername: "",
    inactivityDays: null,
  };
}

export function createEmptyRendererBaseFilter() {
  return {
    types: new Set(),
    tribes: new Set(),
    levelMin: null,
    levelMax: null,
    bigOwners: null,
    playerOwnerId: null,
    inactiveNames: null,
  };
}

export function normalizeRendererBaseFilter(filter) {
  const playerOwnerId = Number(filter?.playerOwnerId || 0);
  let levelMin = Number(filter?.levelMin || 0);
  let levelMax = Number(filter?.levelMax || 0);
  levelMin = levelMin > 0 ? levelMin : null;
  levelMax = levelMax > 0 ? levelMax : null;
  if (levelMin !== null && levelMax !== null && levelMin > levelMax) {
    [levelMin, levelMax] = [levelMax, levelMin];
  }

  return {
    types: new Set(filter?.types || []),
    tribes: new Set(filter?.tribes || []),
    levelMin,
    levelMax,
    // Set of lowercased names owning at least the chosen number of outposts
    // ("big fish"); null when the outpost filter is off.
    // An empty Set is a live filter matching nobody - only null means off.
    bigOwners: filter?.bigOwners instanceof Set ? filter.bigOwners : null,
    playerOwnerId: playerOwnerId > 0 ? playerOwnerId : null,
    // Set of lowercased names whose outpost count has not grown within the
    // chosen window; null when the inactivity filter is off.
    inactiveNames: filter?.inactiveNames instanceof Set ? filter.inactiveNames : null,
  };
}

export function hasActiveBaseFilterState(filter) {
  return (
    Number(filter?.types?.length || 0) > 0 ||
    Number(filter?.tribes?.length || 0) > 0 ||
    Number(filter?.levelMin || 0) > 0 ||
    Number(filter?.levelMax || 0) > 0 ||
    Number(filter?.outpostMin || 0) > 0 ||
    (filter?.outpostMax ?? null) !== null ||
    Number(filter?.playerOwnerId || 0) > 0 ||
    Number(filter?.inactivityDays || 0) > 0
  );
}

// MR2 wild monster cells carry the tribe name in the `n` field
// (see the server's v2 wildMonsterCell handler).
export function getTribeKey(cell) {
  if (Number(cell?.b) !== MR2.yardTypes.wildMonster) {
    return null;
  }

  const name = String(cell?.n || "").trim().toLocaleLowerCase();
  if (!name) {
    return null;
  }

  return TRIBE_FILTER_OPTIONS.some((option) => option.key === name) ? name : null;
}

export function describeTribe(cell) {
  const tribeKey = getTribeKey(cell);
  if (!tribeKey) {
    return "Unknown";
  }

  return TRIBE_FILTER_OPTIONS.find((option) => option.key === tribeKey)?.label || "Unknown";
}






export function formatRelativeTime(timestampMs) {
  const seconds = Math.max(0, Math.floor((Date.now() - Number(timestampMs || 0)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}


// Parses a comma/newline/semicolon separated list of player names.
export function parseNameList(value) {
  return [...new Set(
    String(value || "")
      .split(/[,;\n]/)
      .map((name) => name.trim())
      .filter(Boolean),
  )];
}






// ---------------------------------------------------------------------
// Viewer-server storage API (dev_server.py). The map cache is shared by
// every user of this viewer server; settings and login times are per user.
// All failures are surfaced as thrown errors; callers decide whether the
// viewer can continue without persistence.
// ---------------------------------------------------------------------
function storageUrl(scope, name, resource) {
  return `/api/storage/${scope}/${encodeURIComponent(String(name))}/${resource}`;
}

// Shared explored-map cache for one BYM server/world, stored on the viewer
// server under server_{servername}/zones/.
// Public list of worlds that have cached map data, for the signed-out guest
// view. Returns [{ name, zones, newest }] sorted most recently updated first.
export async function storageListServers() {
  const payload = await fetchJson("/api/storage/servers");
  const servers = Array.isArray(payload?.servers) ? payload.servers : [];
  return servers
    .filter((entry) => entry && typeof entry.name === "string" && entry.name)
    .sort((left, right) => Number(right.newest || 0) - Number(left.newest || 0));
}

export async function storageGetServerMap(serverName, zoneOrigins = null) {
  // Admins receive the unfiltered cache (hidden players included); the
  // server decides based on the verified token. When zoneOrigins is given,
  // only those zones are returned (cheap targeted reads for watch checks).
  let url = storageUrl("server", serverName, "map");
  if (Array.isArray(zoneOrigins) && zoneOrigins.length) {
    const tokens = zoneOrigins.slice(0, 200).map((zone) => `${zone.x}_${zone.y}`);
    url += `?zones=${encodeURIComponent(tokens.join(","))}`;
  }
  return fetchJson(url, { headers: viewerAuthHeaders() });
}

export async function storagePostServerZones(serverName, zones) {
  // Writing to the shared cache requires the signed-in session token; the
  // server verifies it (rotating the game token) and echoes the current
  // token in the response for the caller to adopt.
  return fetchJson(storageUrl("server", serverName, "map"), {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...viewerAuthHeaders() },
    body: JSON.stringify({ zones }),
  });
}

// Per-user settings blob, stored at users/{username}/settings.json.
// Per-user endpoints require the signed-in session token: the server verifies
// it against the game server and only serves the matching user (or an admin).
export async function storageGetUserSettings(username) {
  return fetchJson(storageUrl("user", username, "settings"), {
    headers: viewerAuthHeaders(),
  });
}

export async function storagePutUserSettings(username, settings) {
  return fetchJson(storageUrl("user", username, "settings"), {
    method: "PUT",
    headers: { "Content-Type": "application/json; charset=utf-8", ...viewerAuthHeaders() },
    body: JSON.stringify(settings),
  });
}

// Appends a UTC login timestamp to users/{username}/logins.json. The
// timestamp itself is written server-side so all entries share one clock.
export async function storagePostUserLogin(username, via, pic = "") {
  return fetchJson(storageUrl("user", username, "logins"), {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...viewerAuthHeaders() },
    // pic (the game avatar URL) feeds the public profile store so other
    // players' profile views can show it.
    body: JSON.stringify({ via: String(via || ""), pic: String(pic || "") }),
  });
}

// ---- Alliance API (served by the viewer's own server) ----
// One alliance per player; invites must be accepted. Every call requires the
// signed-in session token and echoes the current token for adoption.
export async function allianceMe() {
  return fetchJson("/api/alliance/me", { headers: viewerAuthHeaders() });
}

export async function alliancePost(endpoint, body = null) {
  return fetchJson(`/api/alliance/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...viewerAuthHeaders() },
    body: body ? JSON.stringify(body) : null,
  });
}

export async function fetchWorldActivity(world) {
  return fetchJson(`/api/storage/server/${encodeURIComponent(world)}/activity`);
}

export async function submitHideRequest(reason) {
  return fetchJson("/api/hide-request", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...viewerAuthHeaders() },
    body: JSON.stringify({ reason }),
  });
}

export async function fetchHideRequestStatus() {
  return fetchJson("/api/hide-request", { headers: viewerAuthHeaders() });
}

export async function allianceWatchZones() {
  return fetchJson("/api/alliance/watch-zones", { headers: viewerAuthHeaders() });
}

export async function allianceChatFetch(since = 0) {
  return fetchJson(`/api/alliance/chat?since=${Number(since) || 0}`, {
    headers: viewerAuthHeaders(),
  });
}

// Public game-avatar lookup, captured when that player last used the viewer.
export async function fetchPublicProfile(username) {
  return fetchJson(`/api/storage/profile/${encodeURIComponent(String(username))}`);
}

// ---- Moderation API (served by the viewer's own server) ----
// The signed-in BYM token is attached to viewer-server requests so it can
// verify admin identity against the game server.
let viewerAuthToken = "";

export function setViewerAuthToken(token) {
  viewerAuthToken = String(token || "");
}

export function viewerAuthHeaders() {
  return viewerAuthToken ? { "X-Viewer-Token": viewerAuthToken } : {};
}

export async function fetchHiddenPlayers() {
  const payload = await fetchJson("/api/admin/hidden-players");
  const players = Array.isArray(payload?.players) ? payload.players : [];
  return {
    names: players.map((entry) => String(entry?.name || "").trim()).filter(Boolean),
    tileStyle: payload?.hiddenTileStyle === "water" ? "water" : "blend",
    maxApiPerMinute: Number(payload?.maxApiPerMinute) || 0,
    maxApiPerMinutePerUser: Number(payload?.maxApiPerMinutePerUser) || 0,
    // Admin-tuned client pacing (0 = client decides for itself).
    clientZonePace: Number(payload?.clientZonePace) || 0,
    clientZoneConcurrency: Number(payload?.clientZoneConcurrency) || 0,
  };
}

export async function fetchAdminStatus() {
  // The dev server verifies our session token against the game server, which
  // rotates it (getinfo mints a new token each call). It returns the now-valid
  // token here so we can adopt it - otherwise our own map requests would start
  // failing with "Could not authenticate".
  const payload = await fetchJson("/api/admin/me", { headers: viewerAuthHeaders() });
  return {
    admin: Boolean(payload?.admin),
    user: String(payload?.user || ""),
    token: String(payload?.token || "").trim(),
  };
}

export async function fetchAnnouncement() {
  const payload = await fetchJson("/api/admin/announcement");
  return String(payload?.text || "").trim();
}

// Compact number for map labels: 1234 -> "1.2K", 5600000 -> "5.6M".
export function formatCompactNumber(value) {
  const number = Number(value) || 0;
  const abs = Math.abs(number);
  if (abs >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (abs >= 1_000_000) return `${(number / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${(number / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(number));
}

// Total loot sitting in a base cell (r1..r4 from getarea's `r` field).
export function getCellLootTotal(cell) {
  const resources = cell?.r;
  if (!resources || typeof resources !== "object") {
    return 0;
  }
  return ["r1", "r2", "r3", "r4"].reduce((sum, key) => sum + (Number(resources[key]) || 0), 0);
}

// Chebyshev ("square") distance on offset coords with toroidal wrap -- the
// exact metric the BYM server uses for flinger range validation.
export function getWrappedChebyshevDistance(x1, y1, x2, y2, mapWidth, mapHeight) {
  const deltaX = Math.abs(x1 - x2);
  const deltaY = Math.abs(y1 - y2);
  return Math.max(Math.min(deltaX, mapWidth - deltaX), Math.min(deltaY, mapHeight - deltaY));
}

export function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatDistance(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "Unknown distance";
  }

  return `${formatNumber(Number(value))} cell${Number(value) === 1 ? "" : "s"} away`;
}

// The BYM API does not expose a friendly world name for MR2; the world is
// identified by its id (a value like "0x0"). Prefer an explicit name if one
// is ever present, otherwise fall back to that id, then the map dimensions.
export function describeWorld(mapMeta) {
  const name = String(mapMeta?.worldName || mapMeta?.worldname || "").trim();
  if (name) {
    return name;
  }

  const worldId = String(mapMeta?.worldid || mapMeta?.worldId || "").trim();
  if (worldId) {
    return worldId;
  }

  const width = Number(mapMeta?.width || MR2.mapWidth);
  const height = Number(mapMeta?.height || MR2.mapHeight);
  return `${width}x${height}`;
}

export function describeYardType(cell) {
  switch (Number(cell.b)) {
    case MR2.yardTypes.wildMonster:
      return "Wild monster tribe";
    case MR2.yardTypes.main:
      return "Player main yard";
    case MR2.yardTypes.outpost:
      return "Player outpost";
    default:
      return Number(cell.i || 0) <= MR2.waterMaxHeight ? "Water" : "Terrain";
  }
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function pointInHex(pointX, pointY, originX, originY, zoom) {
  const vertices = CELL_HEX_VERTICES.map(([x, y]) => [originX + x * zoom, originY + y * zoom]);

  let inside = false;
  for (let current = 0, previous = vertices.length - 1; current < vertices.length; previous = current++) {
    const [currentX, currentY] = vertices[current];
    const [previousX, previousY] = vertices[previous];
    const intersects =
      currentY > pointY !== previousY > pointY &&
      pointX < ((previousX - currentX) * (pointY - currentY)) / (previousY - currentY) + currentX;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}
