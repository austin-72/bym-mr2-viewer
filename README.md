# BYM MR2 Map Viewer

A community world-map viewer for **Backyard Monsters Refitted** (Map Room 2).
Explore the world map in your browser, track your bases, coordinate with your
alliance, and browse any world as a guest.

Runs on **Python 3.11+** with no dependencies — the server is stdlib-only.

---

## Features

### The map

- **Pan and zoom** a full isometric world map, rendered from cached game data.
- **Search** any explored base by username.
- **Filters** — by base type, tribe, level range, outpost count, and an
  inactivity filter that surfaces players who have not claimed new outposts
  in a given period.
- **Measure distance** between any two points, wrap-aware across the world edge.
- **Jump to coordinates**, or **copy a shareable link** to any cell.
- **Bookmarks** for the places you keep coming back to.
- **Cell inspector** — owner, level, empire value, damage, damage protection,
  truce state, flinger and catapult levels, stored resources, and when the
  area was last observed.
- **Leaderboards** and a **world picker** for browsing other worlds.

### Your bases

- **Base viewer** — open any yard or outpost and see it rendered with the real
  game sprites, read-only. Art is cached permanently, so each sprite is
  fetched from the game at most once ever.
- **Watchlist** — the zones around your main yard and outposts are checked
  against shared cache every 10 minutes, with a live check at most once an
  hour. The game still sees you as offline and your main base stays
  attackable.
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

A console at `/setup/` covering hidden-player moderation and hiding requests,
a **sign-in whitelist**, alliance and administrator management, an
announcement banner, cache and user overviews, a full audit log, and a live
**API Budget, Limits & Stats** panel where every limit can be retuned without
a restart.

---

## Quick start

```
python dev_server.py
```

Open <http://localhost:8080>. Sign in with your game credentials, or browse
cached worlds as a guest.

To reach the admin console, start with your in-game username on the admin
list:

```
BYM_ADMIN_USERS=YourName python dev_server.py
```

> **Note on storage.** `STORAGE_DIR` defaults to the directory containing
> `dev_server.py`, so a plain run creates `server_*/`, `imagecache/`,
> `users/`, `admin/`, `alliances/`, `logs/` and `metrics/` alongside the code.
> `start.bat` points it at `./storage` instead, which keeps the same trees one
> level down. Both layouts are covered by `.gitignore`, but for anything
> beyond a quick test point `STORAGE_DIR` at a directory outside the
> repository — the zone cache and logs hold player data.

---

## Configuration

Everything is set through environment variables. Values marked
*admin-tunable* can also be changed live in `/setup/` without restarting; the
environment variable only sets the starting value.

### Server

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` behind a reverse proxy or tunnel. |
| `PORT` | `8080` | Listen port. |
| `STORAGE_DIR` | *(directory of `dev_server.py`)* | All persistent data: map cache, image cache, alliances, users, admin. |
| `STATIC_DIR` | `app/static` | Location of the front-end files. |

### Game API

| Variable | Default | Purpose |
|---|---|---|
| `BYM_BASE_URL` | `https://server.bymrefitted.com` | Base URL of the BYM Refitted API. |
| `BYM_API_VERSION` | `v1.6.8-beta` | API version used in request paths. The client also probes for the live version at startup. |
| `BYM_ASSETS_BASE_URL` | *(unset)* | Overrides where game art is fetched. Unset, the cache tries `https://cdn.bymrefitted.com` first — the CDN the game client itself uses — then falls back to `BYM_BASE_URL`, which mirrors most but not all of the same tree. |
| `BYM_USER_AGENT` | `BYM-MR2-Viewer/1.0 …` | Outbound User-Agent, so the API maintainer can identify viewer traffic. |

### Budget and queueing

| Variable | Default | Purpose |
|---|---|---|
| `BYM_MAX_API_PER_MINUTE` | `30` | Global ceiling on outbound game-API calls, all users combined. *Admin-tunable.* |
| `BYM_MAX_API_PER_MINUTE_PER_USER` | `10` | Per-user ceiling inside the global budget. *Admin-tunable.* |
| `BYM_MAX_QUEUE_DEPTH` | `200` | Maximum requests parked waiting for budget. Each holds a server thread; beyond this, callers get an immediate 429 with `Retry-After`. *Admin-tunable.* |
| `BYM_MAX_QUEUE_DEPTH_PER_USER` | `40` | Per-user bound within that queue. *Admin-tunable.* |
| `BYM_MAX_WAIT_SECONDS` | `600` | Longest a queued request may wait before giving up with a 429. *Admin-tunable.* |
| `BYM_FULL_MAP_CONCURRENCY` | `8` | How many unfiltered full-world cache reads may run at once. Excess requests wait briefly, then get a 503 with `Retry-After`. *Admin-tunable.* |

### Behaviour and privacy

| Variable | Default | Purpose |
|---|---|---|
| `BYM_MAX_MAP_SIZE` | `800` | World edge length in cells. Zone writes outside `0..size-1` are rejected. |
| `BYM_HIDDEN_TILE_STYLE` | `blend` | How hidden players' bases render for everyone else: `blend` or `water`. |
| `BYM_ADMIN_USERS` | *(empty)* | Comma-separated in-game usernames allowed into `/setup/`. Seeds `admin/admins.json` on first run only; after that, edit the file or use the console. |
| `BYM_WHITELIST_MESSAGE` | *(built-in text)* | Message shown to a player refused by the sign-in whitelist. |
| `BYM_API_LOG` | `errors` | API-call logging. `errors` records failed calls only; `all` records everything — this keeps session tokens on disk, so opt in deliberately; `off` disables it. |
| `BYM_API_LOG_MAX_BODY` | `200000` | Maximum response body size recorded per logged call. |

### The viewer's own rate limits

Separate from the game-API budget. Signed-in users get 90 req/min (burst 30)
each, unauthenticated visitors 60 req/min (burst 20) per IP, and `/log`
10 req/min per IP — all *admin-tunable*. Excess requests receive a 429 with
`Retry-After`, and the offending user or IP is printed to the journal.

Logs land in `STORAGE_DIR/logs/`, one UTC-dated file per day, deleted
automatically after 14 days.

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

See [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

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

### Client-side pacing

Priority-10 zone fetches — opening a base viewer, or your own main yard —
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
overviews, and an audit log of every admin action.

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

The app speaks plain HTTP and has no TLS of its own, so put it behind
something that terminates HTTPS.

**Reverse proxy** — Caddy, nginx, or similar on a VPS. Bind the app to
localhost with `HOST=127.0.0.1` so the proxy is the only public entrance, run
it as a dedicated unprivileged user, point `STORAGE_DIR` outside the code
directory, and let the proxy handle certificates.

**Tunnel** — Cloudflare Tunnel, ngrok, or similar, if you want to serve from
a machine without a static IP or open ports. The agent connects outbound and
forwards to `localhost:8080`: no firewall changes, no exposed home IP.

Either way, schedule `python dev_server.py --backup`. Alliances, users, and
admin data have no other copy.

**Sizing.** Full-world cache reads stream zone by zone, so memory stays flat
regardless of world size — but each world is several hundred megabytes on
disk, and world reads are CPU-bound on a single core. If guests report slow
world loads, lower `fullMapConcurrency` in `/setup/` to shed load rather than
letting everyone queue.

---

## Data and privacy

**Passwords are never stored.** Sign-in passes credentials directly to the
game server; only the returned session token is kept, held in server memory
for roughly ten minutes for verification.

**Map data is public within this tool.** Base names, positions, levels, and
main-yard avatars visible on the world map are cached and shown to all users
including guests, along with when each area was last observed. Only signed-in
players can contribute to that cache, and the server validates every written
zone against the world grid.

Alliance chat, targets, and feeds live on the viewer's server and are visible
to that alliance. Sign-in times are logged for moderation.

Players being targeted or harassed can request to be hidden from the in-app
help panel; admins review requests in `/setup/`. The full user-facing
statement is in that help panel — the **?** button at the bottom right.
