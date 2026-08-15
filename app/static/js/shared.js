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
  // Session keepalive for the Activity feature: the game expires idle
  // sessions well before the hourly live check fires, so while the Activity
  // toggle is on, the token is quietly rotated after this much inactivity.
  // Per the game server's source (middleware/auth.ts + controllers/auth/
  // login.ts), tokens NEVER idle-expire: the redis user-token key is set
  // with no TTL and the JWT lives SESSION_LIFETIME (30d). Rotation is only
  // needed when a token has actually been invalidated - and each rotation
  // is itself a hazard, because redis holds exactly ONE valid token per
  // (sessionType, account): every mint kills the previous token instantly,
  // so any call in flight across a rotation 401s. The old 60s cadence
  // rotated ~1,440x/day per open tab and manufactured exactly those races.
  sessionKeepaliveCheckMs: 10 * 60 * 1000,
  // Rotate only after 6h of no authenticated traffic: near-zero race
  // windows, still detects an externally invalidated session (e.g. the
  // player logging into the game itself, which takes over the single
  // GAME-token slot) within hours rather than never.
  sessionKeepaliveIdleMs: 6 * 60 * 60 * 1000,
  // Own zones (main yard + outposts) live-refresh every 5 minutes while the
  // Activity toggle is on.
  watchOwnRefreshIntervalMs: 5 * 60 * 1000,
  // The Global tab's cross-world change feed re-fetches at most this often.
  activityGlobalCacheMs: 5 * 60 * 1000,
  // Per-burst budget. At one burst per hour this is tiny API traffic and
  // comfortably covers a large alliance's zones; the global rate gate paces
  // the burst itself.
  // Rings multiply the base-zone set by up to 9x, so the cap allows a
  // realistic alliance footprint plus its surrounding ring.
  watchMaxZonesPerCycle: 160,
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

/**
 * The mcBG matrix. _cellContainer is added to mcMask.mcBG, whose PlaceObject
 * matrix carries this non-uniform scale, and no code ever resets it - so every
 * cell inherits it. Only the RATIO is visible, because a uniform component is
 * indistinguishable from zoom: the map is drawn ~6% taller than it is wide.
 * Rendering without it leaves visible seams between the terrain diamonds.
 */
export const MCBG_SCALE_X = 1.028564453125;
export const MCBG_SCALE_Y = 1.090911865234375;
export const MCBG_ASPECT = MCBG_SCALE_Y / MCBG_SCALE_X;

/**
 * MapRoomCell.Update()'s frame labels, keyed by height. The bands are
 * exclusive upper bounds, and `empty` (an un-fetched cell) shares shape #67
 * with land1, so unknown ground reads as plain grass - exactly what the live
 * client shows before data arrives.
 *
 * i == 110 never occurs: the generator emits h + 10 for every h except 100,
 * which is redirected to 105, so 110 is the one hole in the range. i == 100
 * does occur and lands on sand1, since _water is (_height < 100).
 */
export const TERRAIN_FRAMES = [
  { max: 80, key: "water1" },
  { max: 90, key: "water2" },
  { max: 100, key: "water3" },
  { max: 105, key: "sand1" },
  { max: 110, key: "sand2" },
  { max: 120, key: "land1" },
  { max: 140, key: "land2" },
  { max: 160, key: "land3" },
  { max: 170, key: "land4" },
  { max: 175, key: "land5" },
  { max: Infinity, key: "land6" },
];

export function terrainFrameFor(height) {
  const value = Number(height || 0);
  for (const frame of TERRAIN_FRAMES) {
    if (value < frame.max) return frame.key;
  }
  return "land6";
}

/**
 * MapRoomCell overlay art, straight from the SWF shapes.
 *
 * glowWhite is #69 (mcGlow frames 2 and 3), glowRed is #70 (frame 4). Both are
 * 151x76 - the hex TOP FACE, 74% coverage - and both carry their own alpha in
 * the bitmap: white peaks at 180, red at 255. The code multiplies by 0.5 on
 * top, which is why an in-range cell reads as a ~0.353 grey-white wash rather
 * than a solid tint.
 *
 * protection is #150, the shield bubble, authored 80x64 and stretched per
 * footprint. star* are #139 (wild, grey) and #141 (player, gold), 24x22.
 */
export const MAPROOM_UI = {
  glowWhite: "/assets/maproom/ui/glow_white.png",
  glowRed: "/assets/maproom/ui/glow_red.png",
  protection: "/assets/maproom/ui/protection.png",
  starGrey: "/assets/maproom/ui/star_grey.png",
  starGold: "/assets/maproom/ui/star_gold.png",
  nameBarOverlay: "/assets/maproom/ui/namebar_overlay.png",
  // mcWorker (char 191 in the game SWF): the idle-worker figure shown on
  // owned outposts whose housing has no job running.
  workerIdle: "/assets/maproom/ui/worker_idle.png",
};

// mcPlayer's anchor inside the cell - the origin for every base-related asset.
export const MC_PLAYER_ANCHOR = { x: 61.5, y: 41 };

/**
 * #151, the protection bubble, authored once and stretched per footprint.
 *
 * x/y are sprite #151's PlaceObject translation inside mcPlayer (frame 4
 * main-protected, frame 8 outpost-protected). #151 holds shape #150 at an
 * identity matrix, but the shape's own bounds are (4.5, 6.65)-(84.0, 70.5) -
 * it does NOT start at its sprite's origin. That offset is inside the scaled
 * space, so it must be added before the stretch, not after. Omitting it drew
 * the bubble 8.2px high on a main yard and 7.1px high on an outpost.
 */
export const PROTECTION_BOUNDS = { x: 4.5, y: 6.65, width: 79.5, height: 63.85 };
export const PROTECTION_PLACEMENT = {
  main: { x: -39.90, y: -63.80, scaleX: 1.19666, scaleY: 1.22644 },
  outpost: { x: -31.75, y: -57.60, scaleX: 1.03857, scaleY: 1.06097 },
};

/**
 * mcPlayer.mcFlag.nameBar. SetupAlliance() always lands #128 on frame 3
 * (noAlliance) for a base, and frame 3 does not re-place depth 5, so nameBar
 * keeps frame 2's transform: offset (-18, 0), scale 0.95013 x 0.64. Combined
 * with mcFlag's own (-16, -4), the bar origin is (-34, -4) from mcPlayer.
 */
/**
 * mcFlag.txt - the cell name, read straight out of the SWF's DefineEditText
 * #126 rather than inferred: box (-2, -2)-(93, 12), 8px font 36 (Verdana
 * Bold), colour #000000, align CENTER, html, useOutlines.
 *
 * Placement is #128 frame 2 depth 13 at (-16.00, 2.60) inside mcFlag, and
 * frame 3 (noAlliance - the frame every base lands on) re-places it at the
 * same spot. Combined with mcFlag's own (-16, -4), the field's box spans
 * x -34..61 in mcPlayer space, which is exactly the nameBar's own span: the
 * name sits ON the bar, centred, not floating beneath the cell.
 */
export const NAME_TEXT = {
  // Centre of the text box, relative to mcPlayer.
  centreX: 13.5,
  centreY: 3.6,
  fontSize: 8,
  colour: "#000000",
};

export const NAME_BAR = {
  offsetX: -34,
  offsetY: -4,
  scaleX: 0.95013,
  scaleY: 0.64,
  // Every mcBG plate is 100 x 25 at (0, 0) in nameBar space - read from the
  // shape bounds, which are (0, 0)-(100, 25) for #96/#100..#107. The 101 x 26
  // used here previously was the EXPORTED PNG size, a pixel larger on each
  // axis because of the anti-alias bleed, not the geometry.
  bgWidth: 100,
  bgHeight: 25,
  bgX: 0,
  bgY: 0,
  // mcBar's shape is DefineShape4 with bounds (0, -0.5)-(108.5, 25.5), so it
  // starts half a pixel above the plate. Update() assigns .width directly in
  // nameBar space - `mcBar.width = 100/100 * Math.max(0, 100 - _damage)` -
  // which overrides the 0.5 scaleX authored at design time. _damage is a
  // percentage 0-100 straight off serverData.dm.
  barFullWidth: 100,
  barHeight: 26,
  barY: -0.5,
};

/**
 * `none` and `wmyard` do not use a purpose-made background shape: they share
 * #99, a generic rectangle reused all over the SWF, placed at scale
 * 0.176987 x 0.058823 with a translation of (-6.20, -3.80).
 *
 * That translation is NOT where the plate lands. #99's own bounds are
 * (35, 65)-(600, 490), so the shape does not start at its own origin, and the
 * offset resolves inside the scaled space:
 *
 *   x = -6.20 + 35 * 0.176987 = -0.006
 *   y = -3.80 + 65 * 0.058823 = +0.024
 *   size = 565 * 0.176987 x 425 * 0.058823 = 100.00 x 25.00
 *
 * i.e. it lands exactly where every other plate does. The translation and the
 * bounds cancel, which is what the research meant by "matching every other
 * background" - it is one box, not a special case. Treating the translation
 * as a position drew the neutral plate 6.2px left and 3.8px high.
 */

/**
 * Depletion contrast.
 *
 * A DEVIATION from the client, and the only one in this bar. mcBG and mcBar
 * carry near-identical colours on four of the six labels - player differs by
 * one unit per channel, ally by two, hostile and destroyed by one - so a
 * damaged base shows no visible depletion at all in game unless it is a wild
 * tribe (grey plate, white fill, 50 units apart). The research calls this out
 * explicitly for `player`.
 *
 * Since the bar is now also how this viewer conveys ownership, an invisible
 * fill would make damage unreadable on exactly the cells worth watching. Where
 * the authored pair is indistinguishable, the empty portion is darkened by
 * this factor instead. Set to 1 to restore the client's exact appearance.
 */
/**
 * Display ceiling for damage. A base at 97-100% renders as 96, so the fill
 * never collapses to a sliver too thin to read - the distinction between
 * "nearly destroyed" and "destroyed" is carried by the destroyed state, not by
 * the last four pixels of the bar. Does not alter the underlying dm value.
 */
export const NAME_BAR_MAX_DISPLAY_DAMAGE = 96;

export const NAME_BAR_EMPTY_DARKEN = 0.55;

/** Largest per-channel difference between two #rrggbb colours. */
export function colourDistance(left, right) {
  const parse = (hex) => [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16));
  const a = parse(left);
  const b = parse(right);
  return Math.max(...a.map((channel, index) => Math.abs(channel - b[index])));
}

/** Multiplies a #rrggbb colour's channels, clamped. */
export function darkenHex(hex, factor) {
  const parse = [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16));
  return `#${parse.map((c) => Math.max(0, Math.min(255, Math.round(c * factor)))
    .toString(16).padStart(2, "0")).join("")}`;
}
export const NAME_BAR_CONTRAST_THRESHOLD = 8;

// The plate border. Solid black, matching how it reads in game.
export const NAME_BAR_OUTLINE = "#000000";

/**
 * mcBG / mcBar colours by SetupAlliance() frame label.
 *
 * All authored values except one: `none` and `wmyard` use #ADADAD for the
 * plate rather than the SWF's #CCCCCC. Those two labels cover every wild
 * tribe and every unaffiliated player base - the bulk of the map - so their
 * plate is the colour the map reads as overall, and the authored grey sits
 * close enough to the #FEFEFE fill to wash out against it.
 *
 * The fill stays #FEFEFE, so depletion contrast widens from 50 to 81 and
 * these two labels still avoid NAME_BAR_EMPTY_DARKEN entirely - they remain
 * the only pair whose empty portion is drawn exactly as authored.
 */
export const NAME_BAR_COLOURS = {
  player: { bg: "#3887E7", bar: "#3786E7" },
  none: { bg: "#ADADAD", bar: "#FEFEFE" },
  wmyard: { bg: "#ADADAD", bar: "#FEFEFE" },
  ally: { bg: "#ACD7F9", bar: "#AAD6F9" },
  hostile: { bg: "#FF4628", bar: "#FE4528" },
  destroyed: { bg: "#CC0000", bar: "#CD0001" },
};

/**
 * mcPlayer.mcLevel: sprite #143 at cell-local (55.7, 7.1). The star's own
 * bounds are (-11.9, -11.2)-(11.9, 10.2), so it draws from mcLevel plus that
 * corner. lv_txt is 9px, centred, letterSpacing -1.
 */
export const LEVEL_PLACEMENT = {
  x: 55.7,
  y: 7.1,
  starOffsetX: -11.9,
  starOffsetY: -11.2,
  starWidth: 24,
  starHeight: 22,
  // lv_txt box is (-2, -2)-(18, 16) placed at (-8.5, -4.8) inside mcLevel and
  // centre-aligned, so the glyph centre is mcLevel + (-0.5, 2.2) - not the
  // mcLevel origin itself.
  textOffsetX: -0.5,
  textOffsetY: 2.2,
  fontSize: 9,
  letterSpacing: -1,
  wild: { star: "starGrey", text: "#333333" },
  player: { star: "starGold", text: "#80500A" },
};

export const TERRAIN_TILE_PATH = "/assets/maproom/terrain/";
export const TERRAIN_TILE_ASSETS = TERRAIN_FRAMES
  .map((frame) => TERRAIN_TILE_PATH + frame.key + ".png");
// Bitmaps are 150x100; the exported shapes are 151x101 (half a pixel of
// anti-alias bleed on each side), and they must be drawn at that size for the
// diamonds to meet without seams.
export const TERRAIN_TILE_W = 151;
export const TERRAIN_TILE_H = 101;

/**
 * Vertical offset of a cell's artwork, from MapRoomCell.Update():
 *
 *   land  (i >= 100)  mc.y = -int((i - 100) * 0.6) + 18
 *   water (i <  100)  mc.y =  int(100 - i)      + 18
 *
 * Land rises 0.6px per height unit above the i=100 baseline; water sinks a
 * full 1px per unit below it. int() truncates toward zero. The shared +18 is
 * a constant translation of the whole map and is kept only for fidelity.
 */
export function cellLift(height) {
  const value = Number(height);
  if (!Number.isFinite(value)) return 18;
  if (value < 100) return Math.trunc(100 - value) + 18;
  return -Math.trunc((value - 100) * 0.6) + 18;
}

/**
 * Water's cyan surface plane (mcWater, shape #175: rgba(0,204,255,127) over
 * the hex top face, placed at scale 1.5 -> 150x75).
 *
 * mcWater.y = -int(100 - _height) exactly cancels the parent's downward
 * shift, so the surface stays on a FIXED plane while the bed sinks with
 * depth - which is why deep water reads darker: more of the dark pre-tinted
 * bed shows through beneath a constant-height surface.
 *
 * It is placed at depth 51 (frame 2) and not removed until frame 5, so it
 * covers water1, water2 AND water3 - and 51 > mcPlayer's 22, so it
 * composites over cell contents.
 */
export const WATER_SURFACE_FILL = "rgba(0, 204, 255, 0.498)";

export function waterSurfaceLift(height) {
  const value = Number(height);
  if (!Number.isFinite(value)) return 0;
  return -Math.trunc(100 - value);
}

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
  mainProtected: "/assets/cells/main-protected.png",
  outpostProtected: "/assets/cells/outpost-protected.png",
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

/**
 * Where each mcPlayer frame's artwork sits, as bounds relative to the
 * mcPlayer anchor (61.5, 41). Straight from the SWF shape bounds:
 *
 *   main / -damaged / -destroyed / -protected   (-25, -56)-(61, 19)   87 x 76
 *   outpost / ...                               (-22, -46)-(49, 14)   72 x 61
 *   tribe-Abunakki, tribe-Dreadnaut             ( -5, -31)-(25, -1)   31 x 31
 *   tribe-Kozu, tribe-Legionnaire               ( -5, -30)-(25,  0)   31 x 31
 *
 * These are anchored placements, NOT a centred fit: the art hangs above and
 * to the left of the anchor, which is what makes a main yard's tower sit up
 * out of its diamond instead of floating in the middle of the cell.
 *
 * Where an exported PNG is larger than its documented bounds - Abunakki is
 * 33x33 against 31x31, because #162's outline stroke is baked in and that
 * stroke extends symmetrically - the surplus is split evenly, so the artwork
 * stays registered on the same point.
 */
export const CELL_ART_BOUNDS = {
  main: { x: -25, y: -56, width: 87, height: 76 },
  outpost: { x: -22, y: -46, width: 72, height: 61 },
  // Tribe art is the frame's own shape PLUS #162's outline stroke, which is
  // placed once at frame 9 depth 2 with an identity matrix and never removed,
  // so it sits on every tribe frame. Its bounds (-5.5, -31.5)-(25.5, -0.5)
  // are half a pixel wider than the shapes underneath on every side, so the
  // composited art starts at -5.5, -31.5 rather than the shape's own -5, -31.
  // Kozu and Legionnaire sit one pixel lower (their shapes are -30..0), so
  // the union with the outline is half a pixel taller.
  tribe: { x: -5.5, y: -31.5, width: 31, height: 31 },
  tribeTall: { x: -5.5, y: -31.5, width: 31, height: 31.5 },
};

/** Which bounds entry each cell-art asset uses. */
export const CELL_ART_PLACEMENT = {
  "/assets/cells/main.png": "main",
  "/assets/cells/main-damaged.png": "main",
  "/assets/cells/main-destroyed.png": "main",
  "/assets/cells/main-protected.png": "main",
  "/assets/cells/outpost.png": "outpost",
  "/assets/cells/outpost-damaged.png": "outpost",
  "/assets/cells/outpost-destroyed.png": "outpost",
  "/assets/cells/outpost-protected.png": "outpost",
  "/assets/cells/tribe-abunakki.png": "tribe",
  "/assets/cells/tribe-dreadnaut.png": "tribe",
  "/assets/cells/tribe-kozu.png": "tribeTall",
  "/assets/cells/tribe-legionnaire.png": "tribeTall",
};

export const TYPE_FILTER_OPTIONS = [
  // Short labels so all three chips share one line in the filter panel.
  { key: "wild", label: "Wild" },
  { key: "main", label: "Main yard" },
  { key: "outpost", label: "Outpost" },
];

export const TRIBE_FILTER_OPTIONS = [
  { key: "abunakki", label: "Abunakki" },
  { key: "dreadnaut", label: "Dreadnaut" },
  { key: "kozu", label: "Kozu" },
  { key: "legionnaire", label: "Legionnaire" },
];

// Cell height chips, one per terrain frame a base can stand on (water is
// unreachable for bases and gets no chip). land5/land6 read as stone in both
// the tile art and the far-zoom fills, hence "Rock".
export const HEIGHT_FILTER_OPTIONS = [
  { key: "sand1", label: "Sand 1" },
  { key: "sand2", label: "Sand 2" },
  { key: "land1", label: "Grass 1" },
  { key: "land2", label: "Grass 2" },
  { key: "land3", label: "Grass 3" },
  { key: "land4", label: "Grass 4" },
  { key: "land5", label: "Rock 1" },
  { key: "land6", label: "Rock 2" },
];

// Owner-relation chips: the same me/ally/enemy split the name colors use,
// plus "other" for unaffiliated players. Also reused as the anchor picker
// for the flinger-range filter.
export const OWNER_FILTER_OPTIONS = [
  { key: "me", label: "Me" },
  { key: "allies", label: "Allies" },
  { key: "enemies", label: "Enemies" },
  { key: "other", label: "Other" },
];

// Outpost kit tiers, replacing the old tribe filter section. Keys match
// getOutpostKitKey(); "none" is an outpost below the Regular-kit threshold.
export const KIT_FILTER_OPTIONS = [
  { key: "none", label: "No Kit" },
  { key: "regular", label: "Regular" },
  { key: "mega", label: "Mega" },
  { key: "ultra", label: "Ultra" },
];

export const ALL_TYPE_FILTER_KEYS = TYPE_FILTER_OPTIONS.map((option) => option.key);
export const ALL_KIT_FILTER_KEYS = KIT_FILTER_OPTIONS.map((option) => option.key);
export const ALL_HEIGHT_FILTER_KEYS = HEIGHT_FILTER_OPTIONS.map((option) => option.key);
export const ALL_OWNER_FILTER_KEYS = OWNER_FILTER_OPTIONS.map((option) => option.key);
export const ALL_TRIBE_FILTER_KEYS = TRIBE_FILTER_OPTIONS.map((option) => option.key);

// Damage-protection checkboxes: both on = no filter, one on = only that
// state, none = hides every player base (matching checklist semantics).
export const PROTECTION_FILTER_OPTIONS = [
  { key: "protected", label: "Damage protection" },
  { key: "unprotected", label: "No damage protection" },
];
export const ALL_PROTECTION_FILTER_KEYS = PROTECTION_FILTER_OPTIONS.map((option) => option.key);

// Outpost kit tier from empire value. Kits are prefab layouts and nothing in
// the map data records which one an outpost has, so the tier is inferred:
// each threshold sits 25% under the kit's own computed empire value
// (Regular 3,210,880 | Mega 15,930,337 | Ultra 42,686,223 via the game's
// CalcBaseValue over the kit layouts), so a partly demolished outpost still
// reads as the kit it was built from, and the ~5x / ~2.7x gaps keep tiers
// from bleeding into each other. A kit's value is a floor - owners upgrade
// past it - so this reads as "this kit or better".
export function getOutpostKitKey(empireValue) {
  const value = Number(empireValue || 0);
  if (value >= 32_014_667) return "ultra";
  if (value >= 11_947_752) return "mega";
  if (value >= 2_408_160) return "regular";
  return "none";
}

// Subtier split points within each kit family, fitted on 466,632 outposts
// across all five servers (2026-08-12 exports) so each family lands at
// 60% base / 25% "+" / 15% "++". Boundaries snap between distinct empire
// values, so tie runs of identical prefab values never straddle a cut.
// Each pair is [min value for "+", min value for "++"]; below the first is
// the plain tier. The family itself still comes from getOutpostKitKey, so
// colors and filters stay per-family.
const KIT_SUBTIER_MINIMUMS = {
  none: [109_643, 649_480],
  regular: [3_261_850, 3_453_846],
  mega: [14_994_873, 15_722_135],
  ultra: [41_551_399, 43_150_842],
};

// "" | "+" | "++" for an outpost's empire value, within its kit family.
export function getOutpostKitSuffix(empireValue) {
  const value = Number(empireValue || 0);
  const [plus, plusPlus] = KIT_SUBTIER_MINIMUMS[getOutpostKitKey(value)];
  if (value >= plusPlus) return "++";
  if (value >= plus) return "+";
  return "";
}

export function describeOutpostKitLabel(kitKey) {
  return KIT_FILTER_OPTIONS.find((option) => option.key === kitKey)?.label || "None";
}

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
    const message = sanitizeErrorMessage(
      extractErrorMessage(payload) || response.statusText || "Request failed",
      response.status,
    );
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

// A gateway/proxy hiccup can hand back a whole HTML error page; parsing
// stores it under { raw } and it used to flow verbatim into the session
// status. Reduce any such blob to a short, human line.
export function sanitizeErrorMessage(message, status = 0) {
  const text = String(message || "").trim();
  const looksHtml = /^\s*</.test(text) || /<\/?(html|body|head|div|pre|h\d)\b/i.test(text);
  if (looksHtml || text.length > 300) {
    return status
      ? `The server returned an error page (HTTP ${status}). Please try again.`
      : "The server returned an error page. Please try again.";
  }
  return text;
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
    // Checklists are explicit now: every key checked is the default and
    // means "no restriction". A strict subset is an active filter; an empty
    // list means the user unchecked everything ("show nothing").
    types: [...ALL_TYPE_FILTER_KEYS],
    kits: [...ALL_KIT_FILTER_KEYS],
    heights: [...ALL_HEIGHT_FILTER_KEYS],
    owners: [...ALL_OWNER_FILTER_KEYS],
    tribes: [...ALL_TRIBE_FILTER_KEYS],
    // Flinger-range filter: off until the checkbox is ticked AND at least
    // one anchor group is chosen.
    flingerEnabled: false,
    flingerOf: [],
    damageMin: null,
    damageMax: null,
    protection: [...ALL_PROTECTION_FILTER_KEYS],
    levelMin: null,
    levelMax: null,
    outpostMin: null,
    outpostMax: null,
    // Multiple players can be filtered at once: [{ ownerId, username }].
    players: [],
    inactivityDays: null,
  };
}

export function createEmptyRendererBaseFilter() {
  return {
    types: new Set(),
    kits: new Set(),
    levelMin: null,
    levelMax: null,
    bigOwners: null,
    playerOwnerIds: null,
    inactiveNames: null,
    heights: new Set(),
    owners: new Set(),
    tribes: new Set(),
    protection: new Set(),
    damageMin: null,
    damageMax: null,
    relSets: null,
    flingerCells: null,
  };
}

export function normalizeRendererBaseFilter(filter) {
  let levelMin = Number(filter?.levelMin || 0);
  let levelMax = Number(filter?.levelMax || 0);
  levelMin = levelMin > 0 ? levelMin : null;
  levelMax = levelMax > 0 ? levelMax : null;
  if (levelMin !== null && levelMax !== null && levelMin > levelMax) {
    [levelMin, levelMax] = [levelMax, levelMin];
  }

  // Accept either the multi-player list or a legacy single playerOwnerId.
  let playerOwnerIds = null;
  if (Array.isArray(filter?.players) && filter.players.length) {
    playerOwnerIds = new Set(
      filter.players.map((entry) => Number(entry?.ownerId || 0)).filter((id) => id > 0),
    );
    if (!playerOwnerIds.size) playerOwnerIds = null;
  } else if (Number(filter?.playerOwnerId || 0) > 0) {
    playerOwnerIds = new Set([Number(filter.playerOwnerId)]);
  }

  return {
    // Empty set = restriction off. The app maps "all boxes checked" to an
    // empty set and "no boxes checked" to a sentinel key that matches
    // nothing, so only strict subsets arrive here as real sets.
    types: new Set(filter?.types || []),
    kits: new Set(filter?.kits || []),
    levelMin,
    levelMax,
    // Set of lowercased names owning at least the chosen number of outposts
    // ("big fish"); null when the outpost filter is off.
    // An empty Set is a live filter matching nobody - only null means off.
    bigOwners: filter?.bigOwners instanceof Set ? filter.bigOwners : null,
    playerOwnerIds,
    // Set of lowercased names whose outpost count has not grown within the
    // chosen window; null when the inactivity filter is off.
    inactiveNames: filter?.inactiveNames instanceof Set ? filter.inactiveNames : null,
    heights: new Set(filter?.heights || []),
    owners: new Set(filter?.owners || []),
    tribes: new Set(filter?.tribes || []),
    protection: new Set(filter?.protection || []),
    damageMin: Number(filter?.damageMin || 0) > 0 ? Number(filter.damageMin) : null,
    damageMax: (filter?.damageMax !== null && filter?.damageMax !== undefined
      && Number(filter.damageMax) < 100) ? Number(filter.damageMax) : null,
    // { own, allies, enemies }: lowercased-name Sets resolving a base owner
    // to me/allies/enemies/other. Null when no owner-aware filter is live.
    relSets: filter?.relSets || null,
    // Set of "x,y" cell keys inside flinger range of the chosen anchors
    // (hex-disk reach, from the renderer's GetCellsInRange port); null when
    // the flinger filter is off.
    flingerCells: filter?.flingerCells instanceof Set ? filter.flingerCells : null,
  };
}

export function hasActiveBaseFilterState(filter) {
  const typesActive =
    Array.isArray(filter?.types) && filter.types.length < ALL_TYPE_FILTER_KEYS.length;
  const kitsActive =
    Array.isArray(filter?.kits) && filter.kits.length < ALL_KIT_FILTER_KEYS.length;
  const heightsActive =
    Array.isArray(filter?.heights) && filter.heights.length < ALL_HEIGHT_FILTER_KEYS.length;
  const ownersActive =
    Array.isArray(filter?.owners) && filter.owners.length < ALL_OWNER_FILTER_KEYS.length;
  const tribesActive =
    Array.isArray(filter?.tribes) && filter.tribes.length < ALL_TRIBE_FILTER_KEYS.length;
  const flingerActive =
    filter?.flingerEnabled === true && Number(filter?.flingerOf?.length || 0) > 0;
  const damageActive =
    Number(filter?.damageMin || 0) > 0 ||
    (filter?.damageMax !== null && filter?.damageMax !== undefined && Number(filter.damageMax) < 100);
  const protectionActive =
    Array.isArray(filter?.protection) && filter.protection.length < ALL_PROTECTION_FILTER_KEYS.length;
  return (
    typesActive ||
    kitsActive ||
    heightsActive ||
    ownersActive ||
    tribesActive ||
    flingerActive ||
    damageActive ||
    protectionActive ||
    Number(filter?.levelMin || 0) > 0 ||
    Number(filter?.levelMax || 0) > 0 ||
    Number(filter?.outpostMin || 0) > 0 ||
    (filter?.outpostMax ?? null) !== null ||
    Number(filter?.players?.length || 0) > 0 ||
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
// Recent ownership changes from the shared cache. No server = every cached
// world ("Global"); with a server name, just that world.
export async function fetchWorldChanges({ server = "", limit = 100 } = {}) {
  const params = new URLSearchParams();
  if (server) params.set("server", server);
  if (limit) params.set("limit", String(limit));
  const query = params.toString();
  return fetchJson(`/api/storage/changes${query ? `?${query}` : ""}`);
}

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
    // Anything that is not "water" is the tribe disguise. The server may send
    // either "tribe" or the legacy "blend"; only the renderer's !== "water"
    // test matters, so both normalise to the same thing.
    tileStyle: payload?.hiddenTileStyle === "water" ? "water" : "tribe",
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

// 1/7/30-day outpost deltas, computed server-side cache-vs-cache from the
// daily history snapshots. windows[k] is null until history is old enough.
// Archived baseload summary for one player (joined/seen/battle logs).
export async function fetchBaseData(uid) {
  return fetchJson(`/api/basedata?uid=${encodeURIComponent(uid)}`);
}

export async function fetchLeaderboardHistory(worldId) {
  return fetchJson(`/api/leaderboard-history?world=${encodeURIComponent(worldId)}`);
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

/**
 * MR2 wild monster generation, reproduced exactly from the server.
 *
 * Tribe and level are pure functions of (x + y) - no noise, no seed, no
 * clustering - so any client can regenerate the wild monster cell that a
 * coordinate WOULD have produced, byte for byte, without asking the server.
 *
 *   wildMonsterCell.ts     tribe = Tribes[(x + y) % 4]
 *   calculateTribeLevel.ts level = ((x + y) % (45 - min[tribe])) + min[tribe]
 *
 * Order matters: Tribes[] is the server's array order, and the index is the
 * tribe key, so this list must not be re-sorted to match TRIBE_FILTER_OPTIONS
 * (which is display order and deliberately different).
 *
 * Kozu's declared minimum of 29 is unreachable in practice: (x+y) % 4 === 1
 * forces (x+y) % 16 into {1,5,9,13}, so its floor is really 30. That is the
 * server's behaviour, quirk included, and is reproduced rather than corrected.
 */
export const MR2_TRIBE_ORDER = ["legionnaire", "kozu", "abunakki", "dreadnaut"];
const MR2_TRIBE_MIN_LEVEL = {
  legionnaire: 25,
  kozu: 29,
  abunakki: 25,
  dreadnaut: 25,
};
const MR2_TRIBE_MAX_LEVEL = 45;

export function generatedTribeKey(x, y) {
  const sum = Number(x) + Number(y);
  if (!Number.isFinite(sum)) return null;
  return MR2_TRIBE_ORDER[positiveModulo(sum, MR2_TRIBE_ORDER.length)];
}

export function generatedTribeLevel(x, y) {
  const sum = Number(x) + Number(y);
  const tribe = generatedTribeKey(x, y);
  if (!tribe) return 0;
  const lower = MR2_TRIBE_MIN_LEVEL[tribe];
  return positiveModulo(sum, MR2_TRIBE_MAX_LEVEL - lower) + lower;
}

/**
 * The wild monster cell that (x, y) generates. `terrainHeight` is the cell's
 * own `i`: userCell.ts and wildMonsterCell.ts both emit `i: cell.terrainHeight`
 * from the same seeded noise, so an occupied cell's height is identical to the
 * height the wild cell there would have had. Passing it through is therefore
 * not a leak - it is the same number either way - and it makes the disguise
 * exact instead of approximate.
 */
export function generatedWildCell(x, y, terrainHeight) {
  const cellX = Number(x);
  const cellY = Number(y);
  return {
    x: cellX,
    y: cellY,
    b: MR2.yardTypes.wildMonster,
    uid: 0,
    i: Number(terrainHeight),
    n: generatedTribeKey(cellX, cellY),
    l: generatedTribeLevel(cellX, cellY),
    dm: 0,
    d: 0,
  };
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
