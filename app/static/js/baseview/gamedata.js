// Game data extracted from the original client (YARD_PROPS.as).
//
// Each entry describes one building: footprint size (yard pixels), type,
// per-level costs (r1 twigs, r2 pebbles, r3 putty, r4 goo, time seconds),
// hp per level, and — crucially for rendering — per-level sprite files with
// the exact pixel offsets the Flash client uses to anchor them.

const NAME_OVERRIDES = {
  twigsnapper: "Twig Snapper",
  pebbleshiner: "Pebble Shiner",
  puttysquisher: "Putty Squisher",
  goofactory: "Goo Factory",
  storagesilo: "Storage Silo",
  monsterlocker: "Monster Locker",
  monsterjuiceloosener: "Monster Juicer",
  yardplanner: "Yard Planner",
  maproom: "Map Room",
  generalstore: "General Store",
  townhall: "Town Hall",
  monsterhousing: "Monster Housing",
  hatcherycontrolcenter: "Hatchery Control Center",
  champchamber: "Champion Chamber",
  monsterbaiter: "Monster Baiter",
  boobytrap: "Booby Trap",
  heavytrap: "Heavy Trap",
  cannontower: "Cannon Tower",
  snipertower: "Sniper Tower",
  lasertower: "Laser Tower",
  railguntower: "Railgun Tower",
  spurtztower: "Spurtz Tower",
  blackspurtztower: "Black Spurtz Tower",
  guardtower: "Guard Post",
  flaktower: "Aerial Defense Tower",
  lightningtower: "Tesla Tower",
  monsterlab: "Monster Locker Lab",
  siegefactory: "Siege Factory",
  siegelab: "Siege Lab",
  radiotower: "Radio Tower",
  outpostdefender: "Outpost Defender",
  resourceoutpost: "Resource Outpost",
  monstercage: "Monster Cage",
  trojanhorse: "Trojan Horse",
};

export class GameData {
  constructor(yardProps) {
    this.byId = new Map();
    for (const props of yardProps) {
      this.byId.set(props.id, props);
    }
  }

  static async load(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load yard props (${response.status})`);
    return new GameData(await response.json());
  }

  get(typeId) {
    return this.byId.get(typeId) || null;
  }

  images(typeId) {
    const props = this.get(typeId);
    if (!props) return null;
    // Both spellings occur in the decompiled table.
    return props.imgData || props.imageData || null;
  }

  // The image table is bucketed by level ("1", "3", "6", "10", ...). The
  // Flash client uses the highest bucket that does not exceed the level.
  imagesForLevel(typeId, level) {
    const table = this.images(typeId);
    if (!table) return null;
    const buckets = Object.keys(table)
      .filter((key) => /^\d+$/.test(key))
      .map(Number)
      .sort((a, b) => a - b);
    if (!buckets.length) return null;
    let chosen = buckets[0];
    for (const bucket of buckets) {
      if (bucket <= level) chosen = bucket;
    }
    return { baseurl: table.baseurl || "", entry: table[String(chosen)], bucket: chosen };
  }

  all() {
    return [...this.byId.values()];
  }

  displayName(typeId) {
    const props = this.get(typeId);
    if (!props) return `Building #${typeId}`;
    // props.name is a localization key like "#b_townhall#"; prefer the
    // game's own english.json string when it is loaded.
    if (props.name && langCache?.[props.name]) return langCache[props.name];
    const table = this.images(typeId);
    const slug = (table?.baseurl || "")
      .replace(/^buildings\//, "")
      .replace(/\/$/, "")
      .replace(/\.v\d+$/, "");
    if (NAME_OVERRIDES[slug]) return NAME_OVERRIDES[slug];
    if (slug) {
      return slug
        .replace(/^i(?=[a-z])/, "inferno ")
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
    // Fall back to the localization key: "#b_townhall#" → "Townhall"
    const key = String(props.name || "").replace(/^#b?_?|#$/g, "");
    return key ? key.replace(/\b\w/g, (c) => c.toUpperCase()) : `Building #${typeId}`;
  }

  footprint(typeId) {
    const props = this.get(typeId);
    return props?.size || 40;
  }

  hp(typeId, level) {
    const props = this.get(typeId);
    const table = props?.hp;
    if (!Array.isArray(table)) return null;
    return table[Math.max(0, Math.min(table.length - 1, (level || 1) - 1))] ?? null;
  }

  cost(typeId, level) {
    const props = this.get(typeId);
    const costs = props?.costs;
    if (!Array.isArray(costs)) return null;
    return costs[Math.max(0, Math.min(costs.length - 1, (level || 1) - 1))] ?? null;
  }

  maxLevel(typeId) {
    const props = this.get(typeId);
    return Array.isArray(props?.costs) ? props.costs.length : null;
  }
}

export function formatDuration(seconds) {
  seconds = Number(seconds) || 0;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1).replace(/\.0$/, "")}h`;
  return `${(seconds / 86400).toFixed(1).replace(/\.0$/, "")}d`;
}

export function formatNumber(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) >= 1e9) return (number / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
  if (Math.abs(number) >= 1e6) return (number / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (Math.abs(number) >= 1e4) return (number / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return Math.round(number).toLocaleString();
}

// ── Player level (BASE.as XP table, cumulative points per level) ─────────

// BASE.s_levels: cumulative points for each level. The game client ships 100
// entries; BYMR's server-side calculateBaseLevel only ships the first 56, so
// the two disagree above level 56. The HUD is drawn by the client, so the
// client's table is what a player sees and is what we mirror here.
export const XP_LEVELS = [
  0, 900, 3500, 5000, 7500, 10500, 14700, 20580, 28812, 40337, 56472, 79060,
  110684, 154958, 216941, 303717, 425204, 595286, 833401, 1166761, 1633465,
  2286851, 3201591, 4482228, 6275119, 8785167, 12299234, 17218927, 24106498,
  33749097, 47248736, 66148230, 92607522, 129650530, 181510743, 254115040,
  355761056, 498065478, 697291669, 976208337, 1366691671, 1913368339,
  2678715675, 3750201945, 5250282723, 7350395812, 10290554137, 14406775792,
  20169486109, 28237280553, 39532192774, 55345069884, 77483097838,
  108476336973, 151866871762, 212613620467, 297659068653, 357190880000,
  428629050000, 514354860000, 617225830000, 740670990000, 888805180000,
  1066566210000, 1279879450000, 1535853400000, 1843026400000, 2211631680000,
  2653958010000, 3184749610000, 3821699530000, 4586039430000, 5503247310000,
  6603896770000, 7924676120000, 9509611340000, 11411533600000, 13693840320000,
  16432608380000, 19719130050000, 23662956060000, 28395547270000,
  34074656720000, 40889588060000, 49067505670000, 58881006800000,
  70657208160000, 84788649790000, 101746379740000, 122095655680000,
  146514786810000, 175817744170000, 210981293000000, 253177551600000,
  303813061920000, 364575674300000, 437490809160000, 524988970990000,
  629986765180000, 755984118210000,
];

/**
 * BASE.BaseLevel. The points that drive the level are the save's `points`
 * PLUS `basevalue` - 10% of the build cost and time of every standing
 * building, held on the save and only ever ratcheting upwards. Reading
 * `points` alone understates the level on any developed base.
 */
export function baseLevelInfo(basePoints, baseValue = 0) {
  const points = (Number(basePoints) || 0) + (Number(baseValue) || 0);
  let level = 1;
  let lower = 0;
  let upper = XP_LEVELS[1] || 1;
  for (let i = 0; i < XP_LEVELS.length - 1; i++) {
    if (points >= XP_LEVELS[i]) {
      level = i + 1;
      lower = XP_LEVELS[i];
      upper = XP_LEVELS[i + 1];
    }
  }
  return { level, lower, upper, points };
}

export function levelFromPoints(points, baseValue = 0) {
  return baseLevelInfo(points, baseValue).level;
}


// ── Monster names (game-data monsterKeys) ────────────────────────────────

export const MONSTER_NAMES = {"C1": "Pokey", "C2": "Octo-ooze", "C3": "Bolt", "C4": "Fink", "C5": "Eye-ra", "C6": "Ichi", "C7": "Bandito", "C8": "Fang", "C9": "Brain", "C10": "Crabatron", "C11": "Project X", "C12": "D.A.V.E", "C13": "Wormzer", "C14": "Teratorn", "C15": "Zafreeti", "C16": "Vorg", "C17": "Slimeattikus", "C19": "Rezghul", "C200": "AILooter1 (Looter)", "IC1": "Spurtz", "IC2": "Zagnoid", "IC3": "Malphus", "IC4": "Valgos", "IC5": "Balthazar", "IC6": "Grokus", "IC7": "Sabnox", "IC8": "King Wormzer"};

export function monsterName(key) {
  return MONSTER_NAMES[key] || String(key);
}

// ── Harvester production (BRESOURCE.as) ──────────────────────────────────
// produce[l-1] units every cycleTime[l-1] seconds, capped at capacity[l-1].
// Save fields: st = stored at savetime, pr = producing flag.
// Resource type by building id: 1 twigs, 2 pebbles, 3 putty, 4 goo.

export const HARVESTER_RESOURCE = { 1: "r1", 2: "r2", 3: "r3", 4: "r4" };

export function harvesterInfo(props, level, record, savetime) {
  if (!props || !Array.isArray(props.produce) || !Array.isArray(props.cycleTime)) return null;
  const idx = Math.max(0, Math.min(props.produce.length - 1, (level || 1) - 1));
  const produce = Number(props.produce[idx]) || 0;
  const cycle = Number(props.cycleTime[idx]) || 1;
  const capacity = Number(props.capacity?.[idx]) || 0;
  const stored0 = Number(record?.st) || 0;
  const producing = Number(record?.pr) !== 0; // BRESOURCE._producing
  const ratePerHour = (produce / cycle) * 3600;

  const storedNow = (nowMs = Date.now()) => {
    if (!producing) return Math.min(stored0, capacity);
    const elapsed = Math.max(0, Math.floor(nowMs / 1000) - (Number(savetime) || 0));
    const iterations = Math.floor(elapsed / cycle);
    return Math.min(stored0 + produce * iterations, capacity);
  };

  return { produce, cycle, capacity, ratePerHour, producing, storedNow };
}

// ── Champions (championStats.ts) ─────────────────────────────────────────

export const CHAMPION_NAMES = { 1: "Gorgo", 2: "Drull", 3: "Fomor" };

export function championSprite(t, level, size = 150) {
  const spriteLevel = Math.max(1, Math.min(6, Number(level) || 1));
  return `monsters/G${t}_L${spriteLevel}-${size}.png`;
}

// ── Monster stats (game-data/stats/monsterStats.ts, extracted verbatim) ──
// Per-monster: props.health/damage/speed indexed by academy level - 1,
// props.cStorage = housing space, cTime/cResource = hatch time & juice cost.

let monsterStatsCache = null;

export async function loadMonsterStats(url = "data/monsterstats.json") {
  if (monsterStatsCache) return monsterStatsCache;
  try {
    const response = await fetch(url);
    monsterStatsCache = response.ok ? await response.json() : {};
  } catch {
    monsterStatsCache = {};
  }
  return monsterStatsCache;
}

export function monsterStat(key) {
  return monsterStatsCache?.[key] || null;
}

// Value from a per-level array at academy level (1-based), clamped like the
// client does when arrays are shorter than the level range.
export function statAtLevel(array, level) {
  if (!Array.isArray(array) || !array.length) return null;
  return array[Math.max(0, Math.min(array.length - 1, (Number(level) || 1) - 1))];
}

// ── Localization (server /gamestage/assets/english.json, 3800+ strings) ──
// The same KEYS table the Flash client uses; building names in YARD_PROPS
// are literal keys like "#b_townhall#".

let langCache = null;

export async function loadLanguage(assetBase) {
  if (langCache) return langCache;
  try {
    const base = assetBase.replace(/\/+$/, "");
    const response = await fetch(`${base}/gamestage/assets/english.json`);
    langCache = response.ok ? await response.json() : {};
  } catch {
    langCache = {};
  }
  return langCache;
}

export function localize(key, fallback = null) {
  if (!key) return fallback ?? "";
  const direct = langCache?.[key];
  if (typeof direct === "string" && direct) return direct;
  return fallback ?? String(key).replace(/^#|#$/g, "");
}

// ── Achievements (ACHIEVEMENTS.as) ───────────────────────────────────────
// Index-keyed table (1..22; entry 0 is a blocked placeholder). Completion is
// stats.achievements.c[index]; counters live in stats.achievements.s.
// evaluateAchievement ports ACHIEVEMENTS.Check rule semantics: every rule
// must be met unless ANY is set (one suffices); "block" entries never
// complete; UNLOCK rules consult lockerdata (t must be 2, not 1).

export function evaluateAchievement(entry, stats, lockerdata = {}) {
  if (!entry || entry.block) return { done: false, blocked: true };
  let fail = false;
  let anyHit = false;
  for (const [rule, threshold] of Object.entries(entry.rules || {})) {
    if (rule === "UNLOCK") {
      const locker = lockerdata?.[entry.rules.UNLOCK];
      if (!locker || locker.t === 1) fail = true;
    } else if (Number(threshold) > (Number(stats?.[rule]) || 0)) {
      fail = true;
      if (!entry.ANY) break;
    } else if (entry.ANY) {
      anyHit = true;
      break;
    }
  }
  return { done: entry.ANY ? anyHit : !fail, blocked: false };
}

// Human-readable rule descriptions derived from the rule keys themselves
// (there are no localization strings for achievements in english.json).
const ACHIEVEMENT_RULE_TEXT = {
  thlevel: (v) => `Reach Town Hall level ${v}`,
  upgrade_champ1: () => "Fully evolve Gorgo",
  upgrade_champ2: () => "Fully evolve Drull",
  upgrade_champ3: () => "Fully evolve Fomor",
  map2: () => "Join Map Room 2",
  wmoutpost: (v) => `Take over ${v} wild monster tribe${v > 1 ? "s" : ""}`,
  playeroutpost: (v) => `Take over ${v} player outpost${v > 1 ? "s" : ""}`,
  hugerage: () => "Trigger a huge rage",
  wm2hall: () => "Destroy a tribe hall",
  monstersblended: (v) => `Blend ${v} monsters in the Flinger`,
  blocksbuilt: (v) => `Build ${v} blocks`,
  starterkit: () => "Buy the starter kit",
  alliance: () => "Join an alliance",
  stockpile: () => "Fill every resource stockpile",
  heavytraps: (v) => `Arm ${v} heavy traps`,
  unlock_monster: () => "Unlock a locker monster",
  DESCENT_LEVEL: (v) => `Reach Inferno descent level ${v}`,
  UNDERHALL_LEVEL: (v) => `Reach Under Hall level ${v}`,
  INFERNO_QUESTS_COMPLETED: (v) => `Complete ${v} Inferno quests`,
  UNLOCK: (v) => `Unlock ${v}`,
};

export function describeAchievement(entry) {
  const parts = Object.entries(entry?.rules || {}).map(([rule, value]) =>
    (ACHIEVEMENT_RULE_TEXT[rule] || ((v) => `${rule} \u2265 ${v}`))(value),
  );
  return parts.join(entry?.ANY ? " OR " : " and ") || "\u2014";
}

// ── Guardians / Champions (CHAMPIONCAGE._guardians, verbatim tables) ────
export const GUARDIANS = {
 "G1": {
  "name": "Gorgo",
  "props": {
   "speed": [
    1,
    1.2,
    1.4,
    1.6,
    1.8,
    2
   ],
   "health": [
    40000,
    80000,
    120000,
    140000,
    160000,
    200000
   ],
   "healtime": [
    3600,
    7200,
    14400,
    28800,
    57600,
    115200
   ],
   "range": [
    35,
    45,
    55,
    65,
    70,
    70
   ],
   "damage": [
    1000,
    1200,
    1500,
    2000,
    2500,
    3000
   ],
   "feedShiny": [
    26,
    44,
    75,
    111,
    136
   ],
   "evolveShiny": [
    158,
    530,
    1358,
    2664,
    4076
   ],
   "feedCount": [
    3,
    6,
    9,
    12,
    15
   ],
   "feedTime": [
    82800
   ],
   "buffs": [
    0
   ],
   "bucket": [
    240
   ],
   "offset_x": [
    -48,
    -38,
    -42,
    -52,
    -54,
    -46
   ],
   "offset_y": [
    -38,
    -36,
    -52,
    -82,
    -98,
    -80
   ],
   "bonusSpeed": [
    0.1,
    0.2,
    0.4
   ],
   "bonusHealth": [
    12500,
    27500,
    50000
   ],
   "bonusRange": [
    0,
    0,
    0
   ],
   "bonusDamage": [
    150,
    330,
    600
   ],
   "bonusBuffs": [
    0,
    0,
    0
   ],
   "bonusFeedShiny": [
    136,
    136,
    136
   ],
   "bonusFeedTime": [
    86400
   ],
   "targetGroup": [
    0
   ]
  }
 },
 "G2": {
  "name": "Drull",
  "props": {
   "speed": [
    2,
    2.2,
    2.5,
    2.8,
    3.2,
    3.6
   ],
   "health": [
    12000,
    20000,
    36000,
    42000,
    52000,
    60000
   ],
   "healtime": [
    3600,
    7200,
    14400,
    28800,
    57600,
    115200
   ],
   "range": [
    35,
    45,
    55,
    65,
    85,
    90
   ],
   "damage": [
    3000,
    3600,
    4200,
    5500,
    6500,
    8000
   ],
   "feedShiny": [
    26,
    44,
    75,
    105,
    131
   ],
   "evolveShiny": [
    158,
    530,
    1358,
    2530,
    3918
   ],
   "feedCount": [
    3,
    6,
    9,
    12,
    15
   ],
   "feedTime": [
    82800
   ],
   "buffs": [
    0
   ],
   "bucket": [
    180
   ],
   "offset_x": [
    -32,
    -38,
    -52,
    -56,
    -64,
    -70
   ],
   "offset_y": [
    -28,
    -36,
    -50,
    -52,
    -68,
    -76
   ],
   "bonusSpeed": [
    0.1,
    0.2,
    0.4
   ],
   "bonusHealth": [
    2500,
    5500,
    10000
   ],
   "bonusRange": [
    0,
    0,
    0
   ],
   "bonusDamage": [
    400,
    880,
    1600
   ],
   "bonusBuffs": [
    0,
    0,
    0
   ],
   "bonusFeedShiny": [
    131,
    131,
    131
   ],
   "bonusFeedTime": [
    86400
   ],
   "targetGroup": [
    0
   ]
  }
 },
 "G3": {
  "name": "Fomor",
  "props": {
   "speed": [
    1.2,
    1.4,
    2,
    2.1,
    2.2,
    2.3
   ],
   "health": [
    15000,
    17500,
    20000,
    22500,
    25000,
    40000
   ],
   "healtime": [
    3600,
    7200,
    14400,
    28800,
    57600,
    115200
   ],
   "range": [
    140,
    140,
    180,
    190,
    200,
    210
   ],
   "damage": [
    70,
    80,
    90,
    100,
    110,
    120
   ],
   "feedShiny": [
    26,
    45,
    62,
    76,
    96
   ],
   "evolveShiny": [
    154,
    537,
    1116,
    1822,
    2891
   ],
   "feedCount": [
    3,
    6,
    9,
    12,
    15
   ],
   "feedTime": [
    82800
   ],
   "buffs": [
    0.1,
    0.2,
    0.3,
    0.4,
    0.5,
    0.6
   ],
   "bucket": [
    200
   ],
   "offset_x": [
    -20,
    -38,
    -52,
    -56,
    -60,
    -58
   ],
   "offset_y": [
    -21,
    -36,
    -50,
    -52,
    -68,
    -98
   ],
   "bonusSpeed": [
    0.1,
    0.2,
    0.4
   ],
   "bonusHealth": [
    1000,
    2200,
    4000
   ],
   "bonusRange": [
    3,
    6,
    10
   ],
   "bonusDamage": [
    3,
    6,
    10
   ],
   "bonusBuffs": [
    0.03,
    0.06,
    0.15
   ],
   "bonusFeedShiny": [
    96,
    96,
    96
   ],
   "bonusFeedTime": [
    86400
   ],
   "targetGroup": [
    0
   ]
  }
 },
 "G4": {
  "name": "Korath",
  "props": {
   "speed": [
    1.4,
    1.6,
    1.8,
    2,
    2.3,
    2.5
   ],
   "health": [
    28000,
    62000,
    96000,
    120000,
    144000,
    175000
   ],
   "healtime": [
    3600,
    7200,
    14400,
    28800,
    57600,
    115200
   ],
   "range": [
    35,
    45,
    55,
    60,
    65,
    65
   ],
   "damage": [
    2000,
    2400,
    3000,
    3800,
    5000,
    6500
   ],
   "feedShiny": [
    26,
    44,
    75,
    111,
    136
   ],
   "evolveShiny": [
    158,
    530,
    1358,
    2664,
    4076
   ],
   "feedCount": [
    3,
    6,
    9,
    12,
    15
   ],
   "feedTime": [
    82800
   ],
   "buffs": [
    0
   ],
   "bucket": [
    200
   ],
   "offset_x": [
    -36,
    -61,
    -52,
    -62,
    -81,
    -70
   ],
   "offset_y": [
    -35,
    -49,
    -70,
    -95,
    -126,
    -130
   ],
   "bonusSpeed": [
    0.1,
    0.2,
    0.4
   ],
   "bonusHealth": [
    1000,
    2200,
    4000
   ],
   "bonusRange": [
    0,
    0,
    0
   ],
   "bonusDamage": [
    300,
    600,
    1000
   ],
   "bonusBuffs": [
    0
   ],
   "bonusFeedShiny": [
    96,
    96,
    96
   ],
   "bonusFeedTime": [
    86400
   ],
   "targetGroup": [
    0
   ]
  }
 },
 "G5": {
  "name": "Krallen",
  "props": {
   "speed": [
    2.2,
    2.3,
    2.4,
    2.5,
    2.6
   ],
   "health": [
    50000,
    52000,
    54000,
    58000,
    62000
   ],
   "healtime": [
    7200,
    14400,
    28800,
    57600,
    115200
   ],
   "range": [
    35,
    45,
    55,
    60,
    65
   ],
   "damage": [
    800,
    850,
    900,
    1000,
    1200
   ],
   "feedShiny": [
    26,
    44,
    75,
    111,
    136
   ],
   "evolveShiny": [
    158,
    530,
    1358,
    2664
   ],
   "feedCount": [
    3,
    6,
    9,
    12,
    15
   ],
   "feedTime": [
    82800
   ],
   "buffs": [
    0.2,
    0.22,
    0.24,
    0.27,
    0.3
   ],
   "buffRadius": [
    250,
    275,
    300,
    325,
    350
   ],
   "bucket": [
    200
   ],
   "offset_x": [
    -64,
    -61,
    -52,
    -52,
    -52
   ],
   "offset_y": [
    -50,
    -60,
    -72,
    -72,
    -72
   ],
   "bonusSpeed": [
    0,
    0,
    0
   ],
   "bonusHealth": [
    0,
    0,
    0
   ],
   "bonusRange": [
    0,
    0,
    0
   ],
   "bonusDamage": [
    0,
    0,
    0
   ],
   "bonusBuffs": [
    0
   ],
   "bonusFeedShiny": [
    96,
    96,
    96
   ],
   "bonusFeedTime": [
    86400
   ],
   "targetGroup": [
    0
   ]
  }
 }
};

export const CHAMPION_STATUS = {
  0: "Normal", 1: "Frozen", 2: "Juiced", 3: "Destroyed", 4: "Refunded", 5: "Migrated",
}; // ChampionBase.k_CHAMPION_STATUS_*

/**
 * BASE.as champion import, ported exactly: array of {t,nm,ft,fd,l,hp,fb,pl,
 * status}; dedupe by t; defaults fd=0, l=0, hp=0, fb=0, pl=0, status=0 when
 * not an int; for non-Krallen (t != 5), only the FIRST normal-status champion
 * stays unfrozen — later normals are forced FROZEN (the unfrozenFound rule).
 */
export function parseChampions(raw) {
  const arr = Array.isArray(raw) ? raw : (typeof raw === "string" ? (() => { try { return JSON.parse(raw) || []; } catch { return []; } })() : []);
  const seen = new Set();
  const out = [];
  let unfrozenFound = false;
  for (const entry of arr) {
    if (!entry || !entry.t || seen.has(entry.t)) continue;
    seen.add(entry.t);
    const champ = {
      t: Number(entry.t),
      nm: entry.nm || null,
      ft: Number(entry.ft) || 0,
      fd: Number(entry.fd) || 0,
      l: Number(entry.l) || 0,
      hp: Number(entry.hp) || 0,
      fb: Number(entry.fb) || 0,
      pl: Number(entry.pl) || 0,
      status: Number.isInteger(entry.status) ? entry.status : 0,
    };
    if (champ.t !== 5) {
      if (unfrozenFound && champ.status === 0) champ.status = 1; // forced FROZEN
      else if (!unfrozenFound && champ.status === 0) unfrozenFound = true;
    }
    out.push(champ);
  }
  return out;
}

export function guardianInfo(t) {
  return GUARDIANS["G" + t] || null;
}

/**
 * Player.fillMonsterData, ported exactly. monsters.housed values are either
 * plain counts (legacy) or arrays of {health, ownerID, q} per creep
 * (map-room-3 saves; detected by the first non-Number value). "Q" carries
 * the heal queue. C100 is remapped to C12.
 */
export function parseHoused(housedRaw) {
  const housed = housedRaw && typeof housedRaw === "object" ? housedRaw : {};
  let arrayFormat = false;
  for (const key of Object.keys(housed)) {
    if ((key[0] === "C" || key.slice(0, 2) === "IC") && key !== "Q") {
      if (housed[key] != null && typeof housed[key] !== "number") { arrayFormat = true; break; }
    }
  }
  const list = [];
  for (const rawKey of Object.keys(housed)) {
    if (rawKey === "Q") continue;
    if (rawKey[0] !== "C" && rawKey.slice(0, 2) !== "IC") continue;
    const value = housed[rawKey];
    let count = 0;
    let creeps = null;
    if (arrayFormat) {
      if (value == null) continue;
      creeps = Array.isArray(value)
        ? value.map((c) => ({ health: Number(c?.health) || 0, ownerID: c?.ownerID ?? null, q: Number(c?.q) || 0 }))
        : [];
      count = creeps.length;
    } else {
      count = Number(value) || 0;
    }
    if (!count) continue;
    const key = rawKey === "C100" ? "C12" : rawKey;
    list.push({ id: key, count, creeps });
  }
  const healQueue = Array.isArray(housed.Q) ? housed.Q.slice() : [];
  return { list, healQueue, arrayFormat };
}

/**
 * Player.importAcademyData time rule: values up to 162h (583200s) are
 * RELATIVE remaining seconds (converted to now + time at load); larger
 * values are absolute epochs. `loadedAt` is the moment the base data
 * arrived (BASE load's GLOBAL.Timestamp()).
 */
export function academyFinishEpoch(rawTime, loadedAt) {
  const t = Number(rawTime) || 0;
  if (!t) return 0;
  return t <= 60 * 60 * 162 ? loadedAt + t : t;
}

// ── Creep/champion sprite sheets (SPRITES.as Setup, verbatim) ───────────
// SpriteData(file, cellW, cellH, midX, midY): cells are pre-rotated
// directional frames; mid is the registration point within a cell.
// Regular creeps: 30 directions (angle / 12), row 0 (SPRITES.GetSprite
// fallback). Champions: 16 directions (angle / 22.5) with walk-cycle rows.
export const CREEP_SPRITES = {
  C1:  ["monsters/sprite.1.v1.png", 24, 21, 8, 14],
  C2:  ["monsters/octoooze.png", 39, 28, 19, 15],
  C3:  ["monsters/sprite.3.v2.png", 30, 28, 7, 20],
  C4:  ["monsters/fink.png", 34, 32, 15, 21],
  C5:  ["monsters/eyera.png", 26, 23, 11, 15],
  C6:  ["monsters/ichi.png", 27, 26, 11, 17],
  C7:  ["monsters/bandito.png", 29, 28, 11, 17],
  C8:  ["monsters/fang.png", 34, 31, 16, 19],
  C9:  ["monsters/brain.v2.png", 34, 24, 16, 13],
  C10: ["monsters/crabatron.png", 37, 27, 15, 18],
  C11: ["monsters/sprite.11.v2.png", 48, 35, 24, 22],
  C12: ["monsters/sprite.12.v2.png", 53, 46, 21, 27],
  C13: ["monsters/13.png", 40, 26, 19, 17],
  C14: ["monsters/14.v1.png", 28, 28, 15, 14],
  C15: ["monsters/zafreeti.v2.png", 56, 70, 28, 35],
  C16: ["monsters/vorg_anim.png", 40, 40, 26, 36],
  C17: ["monsters/slimeattikus_anim.png", 48, 31, 26, 15],
  C18: ["monsters/slimeattikusmini_anim.png", 30, 20, 15, 11],
  C19: ["monsters/rezghul.png", 48, 43, 26, 36],
  IC1: ["monsters/spurtz.png", 24, 28, 12, 14],
  IC2: ["monsters/zagnoid.png", 64.4, 46, 26, 28],
  IC3: ["monsters/malphus.png", 51, 35, 25, 17],
  IC4: ["monsters/valgos.png", 55, 32, 11, 15],
  IC5: ["monsters/balthazar.png", 56, 37, 33, 18.5],
  IC6: ["monsters/grokus.v2.png", 57, 39, 28, 20],
  IC7: ["monsters/sabnox.png", 42, 34, 21, 17],
  IC8: ["monsters/wormzer.png", 58, 42, 29, 21],
};

// Guardian sheets are per evolution level (G5 Krallen has three).
const GUARDIAN_SHEETS = {
  1: [["monsters/ape_1.png",96,69,26,36],["monsters/ape_2.png",89,73,26,36],["monsters/ape_3.png",103,88,26,36],["monsters/ape_4.png",148,127,26,36],["monsters/ape_5.png",160,137,26,36],["monsters/ape_6.png",140,120,26,36]],
  2: [["monsters/dragon_1.png",64,41,26,36],["monsters/dragon_2.png",87,58,26,36],["monsters/dragon_3.png",114,85,26,36],["monsters/dragon_4.png",131,93,26,36],["monsters/dragon_5.png",156,117,26,36],["monsters/dragon_6.png",171,125,26,36]],
  3: [["monsters/fly_1.png",53,40,26,36],["monsters/fly_2.png",63,46,26,36],["monsters/fly_3.png",98,81,26,36],["monsters/fly_4.png",120,92,26,36],["monsters/fly_5.png",133,105,26,36],["monsters/fly_6.png",124,105,26,36]],
  4: [["monsters/korath_1.png",72,49,26,36],["monsters/korath_2.png",119,81,26,36],["monsters/korath_3.png",128,102,26,36],["monsters/korath_4.png",153,123,26,36],["monsters/korath_5.png",199,162,26,36],["monsters/korath_6.png",202,167,26,36]],
  5: [["monsters/krallen_1_rev_65.png",130,80,65,40],["monsters/krallen_2_rev_65.png",131,90,65,45],["monsters/krallen_3_rev_65.png",142,100,71,50]],
};

export function guardianSheet(t, level) {
  const sheets = GUARDIAN_SHEETS[t];
  if (!sheets) return null;
  const idx = Math.min(Math.max(1, level), sheets.length) - 1;
  return sheets[idx];
}

/**
 * Every sheet that could stand in for a guardian at this level, best first:
 * the exact evolution, then lower evolutions, then higher ones. Some asset
 * hosts are missing individual evolution sheets (observed: korath_5.png
 * 404s upstream); falling back to a neighbouring evolution shows the right
 * champion with slightly-off art instead of an invisible one. Each entry
 * carries its own frame size and anchor, so the fallback still draws
 * correctly rather than smearing the requested level's geometry.
 */
export function guardianSheetCandidates(t, level) {
  const sheets = GUARDIAN_SHEETS[t];
  if (!sheets) return [];
  const idx = Math.min(Math.max(1, Number(level) || 1), sheets.length) - 1;
  const order = [idx];
  for (let i = idx - 1; i >= 0; i--) order.push(i);
  for (let i = idx + 1; i < sheets.length; i++) order.push(i);
  return order.map((i) => sheets[i]).filter(Boolean);
}

/**
 * Guardian walk-cycle row (SPRITES.GetSprite): frame advances every 8
 * ticks. G1/G2/G3: idle row 0, walking rows 1..7. G4: walking rows 0..8
 * (levels 1-3) or 0..9 (levels 4+). G5: rows 0..9 for idle and walking.
 */
const GUARDIAN_ANIM_DIVISOR = 4;

export function guardianRow(t, level, moving, tick) {
  // Champion sheets are the MovieClip's frames laid out as rows. The game
  // advances them with ENTER_FRAME; at the viewer's 40-step second a divisor
  // of 4 gives ~10 rows/sec, which matches the in-game walk cadence. (8 was
  // half that and read as sluggish.)
  const step = Math.floor(tick / GUARDIAN_ANIM_DIVISOR);
  if (t === 5) return step % 10;
  if (t === 4) return step % (level > 3 ? 10 : 9);
  return moving ? (step % 7) + 1 : 0;
}
