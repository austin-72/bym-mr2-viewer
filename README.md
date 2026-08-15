# BYM MR2 Map Viewer

A community world-map viewer for **Backyard Monsters Refitted** (Map Room 2).
Explore the world map in your browser, track your bases, coordinate with your
alliance, and browse any world as a guest.

Runs on **Python 3.11+** with no dependencies — the server is stdlib-only —
and is designed to sit behind a **Cloudflare Tunnel** (see
[Hosting](#hosting-it-publicly)).

---

## Features

### The map

- **Pan and zoom** a full isometric world map, rendered from cached game data
  — including the real Map Room 2 **terrain**: land, sand and water tiles at
  their in-game heights, with bases sitting on their ground rather than
  floating above it. A **zoom slider** mirrors the game's own control.
- **Search** any explored base by username.
- **Filters** — by base type, tribe, level range, outpost count, and an
  inactivity filter that surfaces players who have not claimed new outposts
  in a given period.
- **Measure distance** between any two points, wrap-aware across the world edge.
- **Jump to coordinates**, or **copy a shareable link** to any cell.
- **Bookmarks** for the places you keep coming back to.
- **Cell inspector** — owner, level, empire value, damage, damage protection
  (with the game's protection bubble drawn on the map), truce state, flinger
  and catapult levels, stored resources, and when the area was last observed.
- **Battle logs** — where a base snapshot has been archived, a player's
  recent attack and defence logs open from their cell card.
- **Leaderboards** with **outposts-gained trends over 1, 7 and 30 days**,
  built from daily snapshots, and a **world picker** for browsing other
  worlds.

### Your bases

- **Base viewer** — open any yard, outpost, wild monster camp or **Inferno
  yard** and see it rendered with the real game sprites, read-only. Art is
  cached permanently, so each sprite is fetched from the game at most once
  ever.
- **Attack simulation (beta)** — a local, cosmetic recreation of attacking
  inside the base viewer: the game's attack HUD, flinger, catapult and siege
  panels, with tower targeting, damage and fire rates traced from the game
  client. Nothing talks to the game and nothing is saved; the viewer lists
  what is not implemented yet before your first sim.
- **Watchlist** — the zones around your main yard and outposts are checked
  against shared cache every 10 minutes, with a live check at most once an
  hour; auto-refresh can be toggled off. The game still sees you as offline
  and your main base stays attackable.
- **Activity feed** — outposts recently captured or lost, so you can see what
  changed while you were away.

### Alliances

- **Chat** with your alliance in the viewer.
- **Shared targets** your members can add and work from.
- **Activity feed** covering the whole alliance.
- **Members and invites**, with an invite-by-username flow.
- Allied bases are highlighted on the map and their zones refresh sooner.

### Guests

Anyone can browse **any world's cached snapshot** without signing in — no
account, no game credentials. Guests see the map, search, filters, and
profiles, but cannot contribute to the cache.

### Two ways to sign in

- **Password** — credentials go straight to the game server; the viewer
  keeps only the returned session token.
- **Token** — paste the session token your running game client already
  holds and the viewer rides the same session without ever rotating it, so
  signing in to the viewer no longer signs your game client out. A one-line
  copy-paste script (behind the **Copy script** button) pulls the token from
  the running game for you. This is a full session, identical to a password
  sign-in — it just skips typing the password.

### Renames are handled

BYM Refitted lets players rename their account. The viewer keys identity on
the game's immutable user id, so when a verified rename is seen, everything
stored under the old name — your viewer data, alliance membership, admin and
whitelist entries, hidden-player records and activity — follows you to the
new one automatically.

### Privacy for players

Players being targeted or harassed can **request to be hidden**. Once
approved, their bases are camouflaged on the map and excluded from search,
filters, profiles, and watch activity for normal users.

### Kind to the game servers

This is the part the viewer takes most seriously.

- **Shared cache.** Map data is fetched once and shared with everyone. When
  one person's viewer loads a zone, every other user reads it from cache.
- **Hard budget.** A server-side per-minute ceiling caps total game-API
  traffic across all users combined, with a per-user ceiling inside it so one
  person can never consume everyone's share.
- **Tiered freshness.** Zones near your own bases refresh often; distant
  wilderness refreshes at most daily. Remote areas may show data up to a day
  old, deliberately.
- **Priority scheduling.** Every outbound call is ranked 1–10 and the budget
  goes to the most important work first.
- **No hammering, ever.** However many people use the viewer, the load it
  places on the game stays bounded.

### For administrators

Two consoles. `/setup/` covers hidden-player moderation and hiding requests,
a **sign-in whitelist**, alliance and administrator management, a
**manual rename tool**, an announcement banner, cache and user overviews, a
full audit log, and a live **API Budget, Limits & Stats** panel where every
limit can be retuned without a restart. `/setup/ops` is the **operator
console**: a live request log, top talkers, honeypot auto-bans, a rate-limit
bucket inspector, and session/token-cache views — see
[Operator console](#operator-console-setupops).

---

## Quick start

The server only answers requests that arrived through a Cloudflare Tunnel
(see [The tunnel requirement](#the-tunnel-requirement)), so even a local test
needs `cloudflared` in front:

```
python dev_server.py
cloudflared tunnel --url http://127.0.0.1:8080
```

Open the `trycloudflare.com` URL that `cloudflared` prints. Sign in with your
game credentials (or token), or browse cached worlds as a guest.
`http://localhost:8080/api/health` still works directly, for shell and
container health checks.

On Windows, `start.bat` launches the server with every setting documented in
one place and restarts it if it exits.

To reach the admin consoles, start with your in-game username on the admin
list:

```
BYM_ADMIN_USERS=YourName python dev_server.py
```

> **Note on storage.** `STORAGE_DIR` defaults to the directory containing
> `dev_server.py`, so a plain run creates `server_*/`, `imagecache/`,
> `users/`, `admin/`, `alliances/`, `logs/`, `metrics/` and `baseloads/`
> alongside the code. `start.bat` points it at `./storage` instead, which
> keeps the same trees one level down. Both layouts are covered by
> `.gitignore`, but for anything beyond a quick test point `STORAGE_DIR` at a
> directory outside the repository — the zone cache and logs hold player
> data.

---

## Configuration

Everything is set through environment variables. Values marked
*admin-tunable* can also be changed live in `/setup/` without restarting; the
environment variable only sets the starting value.

### Server

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Loopback by default: the tunnel connects over it, and binding anywhere else would let the internet reach the server directly — which would also make `CF-Connecting-IP` spoofable and every ban trivially evadable. Override only for a deliberately LAN-exposed dev box. |
| `PORT` | `8080` | Listen port. |
| `STORAGE_DIR` | *(directory of `dev_server.py`)* | All persistent data: map cache, image cache, alliances, users, admin. |
| `STATIC_DIR` | `app/static` | Location of the front-end files. |

### Game API

| Variable | Default | Purpose |
|---|---|---|
| `BYM_BASE_URL` | `https://server.bymrefitted.com` | Base URL of the BYM Refitted API. |
| `BYM_API_VERSION` | *(unset — auto)* | The API path embeds the game version. Left unset, the server reads `currentGameVersion` from the CDN manifest exactly as the official launcher does, re-checked hourly, so a game release no longer 404s the viewer. Set this only to pin a version for testing. |
| `BYM_VERSION_MANIFEST` | `cdn.bymrefitted.com/versionManifest.json` | Where the version is discovered. On failure the last known good value is reused, then a built-in fallback. |
| `BYM_ASSETS_BASE_URL` | *(unset)* | Overrides where game art is fetched. Unset, the cache tries `https://cdn.bymrefitted.com` first — the CDN the game client itself uses — then falls back to `BYM_BASE_URL`, which mirrors most but not all of the same tree. |
| `BYM_USER_AGENT` | `BYM-MR2-Viewer/1.0 …` | Outbound User-Agent, so the API maintainer can identify viewer traffic. |

### Budget and queueing

| Variable | Default | Purpose |
|---|---|---|
| `BYM_MAX_API_PER_MINUTE` | `30` | Global ceiling on outbound game-API calls, all users combined. *Admin-tunable.* |
| `BYM_MAX_API_PER_MINUTE_PER_USER` | `10` | Per-user ceiling inside the global budget. *Admin-tunable.* |
| `BYM_MAX_LOW_PER_MINUTE_PER_USER` | `5` | Band ceiling for priorities 1–5 inside the per-user allowance. *Admin-tunable.* |
| `BYM_MAX_MEDIUM_PER_MINUTE_PER_USER` | `3` | Band ceiling for priorities 6–8 inside the per-user allowance. *Admin-tunable.* |
| `BYM_MAX_QUEUE_DEPTH` | `200` | Maximum requests parked waiting for budget. Each holds a server thread; beyond this, callers get an immediate 429 with `Retry-After`. *Admin-tunable.* |
| `BYM_MAX_QUEUE_DEPTH_PER_USER` | `40` | Per-user bound within that queue. *Admin-tunable.* |
| `BYM_MAX_WAIT_SECONDS` | `600` | Longest a queued request may wait before giving up with a 429. *Admin-tunable.* |
| `BYM_FULL_MAP_CONCURRENCY` | `8` | How many unfiltered full-world cache reads may run at once. Excess requests wait briefly, then get a 503 with `Retry-After`. *Admin-tunable.* |

### Behaviour and privacy

| Variable | Default | Purpose |
|---|---|---|
| `BYM_MAX_MAP_SIZE` | `800` | World edge length in cells. Zone writes outside `0..size-1` are rejected. |
| `BYM_HIDDEN_TILE_STYLE` | `tribe` | How hidden players' bases render for everyone else: `tribe` replaces the cell with the wild monster camp that coordinate would generate; `water` renders a water hex. (`blend` is the old name for `tribe` and is still accepted.) |
| `BYM_ADMIN_USERS` | *(empty)* | Comma-separated in-game usernames allowed into `/setup/`. Seeds `admin/admins.json` on first run only; after that, edit the file or use the console. |
| `BYM_WHITELIST_MESSAGE` | *(built-in text)* | Message shown to a player refused by the sign-in whitelist. |
| `BYM_API_LOG` | `errors` | API-call logging. A comma/space list of categories: `auth`, `map`, `base`, `meta`, `other`, plus `errors` (failed calls only — the usual repro setting), `all` and `off`. |
| `BYM_API_LOG_MAX_BODY` | `200000` | Maximum response body size recorded per logged call. |
| `BYM_API_LOG_TOKENS` | *(unset)* | Session tokens, JWTs, the account email and passwords are **redacted from the API log by default** — the token *is* the credential, and logs get shared exactly when that leaks. Set to `1` only when a reproduction genuinely needs the original token, then turn it back off. |

### The viewer's own rate limits

Separate from the game-API budget. Signed-in users get 90 req/min (burst 30)
each, unauthenticated visitors 60 req/min (burst 20) per IP, and `/log`
10 req/min per IP — all *admin-tunable*. Excess requests receive a 429 with
`Retry-After`. Visitor limits are keyed on the real client address from
`CF-Connecting-IP`, so everyone arriving through the tunnel no longer shares
one loopback bucket; the offending user or IP is printed to the journal.

Logs land in `STORAGE_DIR/logs/`, one UTC-dated file per day, deleted
automatically after 14 days.

---

## The tunnel requirement

Everything reaching this server is expected to arrive through a
**Cloudflare Tunnel** terminating on loopback:

- A request whose peer is not loopback is refused outright — `HOST` should
  have prevented it existing at all.
- A loopback request with no `CF-Connecting-IP` header did not cross
  Cloudflare's edge — it is a local scanner or stray process, not tunnel
  traffic — and is refused too. The only exceptions are `/api/health` and
  `/health`, so shell and container health checks keep working.
- `CF-Connecting-IP` is trusted *only because* the peer is loopback and the
  only thing on loopback is the tunnel. That real address is what rate
  limits, bans and the request log are keyed on.

This runs before any other work on every request, together with the ban and
honeypot checks below, so a banned scanner costs a dictionary lookup rather
than a file read or an upstream call.

**Honeypots and bans.** Paths only a scanner would ask for — `/.env`,
`/.git`, `/wp-admin`, `/phpmyadmin` and friends, plus any patterns added in
the console — draw an escalating ban: 60 minutes, doubling per strike, capped
at a week by default, with strikes forgotten after a week so a reassigned
address eventually starts clean. Bans persist across restarts. **Enforcement
ships off** (`honeypotBansEnabled`, dry-run: hits are recorded and the term
that *would* apply is logged) — turn it on from `/setup/ops` once you have
watched it for a while. Loopback itself can never be banned, so a mistake
here cannot take the tunnel — and the whole site — down.

---

## How outbound calls are scheduled

Calls for game art are **never rate limited** — each file is fetched once,
then served from disk forever.

Calls to the game API share a per-minute budget and are scheduled by
priority, **1 = lowest, 10 = highest**. Higher priorities go first when the
budget is contended.

| Call | Priority |
| --- | --- |
| `POST /init` | 10 |
| `POST /api/{version}/player/getinfo` | 10 |
| `POST /base/load` | 10 |
| `POST /worldmapv2/getarea` — opening a base viewer | 10 |
| `POST /api/{version}/bm/getnewmap` | 10 |
| `GET /api/{version}/worlds` | 9 |
| `GET /api/{version}/leaderboards` | 9 |
| `POST /worldmapv2/getarea` — zone of your main yard | 9 |
| `POST /worldmapv2/getarea` — zones of your outposts | 8 |
| `POST /worldmapv2/getarea` — zones holding allied bases | 7 |
| `POST /worldmapv2/getarea` — within 2 zones of your bases | 6 |
| `POST /worldmapv2/getarea` — within 2 zones of allied bases | 5 |
| `POST /worldmapv2/getarea` — within 4 zones of your bases | 4 |
| `POST /worldmapv2/getarea` — within 4 zones of allied bases | 3 |
| `POST /worldmapv2/getarea` — within 6 zones of your or allied bases | 2 |
| `POST /worldmapv2/getarea` — any other zone | 1 |

Priority travels in the `X-Fetch-Priority` header, is clamped to 1–10, and
defaults to 1 when absent. Zone distances are counted in zones and are
wrap-aware.

Tier 10 is reserved for requests a person is actively waiting on, which is why
a background refresh of your own main-yard zone sits at 9 — it must never land
in front of a base you just clicked.

**Priority bands.** Each user's per-minute allowance carries two further
ceilings, so background panning cannot spend the whole thing: low covers
priorities 1–5, medium covers 6–8, and 9–10 have no band ceiling of their own.
A call must clear both the per-user total and its band. Keep low + medium below
the per-user figure and the difference is budget nothing under priority 9 can
reach.

**Sign-in reserve.** Token verification is never queued — a saturated budget
must not lock anyone out of signing in — so the queue runs on the global limit
minus a small reserve rather than letting those calls overshoot it.

**Anti-starvation.** A waiter's effective priority climbs one step every eighth
of the maximum wait, capped below the interactive tiers. Background work
overtakes other background work as it ages, but never a click.

See the commit history for what changed in each release.

## Usage history

Outbound-call counters roll up hourly into `storage/metrics/usage-YYYY-MM-DD.json`,
flushed every 15 seconds and on shutdown, and reloaded at startup so figures
survive a restart. The admin console reports any UTC day range — totals, per
day, per priority band, per category, busiest hours, and per caller — and
exports the same data as CSV or JSON. Retention is `metricsRetentionDays`
(default 30); older day files are deleted at startup. Roughly 20–40 KB per day.

**Scheduling is strict priority.** Higher priorities always go first, and
low-priority wilderness zones wait — and eventually give up — by design. A
user sitting at their personal limit never blocks others from the remaining
global budget, whatever their priority. Waiting is event-driven rather than
polled, so a freed slot hands off immediately.

The queue is bounded globally and per user. Past those bounds, or past the
maximum wait, requests are rejected immediately with a 429 and a
`Retry-After` estimate, which the viewer uses to reschedule the zone rather
than drop it.

### Token rotation

The game mints a new session token on every `getinfo` and invalidates the old
one, so a request that queued for budget may be holding a token that died
while it waited.

The server **adopts the currently valid token at dispatch time**: it learns
every rotation passing through the proxy and rewrites the `Authorization`
header — and the form `token` field that `worldmapv2/getarea` also requires —
to the newest token, following multi-hop rotation chains. Long-queued
requests then succeed first try instead of failing and re-entering the queue
at double budget cost. The client keeps a one-shot retry as a backstop.

Token sign-in sidesteps rotation entirely: an attached session never calls
`getinfo`, so the game client's own token stays valid.

### Client-side pacing

Priority-10 zone fetches — opening a base viewer, or an explicit refresh —
bypass the client-side pacer, so a base load never waits behind panning
traffic. The server's budget still applies and is still priority-scheduled.

Browsers are told how to pace themselves at sign-in. By default each client
limits itself to its share of the per-user budget; `clientZonePace` and
`clientZoneConcurrency` in `/setup/` override that without redeploying.

---

## Admin console

Sign in at `/setup/` with an account listed in `admin/admins.json`.

**Moderation** — hidden players and hiding requests, alliance management,
administrator list, announcement banner, shared map cache and viewer user
overviews, a **manual rename tool** for renames that predate the identity
index, and an audit log of every admin action.

**Sign-in whitelist** — when enabled, only listed players may sign in.
Everyone else is refused a session with a configurable message; their game
account is unaffected, and guests can still browse the cached map.
Administrators are always exempt, so enabling the list cannot lock you out of
the console. Players who signed in before it was enabled lose their session
as soon as it refreshes.

**API Budget, Limits & Stats** — retunes every limit live: game-API budget,
queue bounds, maximum wait, full-world read concurrency, the viewer's own
endpoint limits, and the pacing pushed to browsers. Alongside it, live usage:
a 60-minute calls-per-minute sparkline, queue depth by priority band with
oldest-waiter age, wait-time percentiles, 429 counts, upstream error rate and
latency, adopted token rotations, calls by priority and endpoint category,
zone-cache hit rate, and top callers by game-API usage. Refreshes every
5 seconds.

**Scans** — a world scan that walks every zone once to fill the cache, and a
base scan that loads each explored main yard once so the base-snapshot
archive gets one file per player. Both run through the normal budget and can
be cancelled mid-run.

## Operator console (`/setup/ops`)

The traffic-facing half of administration, backed by a small SQLite database
(`admin/ops.db`, WAL) that survives restarts:

- **Requests** — a live, filterable log of every request: time, real client
  IP, method, path, status, latency, size, agent, priority, and a `kind`
  assigned at record time (`api`, `asset`, `page`, `honeypot`, `banned`,
  `untunnel`) so scanner noise filters out with one click. The live view
  polls a cursor once a second; retention is `opsLogRetentionHours`
  (default 48).
- **Top talkers** — who is generating the traffic.
- **Bans** — active and lapsed honeypot bans with strike counts, manual bans,
  and a **never-ban list** for addresses that must always get through.
- **Honeypot paths** — the built-in scanner-bait patterns plus your own
  console-added ones.
- **Rate-limit buckets** — every live token bucket with its current
  headroom, flagging the one shape that indicates a regression (all traffic
  keyed on loopback).
- **Sessions & token cache** — who is signed in and what the verification
  cache holds.
- **Settings and audit log** — ban lengths, strike decay, retention, journal
  quieting, all live-tunable, with every change audited.

---

## Command line

```
python dev_server.py --backup           # zip alliances/users/admin into STORAGE_DIR/backups/
python dev_server.py --restore [x.zip]  # restore newest (or named) backup; never overwrites
                                        # files newer than the archive
python dev_server.py --cleanup          # prune expired data and logs older than 14 days
```

Backups deliberately exclude the map and image caches, which are
reconstructible. The newest 14 archives are kept.

---

## Hosting it publicly

The app speaks plain HTTP, has no TLS of its own, and — as of this release —
**expects a Cloudflare Tunnel in front** (see
[The tunnel requirement](#the-tunnel-requirement)).

**Tunnel** — run `cloudflared` on the same machine, forwarding to
`localhost:8080`. The agent connects outbound: no firewall changes, no open
ports, no exposed home IP, and the server sees every visitor's real address
in `CF-Connecting-IP`. This is the supported front door.

**A note on plain reverse proxies.** The server currently trusts only
`CF-Connecting-IP` for the client address and refuses requests without it,
so fronting it with bare nginx or Caddy is not supported as shipped — the
proxy's requests would be refused as non-tunnel traffic.

Run the server as a dedicated unprivileged user, point `STORAGE_DIR` outside
the code directory, and schedule `python dev_server.py --backup`. Alliances,
users, and admin data have no other copy.

**Sizing.** Full-world cache reads stream zone by zone, so memory stays flat
regardless of world size — but each world is several hundred megabytes on
disk, and world reads are CPU-bound on a single core. If guests report slow
world loads, lower `fullMapConcurrency` in `/setup/` to shed load rather than
letting everyone queue.

---

## Data and privacy

**Passwords are never stored.** Sign-in passes credentials directly to the
game server; only the returned session token is kept, held in server memory
for roughly ten minutes for verification. Token sign-in never sends a
password at all. Tokens, JWTs, passwords and the account email are redacted
from the API log by default.

**Map data is public within this tool.** Base names, positions, levels, and
main-yard avatars visible on the world map are cached and shown to all users
including guests, along with when each area was last observed. Only signed-in
players can contribute to that cache, and the server validates every written
zone against the world grid.

**Base snapshots.** When a base is opened in the viewer (or an admin base
scan runs), the game's own `/base/load` response for that player is archived
— one file per player, newest wins — and powers the cell card's extra rows
and battle logs. Daily per-world outpost counts are also snapshotted for the
leaderboard trends, kept for 31 days.

**Request logging.** Every request is recorded to the operator console's
database with the real client IP, kept for `opsLogRetentionHours`
(default 48) — this is how scanners get spotted and banned. A username index
(`users_index.json`) maps game user ids to current and previous display
names, so renames carry data forward.

Alliance chat, targets, and feeds live on the viewer's server and are visible
to that alliance. Sign-in times are logged for moderation.

Players being targeted or harassed can request to be hidden from the in-app
help panel; admins review requests in `/setup/`. The full user-facing
statement is in that help panel — the **?** button at the bottom right.
