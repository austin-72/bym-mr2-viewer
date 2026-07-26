import {
  MR2,
  buildBymUrl,
  buildSessionPayload,
  extractErrorMessage,
  fetchJson,
  getViewerConfig,
  normalizeApiVersion,
  parseJsonPayload,
} from "./shared.js";

/**
 * Outbound call priority for the shared, server-scheduled BYM API budget.
 * 1 = lowest, 10 = highest; higher priorities are sent upstream first when
 * the budget is contended. Zone fetches carry a computed score instead (see
 * MapRenderer.zonePriorityFor).
 *
 * The tiers mean something specific, which is what keeps them useful:
 *
 *   10  someone is watching a spinner for THIS request. Reserved for
 *       user-initiated work, and unreachable by the server's aging, so a
 *       clicked base is never queued behind accumulated map traffic.
 *    9  session bootstrap and opened panels - blocking, but not a click.
 *    8  and below: map streaming, ordered by how much the player cares.
 *
 * Own-main-yard zones used to sit at 10 alongside /base/load, so a routine
 * refresh of your own zone competed head-to-head with a base you had just
 * opened and won on arrival order. They are 9 now.
 */
export const FETCH_PRIORITY = {
  init: 10,          //  POST /init
  getinfo: 10,       //  POST /api/{v}/player/getinfo (login / session)
  baseLoad: 10,      //  POST /base/load
  getNewMap: 10,     //  POST /api/{v}/bm/getnewmap (map bootstrap)
  zoneReload: 10,    //  a zone the player explicitly asked to refresh
  worlds: 9,         //  GET  /api/{v}/worlds
  leaderboards: 9,   //  GET  /api/{v}/leaderboards
  lowest: 1,
};

// Zone fetches at or above this bypass the client-side pacer entirely. Now
// that own-main-yard zones score 9, this threshold covers them and the
// explicit reloads at 10 - previously nothing but 10 could reach it.
export const ZONE_PACER_BYPASS_PRIORITY = 9;

// Client-side anti-starvation, mirroring the server's. Without it a zone can
// clear the server gate's aging only to sit behind newer, higher-tier zones
// in the browser's own pacer. Same ceiling: aging never manufactures an
// interactive-tier request.
export const PACER_AGE_STEP_MS = 4000;
export const PACER_AGE_CEILING = 8;

export function agedPriority(base, waitingSinceMs, now = Date.now()) {
  const tier = Number(base) || 1;
  if (tier >= PACER_AGE_CEILING) return tier;
  const steps = Math.floor(Math.max(0, now - waitingSinceMs) / PACER_AGE_STEP_MS);
  return Math.min(PACER_AGE_CEILING, tier + steps);
}

export class ApiClient {
  constructor(config = getViewerConfig()) {
    this.config = config;
    this.zoneRequestTimestamps = [];
    // Session-recovery hooks, wired by the app. getCurrentToken() reports the
    // token the app believes is live; refreshSession() mints a fresh one
    // (single-flight) and returns it.
    this.getCurrentToken = null;
    this.refreshSession = null;
    // Priority-ordered waiters for the zone-request pacer.
    this.zoneWaiters = new Set();
    this.zoneWaiterSeq = 0;
  }

  async getConfig() {
    return this.config;
  }

  async resolveApiVersion() {
    const probeVersion = "__viewer_probe__";
    const probeUrl = buildBymUrl(`/api/${probeVersion}/player/getinfo`);

    try {
      await fetchJson(probeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          "X-Fetch-Priority": String(FETCH_PRIORITY.getinfo),
        },
        body: new URLSearchParams({
          sessionType: "game",
        }),
      });
    } catch (error) {
      const fromProbe = this.extractApiVersion(error?.message || "");
      if (fromProbe) {
        return fromProbe;
      }
    }

    try {
      const response = await fetch(buildBymUrl("/init"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Fetch-Priority": String(FETCH_PRIORITY.init),
        },
        body: JSON.stringify({}),
      });
      const payload = parseJsonPayload(await response.text());
      const fromInit = this.extractApiVersion(extractErrorMessage(payload) || "");
      if (fromInit) {
        return fromInit;
      }
    } catch (error) {
      void error;
    }

    return normalizeApiVersion(this.config.apiVersion);
  }

  async login(email, password) {
    const loginResponse = await fetchJson(this.buildApiUrl("/player/getinfo"), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        "X-Fetch-Priority": String(FETCH_PRIORITY.getinfo),
      },
      body: new URLSearchParams({
        email,
        password,
        sessionType: "game",
      }),
    });

    return this.buildSession(loginResponse);
  }

  async refresh(token) {
    const loginResponse = await fetchJson(this.buildApiUrl("/player/getinfo"), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        "X-Fetch-Priority": String(FETCH_PRIORITY.getinfo),
      },
      body: new URLSearchParams({
        token,
        sessionType: "game",
      }),
    });

    return this.buildSession(loginResponse);
  }

  async buildSession(loginResponse) {
    const mapMeta = await this.getMapMeta(loginResponse.token);
    if (mapMeta?.newmap === true) {
      throw new Error(
        "This account is currently on a Map Room 3 world. Use the MR3 viewer instead, or migrate the account to an MR2 world.",
      );
    }

    // `/base/load` (default mode) can fail in edge cases, e.g. while the
    // player's base is under attack. The viewer can still work without it;
    // it just loses the home marker and outpost list until the next login.
    let baseData = {};
    try {
      baseData = await this.getBaseData(loginResponse.token, loginResponse);
    } catch (error) {
      console.warn("Failed to load base data; continuing without home coordinates.", error);
    }

    return buildSessionPayload(loginResponse, baseData);
  }

  /**
   * Runs a token-bearing call, recovering once from an invalidated session.
   *
   * The game's getinfo endpoint MINTS A NEW TOKEN and invalidates the old one
   * on every call, so any request already in flight (or queued) with the
   * previous token comes back 401 - which is exactly what a burst of zone
   * fetches does while the app refreshes its session in the background.
   *
   * Recovery is cheap in the common case: the app usually already holds the
   * rotated token, so we simply retry with it. Only when the failing token is
   * still the current one do we spend a getinfo call to mint a new one.
   */
  async withAuthRetry(token, run) {
    try {
      return await run(token);
    } catch (error) {
      const status = Number(error?.status);
      if (status !== 401 && status !== 403) {
        throw error;
      }
      let next = String(this.getCurrentToken?.() || "").trim();
      if (!next || next === token) {
        next = String((await this.refreshSession?.()) || "").trim();
      }
      if (!next || next === token) {
        throw error; // nothing newer to try with
      }
      return run(next); // one retry only
    }
  }

  async getWorlds() {
    return fetchJson(this.buildApiUrl("/worlds"), {
      headers: { "X-Fetch-Priority": String(FETCH_PRIORITY.worlds) },
    });
  }

  async getLeaderboard(worldId, mapVersion = 2) {
    return fetchJson(this.buildApiUrl("/leaderboards", {
      worldid: worldId,
      mapversion: mapVersion,
    }), { headers: { "X-Fetch-Priority": String(FETCH_PRIORITY.leaderboards) } });
  }

  // `/api/{v}/bm/getnewmap` reports `newmap: true` only for Map Room 3
  // players, which lets the viewer detect accounts that are not on MR2.
  async getMapMeta(token) {
    return this.withAuthRetry(token, (activeToken) => fetchJson(this.buildApiUrl("/bm/getnewmap"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${activeToken}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        "X-Fetch-Priority": String(FETCH_PRIORITY.getNewMap),
      },
      body: new URLSearchParams(),
    }));
  }

  // MR2 exposes no bulk map endpoint, so the player's own base save is the
  // source of truth for home coordinates, outposts, and the world size.
  async getBaseData(token, loginResponse) {
    return this.withAuthRetry(token, (activeToken) => fetchJson(buildBymUrl("/base/load"), {
      method: "POST",
      headers: {
        "X-Fetch-Priority": String(FETCH_PRIORITY.baseLoad),
        Authorization: `Bearer ${activeToken}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams({
        type: "build",
        userid: String(loginResponse?.userid ?? loginResponse?.userId ?? 0),
        baseid: "0",
      }),
    }));
  }

  // Fetches one Map Room 2 zone. The server returns cells for the inclusive
  // range [x, x + 10] x [y, y + 10] as a nested { x: { y: cell } } object.
  //
  // The worldmapv2 service scopes the request to the signed-in user and world
  // (the same way /base/load carries userid and /leaderboards carries worldid).
  // A Bearer header alone is accepted by /base/load but rejected here with
  // "Could not authenticate", so we additionally send the token in the body
  // (with sessionType) and the userid/worldid when known. Extra fields are
  // ignored by endpoints that don't need them; the Bearer header is retained.
  async getArea(token, zoneX, zoneY, scope = {}, priority = FETCH_PRIORITY.lowest) {
    // A top-priority zone (opening a base, or the player's own main yard) is
    // never delayed by the client-side pacer: it goes out immediately and is
    // not counted against the panning budget. Everything else waits its turn.
    if (Number(priority) < ZONE_PACER_BYPASS_PRIORITY) {
      await this.waitForZoneRequestSlot(priority);
    }

    const params = { x: String(zoneX), y: String(zoneY) };
    if (token) {
      params.token = token;
      params.sessionType = "game";
    }
    if (scope.userid !== undefined && scope.userid !== null && String(scope.userid) !== "") {
      params.userid = String(scope.userid);
    }
    if (scope.worldid !== undefined && scope.worldid !== null && String(scope.worldid) !== "") {
      params.worldid = String(scope.worldid);
    }

    return this.withAuthRetry(token, (activeToken) => {
      const attemptParams = { ...params };
      if (attemptParams.token) {
        attemptParams.token = activeToken;
      }
      return fetchJson(buildBymUrl("/worldmapv2/getarea"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${activeToken}`,
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          // The server schedules the shared BYM budget by this score.
          "X-Fetch-Priority": String(priority),
        },
        body: new URLSearchParams(attemptParams),
      });
    });
  }

  buildApiUrl(path, query = null) {
    // apiVersion is still part of the request path; the URL host is decided by
    // the backend proxy (see buildBymUrl), so no config host is passed here.
    return buildBymUrl(`/api/${this.config.apiVersion}${path}`, query);
  }

  /**
   * Client-side zone-request pacing, PRIORITY ORDERED.
   *
   * This used to be a strict FIFO promise chain: every caller awaited the
   * previously started one, so a priority-10 zone (opening a base viewer)
   * entering the gate behind a batch of panning fetches had to wait for all
   * of them - the server's priority scheduling never got a chance to matter,
   * because the request had not been sent yet. Waiters now queue in a set
   * and the highest priority one goes next; ties break by arrival order.
   */
  async waitForZoneRequestSlot(priority = 1) {
    const waiter = {
      priority: Number(priority) || 1,
      since: Date.now(),
      seq: this.zoneWaiterSeq++,
      wake: null,
    };
    waiter.ready = new Promise((resolve) => { waiter.wake = resolve; });
    this.zoneWaiters.add(waiter);

    const maxRequests = Math.max(1, Number(MR2.zoneRequestsPerMinute) || 1);
    const windowMs = Math.max(1, Number(MR2.zoneRequestWindowMs) || 60_000);

    try {
      while (true) {
        const now = Date.now();
        const cutoff = now - windowMs;
        this.zoneRequestTimestamps = this.zoneRequestTimestamps.filter(
          (startedAt) => startedAt > cutoff,
        );

        // Our turn only when nobody waiting outranks us, comparing AGED
        // priorities so a long-parked low-tier zone eventually goes.
        let best = waiter;
        let bestPriority = agedPriority(waiter.priority, waiter.since, now);
        for (const other of this.zoneWaiters) {
          const otherPriority = agedPriority(other.priority, other.since, now);
          if (otherPriority > bestPriority
            || (otherPriority === bestPriority && other.seq < best.seq)) {
            best = other;
            bestPriority = otherPriority;
          }
        }

        if (best === waiter && this.zoneRequestTimestamps.length < maxRequests) {
          this.zoneRequestTimestamps.push(now);
          return;
        }

        const oldest = this.zoneRequestTimestamps[0];
        const windowWaitMs = this.zoneRequestTimestamps.length >= maxRequests && oldest !== undefined
          ? Math.max(0, oldest + windowMs - now + 5)
          : 25; // outranked: re-check shortly, or as soon as a slot frees
        await Promise.race([
          new Promise((resolve) => globalThis.setTimeout(resolve, windowWaitMs)),
          waiter.ready,
        ]);
        waiter.ready = new Promise((resolve) => { waiter.wake = resolve; });
      }
    } finally {
      this.zoneWaiters.delete(waiter);
      // Nudge the remaining waiters so the next-highest re-evaluates at once.
      for (const other of this.zoneWaiters) other.wake?.();
    }
  }

  extractApiVersion(message) {
    const match = String(message || "").match(/Expected(?:\s+one\s+of)?:\s*([^,\s]+)/i);
    return match ? normalizeApiVersion(match[1]) : null;
  }
}
