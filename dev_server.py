from __future__ import annotations

import gzip
import ipaddress
import itertools
import sqlite3
from collections import deque
import json
import os
import sys
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from datetime import date, datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote


REPO_ROOT = Path(__file__).resolve().parent
STATIC_DIR = Path(os.environ.get("STATIC_DIR", REPO_ROOT / "app" / "static")).resolve()
# Storage root for the shared map cache (server_{name}/) and per-user data
# (users/{username}/). Defaults to the repo root, i.e. bym-mr2-viewer\.
STORAGE_ROOT = Path(os.environ.get("STORAGE_DIR", REPO_ROOT)).resolve()
# Loopback by default: cloudflared connects over it, and binding anywhere
# else would let the internet reach this server directly - which would also
# make CF-Connecting-IP spoofable and every ban trivially evadable.
# Override only for a deliberately LAN-exposed dev box.
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8080"))

MAX_BODY_BYTES = 32 * 1024 * 1024

# Explicit MIME types. On Windows, Python's `mimetypes` module reads the
# registry and frequently maps .js to text/plain, which makes browsers
# reject ES module scripts ("Strict MIME type checking is enforced").
# Never rely on the system mapping for anything the viewer serves.
MIME_TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".htm": "text/html",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".txt": "text/plain",
    ".md": "text/plain",
    ".map": "application/json",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}

# One coarse lock for all storage writes. The viewer's write volume is tiny
# (debounced zone batches, a settings blob, a login append), so simplicity
# beats granularity here.
STORAGE_LOCK = threading.Lock()

SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._\- ]+")

# Redacts the value of any password field in a logged request body, whether it
# arrived form-encoded (password=...) or as JSON ("password": "...").
API_LOG_PASSWORD_RE = re.compile(r'(password=|"password"\s*:\s*")[^&"]*', re.IGNORECASE)
# Session tokens are credentials. The game's token IS the login - anyone
# holding it can act as that account until it expires (observed: ~30 days) -
# and it is echoed in getinfo responses AND sent as a query parameter on every
# getarea call, so a single day's log can contain it hundreds of times. Logs
# get shared when asking for help, which is exactly when this leaks.
# Redacted by default; set BYM_API_LOG_TOKENS=1 to keep them when a
# reproduction genuinely needs the original token.
API_LOG_KEEP_TOKENS = os.environ.get("BYM_API_LOG_TOKENS", "").strip().lower() in ("1", "true", "yes")
# JWT-shaped values, wherever they appear (request body, query string, or an
# echoed response), plus explicit token fields for non-JWT formats.
API_LOG_JWT_RE = re.compile(r'eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]+')
API_LOG_TOKEN_FIELD_RE = re.compile(r'(token=|"token"\s*:\s*")[^&"]*', re.IGNORECASE)
# The account email is PII and is echoed back by player/getinfo even when the
# request never carried it. Redacted with the same switch as tokens: it is
# identity, not something a reproduction needs.
API_LOG_EMAIL_FIELD_RE = re.compile(r'(email=|"email"\s*:\s*")[^&"]*', re.IGNORECASE)


def api_log_redact(text: str) -> str:
    """Strips credentials from a logged request or response body."""
    text = API_LOG_PASSWORD_RE.sub(r"\1<redacted>", text)
    if not API_LOG_KEEP_TOKENS:
        text = API_LOG_JWT_RE.sub("<redacted-jwt>", text)
        text = API_LOG_TOKEN_FIELD_RE.sub(r"\1<redacted>", text)
        text = API_LOG_EMAIL_FIELD_RE.sub(r"\1<redacted>", text)
    return text

# ---------------------------------------------------------------------------
# API-call logging configuration (BYM_API_LOG environment variable).
#
# The value is a comma/space separated list of tokens:
#   all            log every proxied game-API call
#   off            disable API-call logging entirely (also: none, 0, false)
#   auth           login/session calls        (/player/getinfo, /init)
#   map            map data calls             (/worldmapv2/*, /bm/getnewmap)
#   base           base save calls            (/base/load, /base/*)
#   meta           world/leaderboard lookups  (/worlds, /leaderboards)
#   other          anything not matched above
#   errors         only log calls that FAILED (HTTP >= 400 or a transport
#                  error); combines with categories, e.g. "map,errors" logs
#                  only failed map calls, and "errors" alone logs every
#                  failure regardless of category
#
# Examples:
#   BYM_API_LOG=off            no api-calls.log at all
#   BYM_API_LOG=map            only map-zone traffic
#   BYM_API_LOG=auth,base      login and base-save calls
#   BYM_API_LOG=errors         failures only - the usual repro setting (DEFAULT:
#                              full-body logging of every call keeps session
#                              tokens on disk, so it must be opted into)
# ---------------------------------------------------------------------------
API_LOG_CATEGORIES = ("auth", "map", "base", "meta", "other")

# Max characters of request/response body stored per log entry. Zone payloads
# run well past the old 4,000-char cap, which chopped them mid-JSON and made
# the log useless for replaying map traffic. 0 disables the cap entirely.
# When a body IS cut, the entry carries requestTruncated/responseTruncated
# with the original length, so a partial body is never mistaken for a
# complete one. Override via BYM_API_LOG_MAX_BODY.
try:
    API_LOG_MAX_BODY = int(os.environ.get("BYM_API_LOG_MAX_BODY", "200000"))
except ValueError:
    API_LOG_MAX_BODY = 200000


def api_log_cap(text: str):
    """Returns (stored_text, original_length_or_None_if_untruncated)."""
    if API_LOG_MAX_BODY > 0 and len(text) > API_LOG_MAX_BODY:
        return text[:API_LOG_MAX_BODY], len(text)
    return text, None
_API_LOG_OFF_TOKENS = {"off", "none", "0", "false"}

# ---------------------------------------------------------------------------
# Log files live under STORAGE_ROOT/logs/, one file per UTC day per stream
# (log-YYYY-MM-DD.log, api-calls-YYYY-MM-DD.log). Files older than
# LOG_RETENTION_DAYS are deleted opportunistically on write (throttled to
# once an hour per process) and by the --cleanup CLI. The logs directory is
# excluded from backups: bulky, regenerable, and it can hold session tokens.
# ---------------------------------------------------------------------------
LOG_RETENTION_DAYS = 14
_LOG_PRUNE_INTERVAL = 3600  # seconds between opportunistic prune passes
_LOG_PRUNE_LOCK = threading.Lock()
_LOG_PRUNE_LAST = 0.0


def logs_dir() -> "Path":
    path = STORAGE_ROOT / "logs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def dated_log_path(stem: str) -> "Path":
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return logs_dir() / f"{stem}-{day}.log"


def prune_old_logs(force: bool = False) -> int:
    """Deletes *.log files under logs/ older than LOG_RETENTION_DAYS (by
    mtime, which for a date-stamped daily file is its last written day).
    Returns the number of files removed. Throttled unless force=True."""
    global _LOG_PRUNE_LAST
    now = time.time()
    with _LOG_PRUNE_LOCK:
        if not force and now - _LOG_PRUNE_LAST < _LOG_PRUNE_INTERVAL:
            return 0
        _LOG_PRUNE_LAST = now
    removed = 0
    cutoff = now - LOG_RETENTION_DAYS * 86400
    try:
        for path in (STORAGE_ROOT / "logs").glob("*.log"):
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink()
                    removed += 1
            except OSError:
                continue
    except OSError:
        pass
    if removed:
        print(f"[logs] pruned {removed} log file(s) older than {LOG_RETENTION_DAYS} days")
    return removed


def _parse_api_log_config(raw: str):
    """Returns (enabled_category_set, errors_only). Unknown tokens are reported."""
    tokens = {t for t in re.split(r"[,\s]+", str(raw or "").strip().lower()) if t}
    errors_only = "errors" in tokens
    tokens -= {"errors"}

    if tokens & _API_LOG_OFF_TOKENS:
        return (set(), False)
    unknown = tokens - set(API_LOG_CATEGORIES) - {"all"}
    if unknown:
        print(f"[api-log] ignoring unknown BYM_API_LOG token(s): {', '.join(sorted(unknown))} "
              f"(valid: all, off, errors, {', '.join(API_LOG_CATEGORIES)})")
    tokens -= unknown
    if not tokens or "all" in tokens:
        return (set(API_LOG_CATEGORIES), errors_only)
    return (tokens, errors_only)


API_LOG_ENABLED_CATEGORIES, API_LOG_ERRORS_ONLY = _parse_api_log_config(
    os.environ.get("BYM_API_LOG", "errors"),
)


def api_log_category(target: str) -> str:
    """Buckets an upstream request path into one of API_LOG_CATEGORIES."""
    path = str(target or "").split("?", 1)[0].lower()
    if "/player/getinfo" in path or path == "/init" or path.endswith("/init"):
        return "auth"
    if "/worldmapv2/" in path or "/bm/getnewmap" in path:
        return "map"
    if "/base/" in path:
        return "base"
    if "/worlds" in path or "/leaderboards" in path:
        return "meta"
    return "other"


def api_log_should_record(category: str, status, target: str = "") -> bool:
    if category not in API_LOG_ENABLED_CATEGORIES:
        return False
    if API_LOG_ERRORS_ONLY:
        # The viewer's API-version discovery probe fails BY DESIGN (it sends
        # a fake version and reads the error message), so it is not an error
        # worth recording in errors-only mode - it would otherwise appear in
        # every session's log and look like a real failure.
        if "__viewer_probe__" in str(target or ""):
            return False
        # Non-integer statuses ("transport-error") are always failures.
        return not isinstance(status, int) or status >= 400
    return True


# Bootstrap viewer administrators (case-insensitive). There are NO admins baked
# into the source. The initial allowlist comes from the BYM_ADMIN_USERS
# environment variable (comma- or space-separated game usernames) and is used
# only to seed admin/admins.json on first run; after that the list is edited
# live from the /setup/ console. If BYM_ADMIN_USERS is unset the allowlist
# starts empty - set it once (or edit admin/admins.json) to bootstrap access.
# Only admins may reach the console APIs: manage the hidden-players list, the
# admin allowlist, announcements, and inspect/purge the shared cache.
SEED_ADMIN_USERS = {
    name.strip()
    for name in re.split(r"[,\s]+", os.environ.get("BYM_ADMIN_USERS", ""))
    if name.strip()
}

# Admin identity is proven with a real BYM session token: the viewer server
# verifies the token against the game server (player/getinfo) and uses the
# username the GAME reports - a claimed name is never trusted.
BYM_BASE_URL = os.environ.get("BYM_BASE_URL", "https://server.bymrefitted.com").rstrip("/")

# How hidden players' tiles are disguised for non-exempt viewers:
#   tribe (default) - the tile is replaced with the wild monster cell that
#                     coordinate generates, so it reads as ordinary wilderness
#   water           - the tile is rendered as a water hex
# "blend" is the old name for the default and still accepted: it described the
# previous behaviour, which averaged the surrounding heights. That approach is
# gone (see anonymize_hidden_cells), so the value is named for what it does.
HIDDEN_TILE_STYLE = (
    "water"
    if os.environ.get("BYM_HIDDEN_TILE_STYLE", "tribe").strip().lower() == "water"
    else "tribe"
)
HIDDEN_WATER_HEIGHT = 60  # water1 band, matching natural lakes

# Global ceiling on outbound calls to the BYM servers (proxy + token
# verification combined, across every user of this viewer). Admins can change
# it at runtime from the /setup/ console; the env var only sets the default.
DEFAULT_MAX_API_PER_MINUTE = max(1, int(os.environ.get("BYM_MAX_API_PER_MINUTE", "30") or 30))
DEFAULT_MAX_API_PER_MINUTE_PER_USER = max(1, int(os.environ.get("BYM_MAX_API_PER_MINUTE_PER_USER", "10") or 10))
# Band ceilings inside the per-user allowance. The defaults sum to 8 of 10, so
# two slots a minute are unreachable by anything below priority 9.
DEFAULT_MAX_LOW_PER_MINUTE_PER_USER = max(1, int(os.environ.get("BYM_MAX_LOW_PER_MINUTE_PER_USER", "5") or 5))
DEFAULT_MAX_MEDIUM_PER_MINUTE_PER_USER = max(1, int(os.environ.get("BYM_MAX_MEDIUM_PER_MINUTE_PER_USER", "3") or 3))
BYM_CALL_TIMES: list = []
BYM_CALL_LOCK = threading.Condition()
BYM_WINDOW_SECONDS = 60.0
# Max time a request may wait for budget is admin-tunable ("bymMaxWaitSeconds",
# default 600); see SETTINGS_FIELD_RULES.
# Pending waiters as a flat list of (-priority, sequence, user_key, started).
# When a slot frees, the waiter with the highest EFFECTIVE priority across all
# connected users takes it; ties go to whoever asked first. A plain list, not
# a heap: effective priority changes with waiting time (see
# _effective_priority), so no static ordering survives long enough to be worth
# maintaining - and the eligibility scan already had to be linear because a
# waiter whose per-user window is exhausted has to be skipped.
BYM_WAITERS: list = []
BYM_WAITER_SEQ = itertools.count()
# Per-user sliding windows: key -> list of (monotonic call time, band). Keys
# are "user:<name>" for recognized sessions, "tok:<prefix>" for unrecognized
# tokens, "ip:<addr>" for anonymous calls. Mutated under BYM_CALL_LOCK.
#
# The band rides along so one user's background panning cannot spend their
# whole per-minute allowance and leave nothing for the things they are
# actually waiting on. A call has to clear BOTH the per-user total and its own
# band cap.
BYM_USER_CALLS: dict = {}

# Priority bands. High is deliberately uncapped beyond the per-user total:
# every tier in it is a request someone is watching a spinner for.
BYM_BAND_LOW = "low"          # priorities 1-5: distant rings, everything else
BYM_BAND_MEDIUM = "medium"    # priorities 6-8: own outposts, allies, near rings
BYM_BAND_HIGH = "high"        # priorities 9-10: clicks, panels, bootstrap


def priority_band(priority: int) -> str:
    value = int(priority)
    if value >= 9:
        return BYM_BAND_HIGH
    if value >= 6:
        return BYM_BAND_MEDIUM
    return BYM_BAND_LOW


def band_limit(band: str) -> int:
    """Per-minute ceiling for a band, or 0 for "no band ceiling"."""
    if band == BYM_BAND_LOW:
        return int(get_setting("maxLowPriorityPerMinutePerUser"))
    if band == BYM_BAND_MEDIUM:
        return int(get_setting("maxMediumPriorityPerMinutePerUser"))
    return 0
# Keys are only dropped when their window is next inspected, and the key is not
# always a username: rate_limit_key() falls back to tok:{prefix} when a token
# is not cached, and BYMR mints a fresh token on every verification. Those keys
# are used once and abandoned, so the dict needs the same idle sweep
# RATE_BUCKETS already has.
BYM_USER_CALLS_SWEEP_AT = 2000


def user_window_free(user_key: str, per_user_limit: int, now: float,
                     priority: int = 10) -> bool:
    """True when this user may spend a slot on a call of this priority.

    Two ceilings, both per user per minute: the overall allowance, and the
    band's own. A tier-1 zone that has used up the low-priority allowance is
    held even though the user has total budget left - which is the point: the
    remainder stays available for the tiers they are waiting on.
    """
    times = BYM_USER_CALLS.get(user_key)
    if times is not None:
        cutoff = now - BYM_WINDOW_SECONDS
        while times and times[0][0] <= cutoff:
            times.pop(0)
        if not times:
            BYM_USER_CALLS.pop(user_key, None)
            times = None
    if len(times or ()) >= per_user_limit:
        return False
    band = priority_band(priority)
    ceiling = band_limit(band)
    if ceiling <= 0:
        return True
    return sum(1 for _t, b in (times or ()) if b == band) < ceiling
SERVER_STARTED_AT = time.time()
# Minute-bucket history of outbound calls (last ~2h) for the admin console's
# usage statistics. Mutated only while holding BYM_CALL_LOCK.
BYM_CALL_HISTORY: dict = {}


def note_bym_history() -> None:
    minute = int(time.time() // 60)
    BYM_CALL_HISTORY[minute] = BYM_CALL_HISTORY.get(minute, 0) + 1
    for old_minute in [m for m in BYM_CALL_HISTORY if m < minute - 120]:
        del BYM_CALL_HISTORY[old_minute]


def bym_call_stats() -> dict:
    with BYM_CALL_LOCK:
        now = time.monotonic()
        last_minute = sum(1 for t in BYM_CALL_TIMES if t > now - BYM_WINDOW_SECONDS)
        minute = int(time.time() // 60)
        hour_counts = [BYM_CALL_HISTORY.get(m, 0) for m in range(minute - 59, minute + 1)]
    uptime_minutes = max(1.0, (time.time() - SERVER_STARTED_AT) / 60.0)
    window_minutes = min(60.0, uptime_minutes)
    return {
        "lastMinute": last_minute,
        "lastHourTotal": sum(hour_counts),
        "lastHourAvg": round(sum(hour_counts) / window_minutes, 2),
        "uptimeMinutes": int(uptime_minutes),
        "minuteSeries": hour_counts,
    }


# ---------------------------------------------------------------------------
# Metrics for the /setup/ console. Cheap minute-bucket counters plus two small
# ring buffers (queue wait times, upstream latency). Everything is kept in
# memory only, pruned to the last ~2 hours, and guarded by its own lock -
# metric_* helpers must never be called while holding BYM_CALL_LOCK.
# ---------------------------------------------------------------------------
METRICS_LOCK = threading.Lock()
METRICS_MINUTES: dict = {}        # minute -> {counter_name: count}
METRICS_USER_MINUTES: dict = {}   # user_key -> {minute: count}
METRICS_WAITS: deque = deque(maxlen=2000)     # (unix_ts, waited_ms, priority)
METRICS_UPSTREAM: deque = deque(maxlen=2000)  # (unix_ts, elapsed_ms, ok)


def _prune_minutes(buckets: dict, minute: int) -> None:
    for old in [m for m in buckets if m < minute - 120]:
        del buckets[old]


def metric_inc(name: str, amount: int = 1) -> None:
    now = time.time()
    minute = int(now // 60)
    with METRICS_LOCK:
        bucket = METRICS_MINUTES.setdefault(minute, {})
        bucket[name] = bucket.get(name, 0) + amount
        _prune_minutes(METRICS_MINUTES, minute)
        _record_hourly(name, amount, now=now)


def metric_user_call(user_key: str) -> None:
    now = time.time()
    minute = int(now // 60)
    with METRICS_LOCK:
        # "total" is the one counter that is both a global figure and a
        # per-user one, so the rollup can answer "who used the budget" without
        # a second pass.
        _record_hourly("total", 1, user_key=user_key, now=now)
        buckets = METRICS_USER_MINUTES.setdefault(user_key, {})
        buckets[minute] = buckets.get(minute, 0) + 1
        _prune_minutes(buckets, minute)
        if not buckets:
            METRICS_USER_MINUTES.pop(user_key, None)
        # Forget users with no activity in the retained window.
        if len(METRICS_USER_MINUTES) > 200:
            for key in [k for k, v in METRICS_USER_MINUTES.items() if not v]:
                METRICS_USER_MINUTES.pop(key, None)


def metric_wait(waited_ms: float, priority: int) -> None:
    now = time.time()
    with METRICS_LOCK:
        METRICS_WAITS.append((now, float(waited_ms), int(priority)))
        _record_hourly("waitCount", 1, now=now)
        _record_hourly("waitSumMs", int(waited_ms), now=now)
        bucket = _today_bucket(now)["hours"].setdefault(_utc_hour(now), {})
        bucket["waitMaxMs"] = max(int(bucket.get("waitMaxMs", 0)), int(waited_ms))


def metric_upstream(elapsed_ms: float, ok: bool) -> None:
    now = time.time()
    with METRICS_LOCK:
        METRICS_UPSTREAM.append((now, float(elapsed_ms), bool(ok)))
        _record_hourly("upstream:ok" if ok else "upstream:fail", 1, now=now)
        if ok:
            _record_hourly("upstreamSumMs", int(elapsed_ms), now=now)


# ---------------------------------------------------------------------------
# Persistent usage history.
#
# The minute buckets above are the live view and stay in memory. Everything
# also rolls up into an hourly per-day file under storage/metrics, which is
# what survives a restart and what the console reports over long periods.
# Hourly rather than per-minute on purpose: a day of minute-resolution
# per-user data is hundreds of thousands of entries, an hourly one is a few
# thousand, and no question the console asks needs finer than an hour once you
# are past the last 60 minutes.
# ---------------------------------------------------------------------------
METRICS_TODAY: dict = {"day": "", "hours": {}, "users": {}}
METRICS_TODAY_DIRTY = False
METRICS_FLUSH_SECONDS = 15.0

# Hourly counters that are peaks, not running totals. metric_wait stores
# waitMaxMs with max() per hour, so summing it across hours and days -- which
# is what every other counter here wants -- reports the sum of the hourly
# peaks as the peak. Over a 30-day report with traffic in every hour that
# overstates the worst wait by up to ~720x. Aggregate these with max instead.
METRICS_MAX_COUNTERS = frozenset({"waitMaxMs"})


def metrics_dir() -> "Path":
    path = STORAGE_ROOT / "metrics"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _utc_day(ts: float = None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(ts if ts is not None else time.time()))


def _utc_hour(ts: float = None) -> str:
    return time.strftime("%H", time.gmtime(ts if ts is not None else time.time()))


def _today_bucket(now: float = None) -> dict:
    """Current day's rollup, rotating (and flushing) at UTC midnight.

    Caller must hold METRICS_LOCK.
    """
    global METRICS_TODAY, METRICS_TODAY_DIRTY
    day = _utc_day(now)
    if METRICS_TODAY.get("day") != day:
        if METRICS_TODAY.get("day"):
            _write_day(METRICS_TODAY)
        loaded = _read_day(day)
        METRICS_TODAY = loaded or {"day": day, "hours": {}, "users": {}}
        METRICS_TODAY_DIRTY = False
    return METRICS_TODAY


def _day_path(day: str) -> "Path":
    return metrics_dir() / f"usage-{day}.json"


def _read_day(day: str) -> dict:
    try:
        raw = _day_path(day).read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict) or data.get("day") != day:
        return {}
    data.setdefault("hours", {})
    data.setdefault("users", {})
    return data


def _write_day(bucket: dict) -> bool:
    """Returns True when the rollup is safely on disk, so the caller knows
    whether it may clear the dirty flag."""
    day = bucket.get("day")
    if not day:
        return False
    path = _day_path(day)
    # A private temp name per writer. metrics_flush() deliberately drops
    # METRICS_LOCK before writing, while the midnight rotation in
    # _today_bucket() writes while holding it, so the background writer and a
    # request thread calling usage_report() can land here at the same moment.
    # On one shared "usage-<day>.tmp" that interleaves into a torn file.
    # The suffix keeps it clear of the usage-*.json globs.
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        tmp.write_text(json.dumps(bucket, separators=(",", ":")), encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)   # owner-only; see atomic_write_json
        except OSError:
            pass
        tmp.replace(path)          # atomic; removes tmp on success
        return True
    except OSError as error:
        print(f"[metrics] could not write {path.name}: {error}")
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        return False


def metrics_flush(force: bool = False) -> None:
    """Writes the current day's rollup if anything changed."""
    global METRICS_TODAY_DIRTY
    with METRICS_LOCK:
        if not METRICS_TODAY_DIRTY and not force:
            return
        bucket = json.loads(json.dumps(METRICS_TODAY))
    # Clear the flag only once the bytes are down. Clearing it before the
    # write meant a failed write (full disk, bad permissions) silently
    # discarded the hour: _write_day swallows OSError, so nothing retried and
    # nothing was logged beyond one line. Leaving it set means the next
    # 15-second tick tries again.
    if _write_day(bucket):
        with METRICS_LOCK:
            METRICS_TODAY_DIRTY = False


def metrics_prune_files() -> int:
    """Drops day files past the retention window. Returns how many were removed."""
    try:
        keep_days = int(get_setting("metricsRetentionDays"))
    except Exception:
        keep_days = 30
    cutoff = _utc_day(time.time() - keep_days * 86400)
    removed = 0
    try:
        for path in metrics_dir().glob("usage-*.json"):
            day = path.stem.replace("usage-", "")
            if len(day) == 10 and day < cutoff:
                path.unlink(missing_ok=True)
                removed += 1
    except OSError:
        pass
    return removed


# ---------------------------------------------------------------------------
# Leaderboard history: once per UTC day, per world, snapshot every player's
# cached outpost count (keyed by uid - names change, uids do not). The 1/7/30
# day columns are computed cache-vs-cache: today's fresh scan minus the
# nearest snapshot at or before (today - k). An hourly check (plus one at
# startup) writes the day file if missing, so downtime self-heals; files
# older than the retention window are pruned at write time.
# ---------------------------------------------------------------------------
HISTORY_RETENTION_DAYS = 31
HISTORY_CHECK_SECONDS = 3600
HISTORY_CELL_OUTPOST = 3
HISTORY_MEMO: dict = {}
HISTORY_MEMO_LOCK = threading.Lock()
HISTORY_MEMO_TTL_SECONDS = 300


def history_dir(world: str) -> Path:
    return STORAGE_ROOT / f"server_{world}" / "history"


def history_outpost_counts(world: str) -> dict:
    """{uid(str): {"n": latest name, "c": outpost count}} from cached zones."""
    counts: dict = {}
    zones_dir = STORAGE_ROOT / f"server_{world}" / "zones"
    if not zones_dir.is_dir():
        return counts
    for path in zones_dir.glob("zone_*.json"):
        payload = read_json(path, None)
        cells = payload.get("cells") if isinstance(payload, dict) else None
        if not isinstance(cells, list):
            continue
        for cell in cells:
            if not isinstance(cell, dict):
                continue
            try:
                if int(cell.get("b", 0) or 0) != HISTORY_CELL_OUTPOST:
                    continue
                uid = int(cell.get("uid", 0) or 0)
            except (TypeError, ValueError):
                continue
            if uid <= 0:
                continue
            entry = counts.setdefault(str(uid), {"n": "", "c": 0})
            entry["c"] += 1
            name = str(cell.get("n", "") or "").strip()
            if name:
                entry["n"] = name
    return counts


def history_world_ids() -> list:
    worlds = []
    for path in STORAGE_ROOT.glob("server_*"):
        if path.is_dir() and (path / "zones").is_dir():
            worlds.append(path.name[len("server_"):])
    return worlds


def history_prune(world: str) -> None:
    hdir = history_dir(world)
    if not hdir.is_dir():
        return
    today = date.fromisoformat(_utc_day())
    for path in hdir.glob("*.json"):
        try:
            day = date.fromisoformat(path.stem)
        except ValueError:
            continue
        if (today - day).days > HISTORY_RETENTION_DAYS:
            try:
                path.unlink()
            except OSError:
                pass


def write_history_snapshot(world: str) -> bool:
    day = _utc_day()
    path = history_dir(world) / f"{day}.json"
    if path.exists():
        return False
    counts = history_outpost_counts(world)
    atomic_write_json(path, {"day": day, "builtAt": time.time(), "counts": counts})
    history_prune(world)
    print(f"[history] snapshot {world} {day}: {len(counts)} players")
    return True


def history_snapshot_all() -> None:
    for world in history_world_ids():
        try:
            write_history_snapshot(world)
        except Exception as error:            # never take the server down
            print(f"[history] snapshot failed for {world}: {error}")


def _history_writer_loop() -> None:
    while True:
        time.sleep(HISTORY_CHECK_SECONDS)
        try:
            history_snapshot_all()
        except Exception as error:
            print(f"[history] hourly check failed: {error}")


def start_history_writer() -> None:
    try:
        history_snapshot_all()
    except Exception as error:
        print(f"[history] startup snapshot failed: {error}")
    thread = threading.Thread(target=_history_writer_loop, daemon=True,
                              name="leaderboard-history")
    thread.start()


def leaderboard_history(world: str) -> dict:
    """Cache-vs-cache deltas for 1/7/30 days, memoised briefly."""
    now = time.time()
    with HISTORY_MEMO_LOCK:
        cached = HISTORY_MEMO.get(world)
        if cached and now - cached["at"] < HISTORY_MEMO_TTL_SECONDS:
            return cached["payload"]

    current = history_outpost_counts(world)
    hdir = history_dir(world)
    days = sorted(p.stem for p in hdir.glob("*.json")) if hdir.is_dir() else []
    today = date.fromisoformat(_utc_day())

    windows: dict = {}
    names = {uid: entry["n"] for uid, entry in current.items() if entry["n"]}
    for k in (1, 7, 30):
        target = (today - timedelta(days=k)).isoformat()
        base_day = None
        for day in days:
            if day <= target and (base_day is None or day > base_day):
                base_day = day
        if base_day is None:
            windows[str(k)] = None
            continue
        base = read_json(hdir / f"{base_day}.json", None)
        base_counts = base.get("counts") if isinstance(base, dict) else None
        if not isinstance(base_counts, dict):
            windows[str(k)] = None
            continue
        deltas: dict = {}
        for uid, entry in current.items():
            deltas[uid] = entry["c"] - int((base_counts.get(uid) or {}).get("c", 0) or 0)
        for uid, entry in base_counts.items():
            if uid not in current:
                deltas[uid] = -int((entry or {}).get("c", 0) or 0)
                name = str((entry or {}).get("n", "") or "").strip()
                if name and uid not in names:
                    names[uid] = name
        windows[str(k)] = {"baseDay": base_day, "deltas": deltas}

    # Raw day-by-day series for CSV export: every stored day (ascending)
    # and each uid's count on that day (absent = not snapshotted/0).
    series_days = days[-HISTORY_RETENTION_DAYS:]
    series_counts: dict = {}
    for day in series_days:
        day_data = read_json(hdir / f"{day}.json", None)
        day_counts = day_data.get("counts") if isinstance(day_data, dict) else None
        if not isinstance(day_counts, dict):
            continue
        for uid, entry in day_counts.items():
            series_counts.setdefault(uid, {})[day] = int((entry or {}).get("c", 0) or 0)
            name = str((entry or {}).get("n", "") or "").strip()
            if name and uid not in names:
                names[uid] = name
    payload = {"world": world, "today": today.isoformat(),
               "windows": windows, "names": names,
               "series": {"days": series_days, "counts": series_counts}}
    with HISTORY_MEMO_LOCK:
        HISTORY_MEMO[world] = {"at": now, "payload": payload}
    return payload


def save_baseload_capture(request_body, payload: bytes) -> None:
    """Archive the latest /base/load response per player.

    One file per player: baseloads/{uid}.json, where uid is the viewed
    base owner's userid from the response. A newer load of any of the
    player's bases overwrites the previous file, so the directory always
    holds each player's most recent snapshot. Obvious error responses
    and payloads without a userid are skipped.
    """
    parsed = None
    try:
        parsed = json.loads(payload.decode("utf-8", "replace"))
    except (ValueError, UnicodeDecodeError):
        return                       # not JSON: nothing analysable
    if not isinstance(parsed, dict) or parsed.get("error"):
        return
    uid = str(parsed.get("userid", "") or parsed.get("saveuserid", "") or "").strip()
    uid = re.sub(r"[^0-9]", "", uid)
    if not uid or uid == "0":
        return
    out_dir = STORAGE_ROOT / "baseloads"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{uid}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(payload)
    tmp.replace(path)


def _metrics_writer_loop() -> None:
    while True:
        time.sleep(METRICS_FLUSH_SECONDS)
        try:
            metrics_flush()
        except Exception as error:            # never take the server down
            print(f"[metrics] flush failed: {error}")


def start_metrics_writer() -> None:
    with METRICS_LOCK:
        _today_bucket()
    metrics_prune_files()
    thread = threading.Thread(target=_metrics_writer_loop, daemon=True,
                              name="metrics-writer")
    thread.start()


def _record_hourly(counter: str, amount: int = 1, user_key: str = "",
                   now: float = None) -> None:
    """Adds to the on-disk rollup. Caller must hold METRICS_LOCK."""
    global METRICS_TODAY_DIRTY
    bucket = _today_bucket(now)
    hour = _utc_hour(now)
    hours = bucket["hours"].setdefault(hour, {})
    hours[counter] = hours.get(counter, 0) + amount
    if user_key:
        user = bucket["users"].setdefault(user_key, {})
        user[hour] = user.get(hour, 0) + amount
    METRICS_TODAY_DIRTY = True


def usage_report(day_from: str, day_to: str) -> dict:
    """Aggregates the stored rollups across an inclusive UTC day range."""
    metrics_flush()
    days = []
    try:
        for path in sorted(metrics_dir().glob("usage-*.json")):
            day = path.stem.replace("usage-", "")
            if day_from <= day <= day_to:
                data = _read_day(day)
                if data:
                    days.append(data)
    except OSError:
        pass

    totals: dict = {}
    per_day: list = []
    per_user: dict = {}
    per_hour_of_day = {f"{h:02d}": 0 for h in range(24)}
    for data in days:
        day_total = 0
        day_counters: dict = {}
        for hour, counters in sorted(data.get("hours", {}).items()):
            for name, count in counters.items():
                if name in METRICS_MAX_COUNTERS:
                    totals[name] = max(totals.get(name, 0), count)
                    day_counters[name] = max(day_counters.get(name, 0), count)
                    continue
                totals[name] = totals.get(name, 0) + count
                day_counters[name] = day_counters.get(name, 0) + count
                if name == "total":
                    day_total += count
                    per_hour_of_day[hour] = per_hour_of_day.get(hour, 0) + count
        for key, hours in data.get("users", {}).items():
            entry = per_user.setdefault(key, {"calls": 0, "days": 0})
            calls = sum(int(v) for v in hours.values())
            entry["calls"] += calls
            entry["days"] += 1 if calls else 0
        per_day.append({"day": data.get("day"), "total": day_total,
                        "counters": day_counters})

    wait_count = totals.get("waitCount", 0)
    return {
        "from": day_from,
        "to": day_to,
        "days": per_day,
        "dayCount": len(per_day),
        "total": totals.get("total", 0),
        "counters": totals,
        "byPriority": {str(p): totals.get(f"prio:{p}", 0) for p in range(1, 11)},
        "byBand": {
            "low": sum(totals.get(f"prio:{p}", 0) for p in range(1, 6)),
            "medium": sum(totals.get(f"prio:{p}", 0) for p in range(6, 9)),
            "high": sum(totals.get(f"prio:{p}", 0) for p in range(9, 11)),
        },
        "byCategory": {k[4:]: v for k, v in totals.items() if k.startswith("cat:")},
        "rejects": {
            "queueFull": totals.get("reject:queue", 0),
            "timeout": totals.get("reject:timeout", 0),
        },
        "wait": {
            "count": wait_count,
            "avgMs": round(totals.get("waitSumMs", 0) / wait_count, 1) if wait_count else 0,
            "maxMs": totals.get("waitMaxMs", 0),
        },
        "upstream": {
            "ok": totals.get("upstream:ok", 0),
            "fail": totals.get("upstream:fail", 0),
            "avgMs": (round(totals.get("upstreamSumMs", 0) / totals.get("upstream:ok", 1), 1)
                      if totals.get("upstream:ok") else 0),
        },
        "hourOfDay": per_hour_of_day,
        "users": sorted(
            ({"key": k, **v} for k, v in per_user.items()),
            key=lambda row: -row["calls"],
        ),
    }


def usage_report_csv(report: dict) -> str:
    """Flat CSV: one section per block, so a spreadsheet can pivot it."""
    lines = ["section,key,value"]

    def add(section: str, key: str, value) -> None:
        safe = str(key).replace('"', "'")
        lines.append(f'{section},"{safe}",{value}')

    add("range", "from", report["from"])
    add("range", "to", report["to"])
    add("range", "days", report["dayCount"])
    add("total", "calls", report["total"])
    for day in report["days"]:
        add("perDay", day["day"], day["total"])
    for key, value in sorted(report["byPriority"].items(), key=lambda kv: int(kv[0])):
        add("priority", key, value)
    for key, value in report["byBand"].items():
        add("band", key, value)
    for key, value in sorted(report["byCategory"].items()):
        add("category", key, value)
    for key, value in report["rejects"].items():
        add("rejected", key, value)
    for key, value in report["wait"].items():
        add("queueWait", key, value)
    for key, value in report["upstream"].items():
        add("upstream", key, value)
    for hour, value in sorted(report["hourOfDay"].items()):
        add("hourOfDay", hour, value)
    for row in report["users"]:
        add("user", row["key"], row["calls"])
    return "\n".join(lines) + "\n"


def _percentile(sorted_values: list, fraction: float) -> float:
    if not sorted_values:
        return 0.0
    index = min(len(sorted_values) - 1, int(fraction * len(sorted_values)))
    return sorted_values[index]


def metrics_summary() -> dict:
    """Everything the /setup/ console shows, computed on demand."""
    now = time.time()
    minute = int(now // 60)
    hour_minutes = range(minute - 59, minute + 1)

    # Live queue snapshot (needs BYM_CALL_LOCK; entries are
    # (-priority, seq, user_key, enqueued_monotonic)).
    with BYM_CALL_LOCK:
        waiters = list(BYM_WAITERS)
        mono_now = time.monotonic()
    bands = {"1-2": 0, "3-6": 0, "7-8": 0, "9-10": 0}
    oldest_wait = 0.0
    for negative_priority, _seq, _key, enqueued in waiters:
        priority = -negative_priority
        if priority <= 2:
            bands["1-2"] += 1
        elif priority <= 6:
            bands["3-6"] += 1
        elif priority <= 8:
            bands["7-8"] += 1
        else:
            bands["9-10"] += 1
        oldest_wait = max(oldest_wait, mono_now - enqueued)

    with METRICS_LOCK:
        def hour_sum(counter: str) -> int:
            return sum(METRICS_MINUTES.get(m, {}).get(counter, 0) for m in hour_minutes)

        by_priority = {str(p): hour_sum(f"prio:{p}") for p in range(1, 11)}
        by_category = {}
        for m in hour_minutes:
            for name, count in METRICS_MINUTES.get(m, {}).items():
                if name.startswith("cat:"):
                    by_category[name[4:]] = by_category.get(name[4:], 0) + count
        rejects = {
            "queueFullHour": hour_sum("reject:queue"),
            "timeoutHour": hour_sum("reject:timeout"),
        }
        rewrites_hour = hour_sum("rewrite")
        cache = {
            "zoneReadsHour": hour_sum("cache:zoneread"),
            "zoneFetchesHour": by_category.get("map", 0),
        }
        waits_hour = sorted(w for t, w, _p in METRICS_WAITS if t > now - 3600)
        upstream_hour = [(e, ok) for t, e, ok in METRICS_UPSTREAM if t > now - 3600]
        top_users = []
        for key, buckets in METRICS_USER_MINUTES.items():
            last_min = buckets.get(minute, 0) + buckets.get(minute - 1, 0)
            last_hour = sum(count for m, count in buckets.items() if m in hour_minutes)
            if last_hour > 0:
                top_users.append({"key": key, "lastMinute": last_min, "lastHour": last_hour})
        top_users.sort(key=lambda entry: (-entry["lastHour"], entry["key"]))

    upstream_latencies = sorted(e for e, _ok in upstream_hour)
    upstream_errors = sum(1 for _e, ok in upstream_hour if not ok)
    return {
        **bym_call_stats(),
        "queue": {
            "depth": len(waiters),
            "byBand": bands,
            "oldestWaitSec": round(oldest_wait, 1),
        },
        "waits": {
            "count": len(waits_hour),
            "p50Ms": round(_percentile(waits_hour, 0.50)),
            "p90Ms": round(_percentile(waits_hour, 0.90)),
            "maxMs": round(waits_hour[-1]) if waits_hour else 0,
        },
        "rejects": rejects,
        "upstream": {
            "count": len(upstream_hour),
            "errorsHour": upstream_errors,
            "avgMs": round(sum(upstream_latencies) / len(upstream_latencies)) if upstream_latencies else 0,
            "p90Ms": round(_percentile(upstream_latencies, 0.90)),
        },
        "rewritesHour": rewrites_hour,
        "byCategory": by_category,
        "byPriority": by_priority,
        "cache": cache,
        "topUsers": top_users[:10],
    }


# Admin-tunable settings live in admin/settings.json. acquire_bym_slot reads
# them inside its wait loop and enforce_rate_limit on every request, so the
# file is read through a short-TTL cache instead of hitting disk each time.
# Saving settings from /setup/ invalidates the cache immediately.
SETTINGS_CACHE = {"data": None, "at": 0.0}
SETTINGS_CACHE_TTL = 2.0
SETTINGS_CACHE_LOCK = threading.Lock()

# Every tunable: name -> (default, min, max). One table drives the getters,
# the admin GET/POST validation, and the /setup/ form, so adding a knob is a
# one-line change.
DEFAULT_BYM_MAX_QUEUE_DEPTH = max(1, int(os.environ.get("BYM_MAX_QUEUE_DEPTH", "200") or 200))
DEFAULT_BYM_MAX_QUEUE_DEPTH_PER_USER = max(1, int(os.environ.get("BYM_MAX_QUEUE_DEPTH_PER_USER", "40") or 40))
DEFAULT_BYM_MAX_WAIT_SECONDS = max(5, int(os.environ.get("BYM_MAX_WAIT_SECONDS", "600") or 600))
SETTINGS_FIELD_RULES = {
    # Game-API budget
    "maxApiPerMinute": (DEFAULT_MAX_API_PER_MINUTE, 1, 600),
    "maxApiPerMinutePerUser": (DEFAULT_MAX_API_PER_MINUTE_PER_USER, 1, 600),
    # Ceilings for priorities 1-5 and 6-8 inside that allowance. Priorities
    # 9-10 have no band ceiling of their own.
    "maxLowPriorityPerMinutePerUser": (DEFAULT_MAX_LOW_PER_MINUTE_PER_USER, 1, 600),
    "maxMediumPriorityPerMinutePerUser": (DEFAULT_MAX_MEDIUM_PER_MINUTE_PER_USER, 1, 600),
    "bymMaxQueueDepth": (DEFAULT_BYM_MAX_QUEUE_DEPTH, 1, 2000),
    "bymMaxQueueDepthPerUser": (DEFAULT_BYM_MAX_QUEUE_DEPTH_PER_USER, 1, 500),
    "bymMaxWaitSeconds": (DEFAULT_BYM_MAX_WAIT_SECONDS, 5, 600),
    # Viewer's own endpoints (token-bucket limits, previously hardcoded)
    "viewerUserPerMin": (90, 10, 2000),
    "viewerUserBurst": (30, 5, 500),
    "viewerIpPerMin": (60, 5, 2000),
    "viewerIpBurst": (20, 5, 500),
    "viewerLogPerMin": (10, 1, 100),
    # How many unfiltered full-world cache reads may run at once
    "fullMapConcurrency": (max(1, int(os.environ.get("BYM_FULL_MAP_CONCURRENCY", "8") or 8)), 1, 64),
    # Pushed to browsers at sign-in (0 = automatic)
    "clientZonePace": (0, 0, 600),         # 0: follow the per-user API limit
    "clientZoneConcurrency": (0, 0, 12),   # 0: client default (4)
    # 1: names in admin/admins.json skip every limit above (see
    # requester_bypasses_limits). 0: admins queue like everyone else.
    "adminBypassLimits": (1, 0, 1),
    # How many days of hourly usage history to keep on disk. Files past this
    # are deleted on startup; roughly 20-40 KB per day.
    "metricsRetentionDays": (30, 1, 400),
    # --- Honeypot bans -------------------------------------------------
    # 1: a request for a honeypot path (see HONEYPOT_PATTERNS) bans the
    # client IP for banFirstMinutes, doubling on repeat up to banMaxMinutes.
    # 0: honeypot hits are counted and logged but nothing is blocked, which
    # is the setting to run first - watch banHistory for a day and confirm
    # nothing legitimate is being caught before switching this on.
    "honeypotBansEnabled": (0, 0, 1),
    "banFirstMinutes": (60, 1, 10080),
    "banMaxMinutes": (10080, 1, 525600),   # one week default, one year ceiling
    # Repeat offences double the previous term. An IP is "repeat" while its
    # record is remembered, which is banMaxMinutes past its last expiry.
    "banStrikeDecayHours": (168, 1, 8760),
    # --- Operator console ----------------------------------------------
    # Hours of request history kept in admin/ops.db. 48h of a quiet site
    # is a few MB; the writer prunes past this every 5 minutes.
    "opsLogRetentionHours": (48, 1, 8760),
    # What still reaches stdout once the console exists:
    #   2 = every request, as before
    #   1 = only errors (>=400) and non-tunnel requests  [default]
    #   0 = nothing per-request; startup, warnings and [tunnel]/[honeypot]
    #       notices only
    # The point of the console is that the terminal no longer has to be read,
    # so the default is quiet enough to leave a journal running without it
    # filling up. Every request is still recorded either way - this controls
    # printing, never recording.
    "journalRequestLines": (1, 0, 2),
}


def load_settings() -> dict:
    now = time.monotonic()
    with SETTINGS_CACHE_LOCK:
        if SETTINGS_CACHE["data"] is not None and now - SETTINGS_CACHE["at"] < SETTINGS_CACHE_TTL:
            return SETTINGS_CACHE["data"]
    data = read_json(admin_dir() / "settings.json", {})
    if not isinstance(data, dict):
        data = {}
    with SETTINGS_CACHE_LOCK:
        SETTINGS_CACHE["data"] = data
        SETTINGS_CACHE["at"] = now
    return data


def invalidate_settings_cache() -> None:
    with SETTINGS_CACHE_LOCK:
        SETTINGS_CACHE["at"] = 0.0
        SETTINGS_CACHE["data"] = None


def get_setting(field: str) -> int:
    default, low, high = SETTINGS_FIELD_RULES[field]
    try:
        value = int(load_settings().get(field, default))
    except (TypeError, ValueError):
        value = default
    return max(low, min(high, value))


def get_max_api_per_minute() -> int:
    return get_setting("maxApiPerMinute")


def get_max_api_per_minute_per_user() -> int:
    return get_setting("maxApiPerMinutePerUser")


def auth_reserve(limit: int) -> int:
    """Slots held back from the queue so ungated calls fit inside the budget.

    record_bym_call() never blocks, so before this existed a burst of token
    verifications could push the window past maxApiPerMinute and stall every
    queued map fetch until entries expired - the one place the cap was not
    actually a cap. Reserving a slice for it instead means the total stays
    within the configured limit; map traffic simply gets the remainder.
    """
    return min(5, max(1, limit // 10))


def record_bym_call() -> None:
    # Counts a call against the GLOBAL sliding window WITHOUT gating. Used by
    # token verification: if it queued like map traffic, a saturated budget
    # would lock everyone out of signing in - including the admin trying to
    # reach the console to raise the limit. The call is still recorded, so the
    # following map fetches absorb the cost and the per-minute average never
    # exceeds the configured cap.
    #
    # Per-user attribution is deliberately separate: at the moment a token is
    # verified we do not yet know whose token it is. Callers that learn the
    # owner attribute the call afterwards via attribute_bym_call(); calls with
    # no owner at all (the shared /worlds cache refresh) stay global-only.
    with BYM_CALL_LOCK:
        now = time.monotonic()
        while BYM_CALL_TIMES and BYM_CALL_TIMES[0] <= now - BYM_WINDOW_SECONDS:
            BYM_CALL_TIMES.pop(0)
        BYM_CALL_TIMES.append(now)
        note_bym_history()


def attribute_bym_call(user_key: str, priority: int = 10) -> None:
    """Charges an already-recorded global call to a user's per-minute window.

    Without this, an ungated call (token verification) spends shared budget
    that never appears in the caller's own window, so per-user fairness
    under-counts exactly the traffic a client can generate most cheaply by
    reconnecting. Pairs with record_bym_call(), which does the global half.
    """
    if not user_key:
        return
    with BYM_CALL_LOCK:
        now = time.monotonic()
        calls = BYM_USER_CALLS.setdefault(user_key, [])
        cutoff = now - BYM_WINDOW_SECONDS
        while calls and calls[0][0] <= cutoff:
            calls.pop(0)
        calls.append((now, priority_band(priority)))


# Outbound call priority: 1 = lowest, 10 = highest. Higher priorities are
# dequeued first when the per-minute budget is contended.
BYM_PRIORITY_MIN = 1
BYM_PRIORITY_MAX = 10

# Anti-starvation aging. Strict priority alone means a priority-1 zone on a
# busy server can lose every contest until its deadline and 429 forever, so a
# waiter's EFFECTIVE priority climbs one step for each
# (bymMaxWaitSeconds / BYM_AGE_STEPS) seconds it has been parked. Sizing it
# off the deadline rather than a fixed interval means the promotion always
# spans the wait, whatever the deadline is set to, and adds no new knob.
#
# The ceiling is the point: aging lets background work overtake OTHER
# background work, never a base the player just clicked. Tiers 9 and 10 are
# reserved for calls someone is actively waiting on and are never reachable
# by waiting.
BYM_AGE_STEPS = 8
BYM_AGE_CEILING = 8


def _effective_priority(base: int, started: float, now: float, max_wait: float) -> int:
    """Priority as scheduled right now: assigned tier plus accrued age."""
    if base >= BYM_AGE_CEILING:
        return base
    step = max(1.0, float(max_wait) / BYM_AGE_STEPS)
    return min(BYM_AGE_CEILING, base + int(max(0.0, now - started) / step))


def _outranks(left: tuple, right: tuple, now: float, max_wait: float) -> bool:
    """True when waiter `left` should be served before waiter `right`."""
    left_priority = _effective_priority(-left[0], left[3], now, max_wait)
    right_priority = _effective_priority(-right[0], right[3], now, max_wait)
    if left_priority != right_priority:
        return left_priority > right_priority
    return left[1] < right[1]  # same effective tier: whoever asked first


def _retry_after_estimate(position: int) -> int:
    """Rough seconds until a request at this queue position could be served,
    for a 429's Retry-After. Call with BYM_CALL_LOCK held."""
    limit = max(1, get_max_api_per_minute())
    return max(2, min(600, int((position + 1) * BYM_WINDOW_SECONDS / limit) + 1))


def acquire_bym_slot(priority: int = BYM_PRIORITY_MIN, user_key: str = "anon") -> tuple:
    """Waits for an outbound-call slot within BOTH the global sliding minute
    window and the caller's per-user window.

    Returns (ok, reason, waited_seconds, retry_after_seconds); reason is one
    of "ok", "queue-full", "user-queue-full", "timeout".

    Scheduling is STRICT priority: slots go to the highest-priority ELIGIBLE
    waiter, ties to whoever asked first; low priorities may wait the full
    window under sustained high-priority load (by design). A user who has
    exhausted their personal window never blocks other users from the
    remaining global budget, regardless of priority (no head-of-line
    blocking).

    Each parked waiter occupies a server thread, so the queue is BOUNDED
    (globally and per user, admin-tunable): beyond the bound the caller gets
    an instant rejection with a Retry-After estimate instead of a parked
    thread that could not be served any sooner anyway.

    Waiting is event-driven, not polled: a waiter sleeps until the earliest
    instant anything can change - the oldest global or per-user window entry
    expiring, its own deadline, a slot being taken (notify), a waiter leaving
    (notify), or a settings change (notify) - so freed slots hand off
    immediately.
    """
    started = time.monotonic()
    max_wait = get_setting("bymMaxWaitSeconds")
    deadline = started + max_wait
    entry = (-int(priority), next(BYM_WAITER_SEQ), user_key, started)
    with BYM_CALL_LOCK:
        depth = len(BYM_WAITERS)
        if depth >= get_setting("bymMaxQueueDepth"):
            return (False, "queue-full", 0.0, _retry_after_estimate(depth))
        user_depth = sum(1 for waiting in BYM_WAITERS if waiting[2] == user_key)
        if user_depth >= get_setting("bymMaxQueueDepthPerUser"):
            return (False, "user-queue-full", 0.0, _retry_after_estimate(user_depth))

        if len(BYM_USER_CALLS) > BYM_USER_CALLS_SWEEP_AT:
            cutoff = time.monotonic() - BYM_WINDOW_SECONDS
            for stale in [k for k, v in BYM_USER_CALLS.items()
                          if not v or v[-1][0] <= cutoff]:
                BYM_USER_CALLS.pop(stale, None)
        BYM_WAITERS.append(entry)
        try:
            while True:
                # Leave headroom for the ungated sign-in path so a burst of
                # token verifications cannot push the window past the cap.
                limit = get_max_api_per_minute()
                limit = max(1, limit - auth_reserve(limit))
                per_user = get_max_api_per_minute_per_user()
                now = time.monotonic()
                while BYM_CALL_TIMES and BYM_CALL_TIMES[0] <= now - BYM_WINDOW_SECONDS:
                    BYM_CALL_TIMES.pop(0)
                if (len(BYM_CALL_TIMES) < limit
                        and user_window_free(user_key, per_user, now, priority)):
                    # Our turn only if nobody strictly ahead of us (higher
                    # priority, or same priority but earlier) is eligible too.
                    ahead_eligible = any(
                        _outranks(waiting, entry, now, max_wait)
                        and user_window_free(waiting[2], per_user, now, -waiting[0])
                        for waiting in BYM_WAITERS
                    )
                    if not ahead_eligible:
                        BYM_CALL_TIMES.append(now)
                        BYM_USER_CALLS.setdefault(user_key, []).append(
                            (now, priority_band(priority)))
                        note_bym_history()
                        # Wake the outranked so they recompute their wait
                        # against the now-smaller window headroom.
                        BYM_CALL_LOCK.notify_all()
                        return (True, "ok", now - started, 0)
                if now >= deadline:
                    ahead = sum(1 for waiting in BYM_WAITERS
                                if _outranks(waiting, entry, now, max_wait))
                    return (False, "timeout", now - started, _retry_after_estimate(ahead))
                # Sleep until the next instant capacity can appear on its own.
                # Notifications cover every other state change; the 5s cap is
                # belt-and-braces against clock arithmetic surprises.
                wakeups = [deadline]
                if BYM_CALL_TIMES:
                    wakeups.append(BYM_CALL_TIMES[0] + BYM_WINDOW_SECONDS)
                own_calls = BYM_USER_CALLS.get(user_key)
                if own_calls:
                    # Wake when our oldest call expires; if the band is what is
                    # holding us, wake when the oldest call in OUR band expires
                    # instead, which is later.
                    wakeups.append(own_calls[0][0] + BYM_WINDOW_SECONDS)
                    own_band = priority_band(priority)
                    band_times = [t for t, b in own_calls if b == own_band]
                    if band_times and band_limit(own_band) > 0:
                        wakeups.append(band_times[0] + BYM_WINDOW_SECONDS)
                # Aging can promote us with nothing else changing, so wake at
                # our own next age step too.
                if -entry[0] < BYM_AGE_CEILING:
                    step = max(1.0, float(max_wait) / BYM_AGE_STEPS)
                    wakeups.append(now + step - ((now - started) % step))
                BYM_CALL_LOCK.wait(timeout=max(0.05, min(min(wakeups) - now, 5.0)))
        finally:
            # Defensive: this runs on every exit path, and a raise here would
            # both leak a queue slot and kill the serving thread.
            try:
                BYM_WAITERS.remove(entry)
            except ValueError:
                pass
            BYM_CALL_LOCK.notify_all()
# The game's API path embeds the version (/api/v1.6.8-beta/...), so pinning it
# means every BYMR release 404s the viewer until someone edits the env var. The
# official launcher does not pin: it reads currentGameVersion from the CDN
# manifest and builds the path from that. Do the same, with the pin kept as an
# override for testing against a specific version.
BYM_VERSION_MANIFEST = os.environ.get(
    "BYM_VERSION_MANIFEST", "cdn.bymrefitted.com/versionManifest.json"
).lstrip("/")
BYM_API_VERSION_PIN = os.environ.get("BYM_API_VERSION", "").strip("/")
BYM_API_VERSION_FALLBACK = "v1.6.9-beta"
# Re-checked periodically: the process can outlive a game release.
BYM_VERSION_TTL = 3600
_BYM_VERSION = {"value": "", "checked": 0.0}
_BYM_VERSION_LOCK = threading.Lock()


def bym_api_version(force: bool = False) -> str:
    """The API version segment, discovered from the CDN manifest.

    Read-only GET to the CDN. It touches no game account, mints no token and
    is not authenticated - the launcher fetches the same file before login.

    HTTPS first, then HTTP, matching the launcher. On any failure the last
    known good value is reused, falling back to the pin so a CDN outage
    degrades to current behaviour rather than taking the viewer down.
    """
    if BYM_API_VERSION_PIN:
        return BYM_API_VERSION_PIN
    now = time.time()
    with _BYM_VERSION_LOCK:
        cached = _BYM_VERSION["value"]
        if cached and not force and (now - _BYM_VERSION["checked"]) < BYM_VERSION_TTL:
            return cached
        # Mark the attempt before releasing, so a burst of requests does not
        # each fire their own manifest fetch on a cold start.
        _BYM_VERSION["checked"] = now
    for scheme in ("https", "http"):
        try:
            request = urllib.request.Request(
                f"{scheme}://{BYM_VERSION_MANIFEST}",
                headers={"User-Agent": BYM_USER_AGENT, "Accept": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=10) as response:
                payload = json.loads(response.read().decode("utf-8", "replace"))
            version = str(payload.get("currentGameVersion") or "").strip()
            if version:
                resolved = f"v{version}-beta"
                with _BYM_VERSION_LOCK:
                    if resolved != _BYM_VERSION["value"]:
                        print(f"[bym] game version {version} -> /api/{resolved}")
                    _BYM_VERSION["value"] = resolved
                return resolved
        except Exception as error:
            last = error
            continue
    with _BYM_VERSION_LOCK:
        stale = _BYM_VERSION["value"]
    if stale:
        return stale
    print(f"[bym] version manifest unavailable ({last}); "
          f"falling back to {BYM_API_VERSION_FALLBACK}")
    return BYM_API_VERSION_FALLBACK
# The game server is behind Cloudflare, which rejects the default
# "Python-urllib/x.y" User-Agent with error 1010 ("banned browser signature").
# Identify honestly to the BYM servers: a distinct product token lets the
# maintainer monitor, throttle, or sandbox viewer traffic independently of
# real game clients (as offered to him directly). Keep the browser-like
# suffix for any middleware that expects a Mozilla signature. Overridable
# via env if he ever issues a specific identifier.
BYM_USER_AGENT = os.environ.get(
    "BYM_USER_AGENT",
    "BYM-MR2-Viewer/1.0 (community map viewer; Mozilla/5.0 compatible)",
)
# Shown to a player refused by the sign-in whitelist. Kept friendly and
# non-technical: their game account is fine, they just are not on this
# viewer's temporary access list.
WHITELIST_DENIED_MESSAGE = os.environ.get(
    "BYM_WHITELIST_MESSAGE",
    "This viewer is currently limited to an approved list of players. "
    "Your game account is unaffected - ask an administrator to be added.",
)
TOKEN_CACHE_TTL = 600  # seconds
PROXY_TIMEOUT = 20  # seconds for upstream game-API requests via /proxy
TOKEN_CACHE: dict = {}
TOKEN_CACHE_LOCK = threading.Lock()
# Why the last verification of a given token failed: "expired" (rejected - sign
# in again), "rejected" (server refused for another reason), "transport" (never
# reached it). Read by token_failure_reason(); guarded by TOKEN_CACHE_LOCK.
LAST_TOKEN_FAILURE: dict = {}


def verify_bym_token(token: str):
    """Returns (username_or_None, current_valid_token) for a BYM session token.

    The game's player/getinfo endpoint MINTS A NEW TOKEN on every call and
    invalidates the previous one (it is the login controller). So verifying a
    token here rotates it: whatever token the caller presented is no longer the
    active session afterwards - the freshly minted one is. We therefore return
    that minted token as the "current valid" token so the caller can adopt it,
    and we cache the result under BOTH the presented token and the minted token.
    Caching under the minted token means a follow-up request that presents it
    hits the cache instead of calling getinfo again (which would rotate it once
    more and break the caller's now-active session).
    """
    token = str(token or "").strip()
    if not token:
        return (None, "")

    now = time.time()
    with TOKEN_CACHE_LOCK:
        cached = TOKEN_CACHE.get(token)
        if cached and cached[2] > now:
            return (cached[0], cached[1])

    username = None
    current_token = token
    record_bym_call()
    metric_inc("cat:auth")
    # player/getinfo is priority 10 (it is the login/session call); it is
    # recorded against the window rather than queued, so it never blocks.
    verify_url = f"{BYM_BASE_URL}/api/{bym_api_version()}/player/getinfo"
    # How the verification failed, so callers can tell "log in again" from
    # "the game server is unreachable". Mirrors the launcher's split between
    # SessionExpired (the token was rejected - rotation moved past us, clear
    # it and re-authenticate) and AuthError (everything else).
    #   ""          verified
    #   "expired"   token rejected; the client should sign in again
    #   "rejected"  reached the server, but it refused for another reason
    #   "transport" never got an answer; the token may still be perfectly good
    failure = "transport"
    try:
        request = urllib.request.Request(
            verify_url,
            data=urllib.parse.urlencode({"token": token, "sessionType": "game"}).encode(),
            headers={
                "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
                "User-Agent": BYM_USER_AGENT,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
        candidate = str(payload.get("username", "")).strip()
        minted = str(payload.get("token", "")).strip()
        if candidate and not payload.get("error"):
            username = candidate
            failure = ""
            # The game keys identity on the immutable numeric userid; the
            # username is just its current label (renames are allowed). This
            # response came from the game server itself, so the pair is
            # authoritative - record it, and if the name moved since it was
            # last seen, migrate every per-name store BEFORE the caller acts
            # on the new name (whitelist checks, users/{name}/ reads, ...).
            record_user_identity(payload.get("userid", payload.get("userId", 0)), username)
            # Now that the owner is known, charge the getinfo call we already
            # counted globally to their per-minute window too.
            attribute_bym_call(f"user:{username.lower()}")
            if minted:
                current_token = minted
        else:
            # 200 OK but no usable username (e.g. the game server returned an
            # error field or an empty name). Log what it actually said.
            failure = "expired"
            print(f"[admin] token verification: {verify_url} returned no username: {payload!r}")
    except urllib.error.HTTPError as error:
        # 4xx/5xx from the game server - read the body so the reason (bad API
        # version, invalid token, ...) is visible instead of a bare HTTPError.
        try:
            detail = error.read().decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001
            detail = "<no body>"
        # 401/403 is the token being refused; anything else (404 from a stale
        # API version, 5xx) is not the player's fault and must not present as
        # "your session expired".
        failure = "expired" if error.code in (401, 403) else "rejected"
        if error.code == 404:
            # A version bump moves the API path, so re-check the manifest
            # rather than serving 404s until the process restarts.
            bym_api_version(force=True)
        print(f"[admin] token verification failed: HTTP {error.code} from {verify_url}: {detail}")
    except Exception as error:  # noqa: BLE001 - TLS/DNS/timeout/etc = not authed
        # Common here: SSLCertVerificationError when the Python host lacks a CA
        # bundle even though a browser (with its own trust store) can reach the
        # same URL. Also covers DNS failures, timeouts, and blocked egress.
        failure = "transport"
        print(f"[admin] token verification failed: {error!r} ({verify_url})")

    with TOKEN_CACHE_LOCK:
        # Cache failures briefly too, so a bad token cannot hammer the BYM
        # server - but never cache a transport failure. Doing so pins a good
        # token as "invalid" for a minute because the network blipped once.
        if username or failure != "transport":
            entry = (username, current_token, now + (TOKEN_CACHE_TTL if username else 60))
            TOKEN_CACHE[token] = entry
            if username and current_token != token:
                # Recognise the minted token on the next request without re-minting.
                TOKEN_CACHE[current_token] = entry
        if len(TOKEN_CACHE) > 500:
            for key in list(TOKEN_CACHE)[:100]:
                TOKEN_CACHE.pop(key, None)
        LAST_TOKEN_FAILURE[token] = failure
        if len(LAST_TOKEN_FAILURE) > 500:
            for key in list(LAST_TOKEN_FAILURE)[:100]:
                LAST_TOKEN_FAILURE.pop(key, None)
    return (username, current_token)


def token_failure_reason(token: str) -> str:
    """Why verify_bym_token() last rejected this token; "" if it verified.

    Lets a caller answer "your session expired, sign in again" only when the
    game server actually said so, rather than for a DNS blip.
    """
    with TOKEN_CACHE_LOCK:
        return LAST_TOKEN_FAILURE.get(str(token or "").strip(), "")

# Bumped whenever server-side routes change, so clients can detect that a
# stale dev_server.py process is still running after an update.
SERVER_VERSION = "2026-08-03-username-changes"

AUDIT_LIMIT = 500


def admin_dir() -> "Path":
    path = STORAGE_ROOT / "admin"
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_hidden_players() -> list:
    payload = read_json(admin_dir() / "hidden_players.json", {"players": []})
    players = payload.get("players") if isinstance(payload, dict) else None
    return players if isinstance(players, list) else []


def load_admin_users() -> set:
    """The editable admin allowlist (case-insensitive game usernames).

    Stored in admin/admins.json as {"admins": [...]}. On first run (or if the
    file is missing/corrupt) it is seeded from BYM_ADMIN_USERS - which may be
    empty, in which case there are no admins until one is added (set the env var
    or edit admin/admins.json). No admin names are hardcoded in the source.
    """
    path = admin_dir() / "admins.json"
    payload = read_json(path, None)
    names = payload.get("admins") if isinstance(payload, dict) else None
    if not isinstance(names, list):
        names = sorted(SEED_ADMIN_USERS)
        # Idempotent, atomic first-run seed; safe without the storage lock.
        atomic_write_json(path, {"admins": names})
    return {str(name).strip() for name in names if str(name).strip()}


def admin_name_set_lower() -> set:
    return {name.lower() for name in load_admin_users()}


def hidden_name_set() -> set:
    return {
        str(entry.get("name", "")).strip().lower()
        for entry in load_hidden_players()
        if isinstance(entry, dict) and str(entry.get("name", "")).strip()
    }


# ---------------------------------------------------------------------------
# Sign-in whitelist (temporary access control).
#
# When enabled, only listed in-game usernames may establish a session through
# this viewer. Enforcement happens at the one choke point every sign-in must
# pass: a successful player/getinfo relayed by /proxy. The game server itself
# is untouched - this only gates who may use THIS viewer.
#
# Deliberate carve-outs:
#   * Administrators are always allowed, so enabling the list can never lock
#     you out of /setup/ (where you turn it back off).
#   * Guest browsing of the cached map is unaffected; it needs no session.
# ---------------------------------------------------------------------------
def load_whitelist() -> dict:
    data = read_json(admin_dir() / "whitelist.json", {})
    if not isinstance(data, dict):
        data = {}
    names = [str(n).strip() for n in data.get("names", []) if str(n).strip()]
    return {"enabled": bool(data.get("enabled")), "names": sorted(set(names), key=str.lower)}


def whitelist_blocks(username: str) -> bool:
    """True if this player must be refused a session."""
    state = load_whitelist()
    if not state["enabled"]:
        return False
    low = str(username or "").strip().lower()
    if not low:
        return False
    if low in admin_name_set_lower():
        return False
    return low not in {n.lower() for n in state["names"]}


def append_audit(admin: str, action: str, detail: str) -> None:
    path = admin_dir() / "audit.json"
    # Take the storage lock: this is a read-modify-write, and every caller
    # invokes it after releasing the lock, so two concurrent admin actions
    # could otherwise drop each other's audit entries.
    with STORAGE_LOCK:
        entries = read_json(path, [])
        if not isinstance(entries, list):
            entries = []
        entries.append({
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "admin": admin,
            "action": action,
            "detail": detail,
        })
        atomic_write_json(path, entries[-AUDIT_LIMIT:])


def sanitize_name(raw: str) -> str | None:
    """Turns an untrusted server/user name into a safe single path segment.

    The client sends names URL-encoded, so decode first; anything the decode
    reintroduces (slashes, dots, control characters) is then neutralized.
    """
    name = SAFE_NAME_RE.sub("_", unquote(str(raw or "")).strip()).strip(" .")
    if not name or name in {".", ".."} or len(name) > 80:
        return None
    return name


def atomic_write_json(path: Path, payload: object) -> None:
    # The temp name must be unique per writer. This runs under
    # ThreadingHTTPServer, so two requests touching the same file (two admins
    # saving settings, two zone uploads for one cache file) otherwise both
    # write "<name>.tmp" and both rename it: one truncates the other's
    # half-written file, and os.replace on an already-renamed temp raises
    # FileNotFoundError. Under load that surfaces as lost saves and, briefly,
    # an unreadable file for anyone reading concurrently.
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(
        f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
    )
    try:
        with temp_path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        # Owner-only, set on the temp file BEFORE the rename so the finished
        # file is never briefly world-readable. Storage holds session records,
        # login history, the whitelist and per-user settings; on a shared or
        # multi-user host the default 0644 exposes all of it to any local
        # account. Best-effort: Windows ignores the mode bits, and a failure
        # here must not lose the write.
        try:
            os.chmod(temp_path, 0o600)
        except OSError:
            pass
        os.replace(temp_path, path)
    except BaseException:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def read_json(path: Path, fallback: object) -> object:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return fallback


# Fields never persisted to the shared cache:
#   m    - monster-housing blob; the viewer never reads it and it dominates size
#   mine - per-session ownership flag; sharing it would paint one user's bases
#          blue for everyone (the client re-derives it from uid)
#   hiddenDisguise - per-session render memo naming the wild monster cell a
#          moderation-hidden base is masquerading as. The client drops it
#          (map-renderer.js CELL_CACHE_DROP_KEYS) because uploading it leaks
#          which cells are hidden and which tribe they pretend to be, but the
#          server minifies whatever a client actually sends, so the rule has
#          to exist on both sides -- exactly the client/server disagreement
#          that let bid get stripped. It also holds a *reference* to another
#          cell object, so persisting it nests a whole record.
# bid (the base id string) is KEPT: the View Yard/Outpost feature loads a
# base via /base/load with it, so cached cells must carry it.
CELL_DROP_KEYS = {"m", "mine", "blendedHeight", "hiddenDisguise"}
# Avatar-ish fields are only meaningful once per player; keeping them on the
# main yard alone shrinks cached zones (outposts of prolific players would
# otherwise repeat the same URL dozens of times).
CELL_PIC_KEYS = {"pic_square", "im", "pic", "picSquare", "avatar", "avatarUrl", "img", "picture"}
CELL_MAIN_YARD = 2
# Kept even when zero so a cell is always addressable and drawable.
CELL_KEEP_KEYS = {"x", "y", "i"}


def minify_cell(cell: dict) -> dict:
    """Drops dead fields and zero/empty defaults; the client's normalizeCell
    re-adds every default on restore, so the round trip is lossless."""
    out = {}
    for key, value in cell.items():
        if key in CELL_DROP_KEYS:
            continue
        if key in CELL_PIC_KEYS:
            try:
                is_main = int(cell.get("b", 0) or 0) == CELL_MAIN_YARD
            except (TypeError, ValueError):
                is_main = False
            if not is_main:
                continue
        if key not in CELL_KEEP_KEYS and value in (0, None, "", [], {}):
            continue
        out[key] = value
    return out


# MR2 world geometry, mirrored from the client (shared.js MR2.zoneSize /
# mapWidth/mapHeight): zones are ZONE_SIZE x ZONE_SIZE cells and a zone is
# addressed by its origin cell, a multiple of ZONE_SIZE. Worlds are square,
# 800 cells per side today; BYM_MAX_MAP_SIZE exists so a larger future world
# doesn't need a code change to pass validation.
ZONE_SIZE = 10
try:
    MAX_MAP_SIZE = int(os.environ.get("BYM_MAX_MAP_SIZE", "800"))
except ValueError:
    MAX_MAP_SIZE = 800


def valid_zone_origin(zone_x: int, zone_y: int) -> bool:
    return (
        0 <= zone_x < MAX_MAP_SIZE
        and 0 <= zone_y < MAX_MAP_SIZE
        and zone_x % ZONE_SIZE == 0
        and zone_y % ZONE_SIZE == 0
    )


# ---------------------------------------------------------------------------
# Known worlds, for validating cache-directory creation. The cache is keyed
# by the game's world uuid (the client's mapMeta.worldid); a new server_*
# directory may only be created for a uuid the game's /worlds endpoint
# currently reports. The list is tiny (four worlds today) and near-static,
# so it is cached for KNOWN_WORLDS_TTL; a failed fetch is retried sooner and
# fails CLOSED (no new directories until the game server answers) - existing
# directories are never re-checked, so a world later removed upstream keeps
# accepting updates for the players still on it.
# ---------------------------------------------------------------------------
KNOWN_WORLDS_TTL = 600  # seconds a successful world list is trusted
KNOWN_WORLDS_FAIL_TTL = 60  # seconds before retrying after a failed fetch
KNOWN_WORLDS_LOCK = threading.Lock()
_KNOWN_WORLDS = {"at": 0.0, "ids": set(), "ok": False}


def known_world_ids():
    """Returns (uuid_set_lowercased, fetch_ok). Cached; one upstream call per
    TTL at most, counted against the BYM rate window like every other call."""
    now = time.time()
    with KNOWN_WORLDS_LOCK:
        ttl = KNOWN_WORLDS_TTL if _KNOWN_WORLDS["ok"] else KNOWN_WORLDS_FAIL_TTL
        if now - _KNOWN_WORLDS["at"] < ttl:
            return (set(_KNOWN_WORLDS["ids"]), _KNOWN_WORLDS["ok"])

    ids: set = set()
    ok = False
    # Server-wide cache refresh on a TTL, not attributable to any one player:
    # global window only, by design.
    record_bym_call()
    worlds_url = f"{BYM_BASE_URL}/api/{bym_api_version()}/worlds"
    try:
        request = urllib.request.Request(
            worlds_url,
            headers={
                "User-Agent": BYM_USER_AGENT,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )
        with urllib.request.urlopen(request, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
        worlds = payload.get("worlds") if isinstance(payload, dict) else None
        for world in worlds if isinstance(worlds, list) else []:
            uuid = sanitize_name(str((world or {}).get("uuid", "")))
            if uuid:
                ids.add(uuid.lower())
        ok = True
    except Exception as error:  # noqa: BLE001 - DNS/TLS/timeout/bad JSON
        print(f"[worlds] fetch failed: {error!r} ({worlds_url})")

    with KNOWN_WORLDS_LOCK:
        _KNOWN_WORLDS.update(at=now, ids=ids, ok=ok)
    return (set(ids), ok)


def server_map_dir(server_name: str) -> Path:
    return STORAGE_ROOT / f"server_{server_name}" / "zones"


def user_dir(username: str) -> Path:
    return STORAGE_ROOT / "users" / username


# ---------------------------------------------------------------------------
# Username changes.
#
# BYM Refitted allows a player to rename their account (once per cooldown
# period). The game keeps identity on the immutable numeric `userid`; only the
# display name moves. This viewer historically keyed EVERYTHING on the name -
# users/{name}/ storage, alliance rosters, the admin allowlist, the sign-in
# whitelist, hidden players, hide requests and per-world activity - so a
# rename used to silently orphan all of it.
#
# The fix is an identity index, users_index.json at the storage root (NOT
# inside users/, where a player literally named "index.json" could collide):
#
#   {"<userid>": {"name": "Current", "previous": ["Old", ...], "updatedAt"}}
#
# The index is fed ONLY from player/getinfo responses that came from the game
# server itself (token verification, and successful sign-ins relayed through
# /proxy). It is never fed from client-posted map cells: zone uploads are
# authenticated but their CONTENT is client-supplied, so trusting a cell's
# uid->name pair to drive a rename would let any signed-in user forge a cell
# claiming an admin's uid now carries the attacker's name - and the migration
# below would then hand them the admin allowlist entry. Verification-driven
# renames close the moment the renamed player next touches the viewer, which
# is exactly when their per-name data starts to matter again.
#
# When a verified (userid, name) disagrees with the index, migrate_username()
# rewrites every copy of the old name the viewer owns - the same contract the
# game server's renameUser service applies to its own tables. Renames that
# predate this index (no recorded uid to compare against) can be applied by
# hand from the admin console (POST /api/admin/rename-user).
# ---------------------------------------------------------------------------
USERS_INDEX_FILE = "users_index.json"


def users_index_path() -> Path:
    return STORAGE_ROOT / USERS_INDEX_FILE


def load_users_index() -> dict:
    index = read_json(users_index_path(), {})
    return index if isinstance(index, dict) else {}


def resolve_current_name(name: str) -> str:
    """The CURRENT username for a possibly out-of-date one, from the index.

    Returns "" when the name is not a recorded previous name of anyone. A
    name that is somebody's current name resolves to itself, so callers can
    treat any non-empty result as authoritative.
    """
    low = str(name or "").strip().lower()
    if not low:
        return ""
    for entry in load_users_index().values():
        if not isinstance(entry, dict):
            continue
        current = str(entry.get("name", "")).strip()
        if current.lower() == low:
            return current
        for previous in entry.get("previous", []):
            if str(previous).strip().lower() == low:
                return current
    return ""


def _rename_in_name_list(items, old_low: str, new: str):
    """Replaces old_low (case-insensitive) with new in a list of names.

    Returns (new_list, changed). Deduplicates a pre-existing copy of the new
    name so a half-applied earlier migration cannot leave the name twice.
    """
    if not isinstance(items, list):
        return (items, False)
    out, changed, seen_new = [], False, False
    for item in items:
        text = str(item)
        if text.strip().lower() == old_low:
            changed = True
            if not seen_new:
                out.append(new)
                seen_new = True
            continue
        if text.strip().lower() == new.strip().lower():
            if seen_new:
                changed = True
                continue
            seen_new = True
        out.append(item)
    return (out, changed)


def migrate_username_locked(old: str, new: str) -> dict:
    """Moves every viewer-owned copy of a username. Caller holds STORAGE_LOCK.

    Mirrors the game server's renameUser transaction for the viewer's own
    stores: the users/{name}/ directory, alliance files (leader, members,
    invites, enemies, the ranks map, chat authors and feed participants), the
    admin allowlist, the sign-in whitelist, hidden players, hide requests and
    per-world activity records. Returns a summary dict for logging/auditing.
    """
    old = str(old or "").strip()
    new = str(new or "").strip()
    summary = {"from": old, "to": new, "userDir": "none", "alliances": 0,
               "admins": False, "whitelist": False, "hidden": False,
               "hideRequests": 0, "activityWorlds": 0}
    if not old or not new or old == new:
        return summary
    old_low = old.lower()
    new_case_only = old_low == new.lower()

    # --- users/{old} -> users/{new} ------------------------------------
    old_safe = sanitize_name(old)
    new_safe = sanitize_name(new)
    if old_safe and new_safe:
        old_dir = user_dir(old_safe)
        new_dir = user_dir(new_safe)
        if new_case_only:
            # Case-only rename. On a case-insensitive filesystem (Windows -
            # this project ships start.bat) both paths are the same directory
            # and rename() just fixes the stored casing; on Linux it is a
            # normal move. Either way there is nothing to archive.
            try:
                if old_dir.is_dir() and old_safe != new_safe:
                    old_dir.rename(new_dir)
                    summary["userDir"] = "moved"
            except OSError as error:  # noqa: PERF203 - one-shot, log and go on
                print(f"[rename] could not recase users/{old_safe}: {error!r}")
        elif old_dir.is_dir():
            if new_dir.exists():
                # Stale data from a PREVIOUS holder of the new name (names are
                # unique in the game at any instant, so this can only be
                # leftovers). Park it outside users/ - the admin overview
                # lists every users/ entry as a viewer account - rather than
                # merging two different players' histories.
                archive_root = STORAGE_ROOT / "users_archived"
                archive_root.mkdir(parents=True, exist_ok=True)
                stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                try:
                    new_dir.rename(archive_root / f"{new_safe}-{stamp}")
                except OSError as error:
                    print(f"[rename] could not archive users/{new_safe}: {error!r}")
            try:
                old_dir.rename(new_dir)
                summary["userDir"] = "moved"
            except OSError as error:
                print(f"[rename] could not move users/{old_safe} -> users/{new_safe}: {error!r}")
        elif new_dir.is_dir():
            summary["userDir"] = "already"

    # --- Alliance files -------------------------------------------------
    alliances = STORAGE_ROOT / "alliances"
    if alliances.is_dir():
        for path in sorted(alliances.glob("*.json")):
            data = read_json(path, None)
            if not isinstance(data, dict):
                continue
            changed = False
            if str(data.get("leader", "")).strip().lower() == old_low:
                data["leader"] = new
                changed = True
            for field in ("members", "invites", "enemies"):
                replaced, did = _rename_in_name_list(data.get(field), old_low, new)
                if did:
                    data[field] = replaced
                    changed = True
            ranks = data.get("ranks")
            if isinstance(ranks, dict) and old_low in ranks and not new_case_only:
                # Ranks are keyed by lowercased name; leader stays out of the
                # map, mirroring member_rank(). Never clobber an existing rank
                # under the new key (dedupe from a half-applied migration).
                ranks.setdefault(new.lower(), ranks.pop(old_low))
                ranks.pop(old_low, None)
                changed = True
            chat = data.get("chat")
            if isinstance(chat, list):
                for message in chat:
                    if isinstance(message, dict) and str(message.get("from", "")).strip().lower() == old_low:
                        message["from"] = new
                        changed = True
            feed = data.get("feed")
            if isinstance(feed, list):
                for event in feed:
                    if not isinstance(event, dict):
                        continue
                    for field in ("playerName", "otherParty", "by"):
                        if str(event.get(field, "")).strip().lower() == old_low:
                            event[field] = new
                            changed = True
            if changed:
                atomic_write_json(path, data)
                summary["alliances"] += 1

    # --- Admin allowlist -------------------------------------------------
    admins_path = admin_dir() / "admins.json"
    payload = read_json(admins_path, None)
    names = payload.get("admins") if isinstance(payload, dict) else None
    if isinstance(names, list):
        replaced, did = _rename_in_name_list(names, old_low, new)
        if did:
            atomic_write_json(admins_path, {"admins": sorted(
                {str(n).strip() for n in replaced if str(n).strip()}, key=str.lower)})
            summary["admins"] = True

    # --- Sign-in whitelist ----------------------------------------------
    whitelist_path = admin_dir() / "whitelist.json"
    data = read_json(whitelist_path, None)
    if isinstance(data, dict):
        replaced, did = _rename_in_name_list(data.get("names"), old_low, new)
        if did:
            data["names"] = sorted({str(n).strip() for n in replaced if str(n).strip()},
                                   key=str.lower)
            atomic_write_json(whitelist_path, data)
            summary["whitelist"] = True

    # --- Hidden players ---------------------------------------------------
    players = load_hidden_players()
    changed = False
    for entry in players:
        if isinstance(entry, dict) and str(entry.get("name", "")).strip().lower() == old_low:
            entry["name"] = new
            changed = True
    if changed:
        atomic_write_json(admin_dir() / "hidden_players.json", {"players": players})
        summary["hidden"] = True

    # --- Hide requests ----------------------------------------------------
    requests_path = admin_dir() / "hide-requests.json"
    requests = read_json(requests_path, [])
    if isinstance(requests, list):
        changed = 0
        for entry in requests:
            if isinstance(entry, dict) and str(entry.get("name", "")).strip().lower() == old_low:
                entry["name"] = new
                changed += 1
        if changed:
            atomic_write_json(requests_path, requests)
            summary["hideRequests"] = changed

    # --- Per-world activity (keyed by lowercased name) --------------------
    if not new_case_only:
        for server_dir in sorted(STORAGE_ROOT.glob("server_*")):
            activity_path = server_dir / "activity.json"
            data = read_json(activity_path, None)
            if not isinstance(data, dict) or old_low not in data:
                continue
            moved = data.pop(old_low)
            existing = data.get(new.lower())
            if isinstance(existing, dict) and isinstance(moved, dict):
                # Both names have records (stale data from a previous holder
                # of the new name). Keep whichever observation is newer, but
                # never lose the older "last increased" stamp entirely.
                newer = moved if int(moved.get("inc", 0) or 0) >= int(existing.get("inc", 0) or 0) else existing
                data[new.lower()] = newer
            else:
                data[new.lower()] = moved
            atomic_write_json(activity_path, data)
            summary["activityWorlds"] += 1

    return summary


def rename_token_cache(old: str, new: str) -> None:
    """Points live cached sessions for old at new, keeping them signed in."""
    old_low = str(old or "").strip().lower()
    if not old_low:
        return
    with TOKEN_CACHE_LOCK:
        for token, entry in list(TOKEN_CACHE.items()):
            if entry and str(entry[0] or "").strip().lower() == old_low:
                TOKEN_CACHE[token] = (new, entry[1], entry[2])


def record_user_identity(userid, username: str) -> str:
    """Notes a VERIFIED (userid, username) pair; migrates data on a rename.

    Called only with pairs the game server itself reported (player/getinfo).
    Returns the previous username when a rename was detected and migrated,
    else "". The player-index cache is dropped after a migration so alliance
    rosters and activity reads see the new name immediately.
    """
    try:
        uid = int(userid)
    except (TypeError, ValueError):
        return ""
    name = str(username or "").strip()
    if uid <= 0 or not name:
        return ""

    renamed_from = ""
    summary = None
    with STORAGE_LOCK:
        index = load_users_index()
        key = str(uid)
        entry = index.get(key)
        if not isinstance(entry, dict):
            index[key] = {
                "name": name,
                "previous": [],
                "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            atomic_write_json(users_index_path(), index)
            return ""
        old = str(entry.get("name", "")).strip()
        if old == name:
            return ""
        if old:
            summary = migrate_username_locked(old, name)
            renamed_from = old
        previous = [str(p) for p in entry.get("previous", []) if str(p).strip()]
        if old and old.lower() != name.lower():
            previous = [p for p in previous if p.strip().lower() != old.lower()] + [old]
        entry.update({
            "name": name,
            "previous": previous[-10:],
            "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
        index[key] = entry
        atomic_write_json(users_index_path(), index)

    if renamed_from:
        rename_token_cache(renamed_from, name)
        with PLAYER_INDEX_LOCK:
            PLAYER_INDEX.clear()
        print(f"[rename] {renamed_from} -> {name} (userid {uid}): {summary}")
        # append_audit takes STORAGE_LOCK itself, so it must run after the
        # migration block released it (threading.Lock is not re-entrant).
        append_audit("system", "username-change", f"{renamed_from} -> {name} (userid {uid})")
    return renamed_from


# ---------------------------------------------------------------------------
# Alliances: alliances/{safe-name}.json holds one alliance each -
# {"name", "leader", "members": [...], "invites": [...], "createdAt",
#  "chat": [{"at": ms, "from", "text"}, ...]}. A player may belong to at most
# one alliance; invites must be accepted by the invitee. Scale is tiny (one
# file per alliance, scanned on demand) so no index is kept.
# ---------------------------------------------------------------------------
ALLIANCE_CHAT_LIMIT = 200
FEED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000  # feed entries expire after 14 days
ALLIANCE_CHAT_TEXT_LIMIT = 300

# Flood control for chat posts: a member may send at most
# ALLIANCE_CHAT_FLOOD_MAX messages within any ALLIANCE_CHAT_FLOOD_WINDOW
# seconds; beyond that the post is rejected with 429. In-memory per process.
ALLIANCE_CHAT_FLOOD_MAX = 10
ALLIANCE_CHAT_FLOOD_WINDOW = 30  # seconds
CHAT_FLOOD_LOCK = threading.Lock()
CHAT_FLOOD_TIMES: dict = {}


def chat_flood_allow(username: str) -> bool:
    """Records one chat post for username and reports whether it is allowed."""
    low = str(username or "").strip().lower()
    now = time.monotonic()
    with CHAT_FLOOD_LOCK:
        times = [t for t in CHAT_FLOOD_TIMES.get(low, []) if now - t < ALLIANCE_CHAT_FLOOD_WINDOW]
        if len(times) >= ALLIANCE_CHAT_FLOOD_MAX:
            CHAT_FLOOD_TIMES[low] = times
            return False
        times.append(now)
        CHAT_FLOOD_TIMES[low] = times
        # The map only ever holds recent chatters; drop stale users so it
        # cannot grow without bound over a long-lived process.
        if len(CHAT_FLOOD_TIMES) > 1000:
            for key in [k for k, v in CHAT_FLOOD_TIMES.items()
                        if not v or now - v[-1] > ALLIANCE_CHAT_FLOOD_WINDOW]:
                CHAT_FLOOD_TIMES.pop(key, None)
    return True


# ---------------------------------------------------------------------------
# Viewer-endpoint rate limiting (token buckets). Applies to the viewer's own
# API routes (/api/*, /log); NOT to /proxy (which has its own dedicated
# game-API budget), /api/health (monitoring), or static files.
#
# Classification is passive and costs no upstream calls: a request carrying a
# token that the existing TOKEN_CACHE currently maps to a username gets that
# user's bucket; everything else shares a per-IP bucket. The cache stays warm
# as a side effect of normal signed-in use (chat polls, alliance reads, and
# settings calls all verify), so an active user is effectively always
# classified - and a fabricated token never is, because it is never cached.
#
# Behind Caddy every connection arrives from loopback, so the client IP is
# taken from X-Forwarded-For - but ONLY when the direct peer is loopback.
# Stock Caddy (>= 2.4.4) ignores inbound X-Forwarded-For from untrusted
# sources and writes the real client address, so the value is trustworthy;
# a direct (non-proxied) connection uses its socket address and any XFF
# header it sends is ignored. Denials are printed (throttled per bucket) so
# offending IPs are visible in journalctl.
# ---------------------------------------------------------------------------
# Sustained/burst numbers are admin-tunable at runtime via /setup/
# ("viewerUserPerMin", "viewerUserBurst", "viewerIpPerMin", "viewerIpBurst",
# "viewerLogPerMin" in SETTINGS_FIELD_RULES; defaults 90/30, 60/20, 10).
RATE_LOG_BURST = 10.0      # /log: minimum bucket capacity
RATE_BUCKET_IDLE_SECONDS = 600  # forget buckets idle this long
RATE_DENY_LOG_INTERVAL = 30     # seconds between denial log lines per bucket
RATE_LIMIT_LOCK = threading.Lock()
RATE_BUCKETS: dict = {}  # key -> [tokens, last_refill_mono, last_deny_log_mono]

# ----------------------------------------------------------------------
# Honeypot bans
# ----------------------------------------------------------------------
# Paths no legitimate client ever requests. This viewer is a single-page app
# plus /api/* and /setup/*; it has never had PHP, WordPress, a git checkout in
# the web root, or an .env file. A request for any of these is a scanner
# fingerprinting the host, so it is safe to treat one hit as proof of intent -
# no threshold, no scoring, no chance of catching a real visitor mid-session.
#
# Matching is on the decoded path, lower-cased, prefix or exact. Keep this
# list to things that are IMPOSSIBLE here rather than merely unused: a path
# that might one day become real (say /admin) belongs in a rate limit, not a
# ban list.
HONEYPOT_PREFIXES = (
    "/wp-",              # wp-admin, wp-login.php, wp-includes, wp-content, wp-json
    "/wordpress/",
    "/xmlrpc.php",
    "/vendor/phpunit/",  # CVE-2017-9841 eval-stdin RCE probe
    "/.git",             # /.git/config, /.git/HEAD, ...
    "/.svn",
    "/.hg",
    "/.bzr",
    "/.env",             # and .env.local, .env.prod, .env~, ...
    "/.aws/",
    "/.ssh/",
    "/.htaccess",
    "/.htpasswd",
    "/.npmrc",
    "/.dockerignore",
    "/phpmyadmin",
    "/phpinfo",
    "/cgi-bin/",
    "/rsc/",             # random-filename POST probes seen in the wild
)
HONEYPOT_EXACT = (
    "/.ds_store",
    "/config.php",
    "/shell.php",
    "/eval-stdin.php",
)

# Never bannable, whatever they do. Loopback is first and load-bearing: the
# cloudflared tunnel connects over it, so banning 127.0.0.1 would take the
# whole site off the internet. Everything reaching this server arrives from
# loopback, so this list is what stops a self-inflicted outage.
BAN_NEVER = {"127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"}

BAN_LOCK = threading.Lock()
# ip -> {"until": epoch, "strikes": int, "reason": str, "at": epoch,
#        "path": str, "count": int}
BANS: dict = {}
BAN_MAX_TRACKED = 4096
BAN_HISTORY_MAX = 500
BAN_HISTORY: list = []   # newest last; what the UI reads


def is_honeypot_path(path: str) -> bool:
    """True if path is one only a scanner would ask for."""
    probe = unquote(path.split("?", 1)[0]).lower()
    if not probe.startswith("/"):
        probe = "/" + probe
    if probe in HONEYPOT_EXACT:
        return True
    if any(probe.startswith(prefix) for prefix in HONEYPOT_PREFIXES):
        return True
    # Console-added patterns (item 11). Checked after the built-ins so the
    # compiled list always wins and a bad custom entry cannot mask it.
    if any(probe.startswith(prefix) for prefix in HONEYPOT_CUSTOM):
        return True
    # A honeypot name at any depth: /blog/wp-includes/..., /site/.env, the
    # exact shape of the scans in the wild, which walk a list of prefixes.
    return any(f"/{segment}" in probe
               for segment in ("wp-admin", "wp-includes", "wp-login",
                               "wp-content", "wp-json", "xmlrpc.php",
                               ".git/", ".env", "phpunit/", "eval-stdin.php"))


def ban_remaining(ip: str) -> int:
    """Seconds left on ip's ban, or 0 if it may proceed. Never bans the
    tunnel itself."""
    if ip in BAN_NEVER:
        return 0
    now = time.time()
    with BAN_LOCK:
        record = BANS.get(ip)
        if not record:
            return 0
        left = int(record.get("until", 0) - now)
        return left if left > 0 else 0


def ban_record_hit(ip: str, path: str, method: str) -> int:
    """Registers a honeypot hit. Returns the ban length in seconds, or 0 when
    bans are disabled (dry run) or the IP is unbannable.

    Terms double per strike: 60m, 120m, 240m ... capped at banMaxMinutes. A
    strike is forgotten banStrikeDecayHours after the last one, so an address
    that was reassigned to somebody else eventually starts clean.
    """
    if ip in BAN_NEVER:
        return 0
    enabled = get_setting("honeypotBansEnabled") == 1
    first = get_setting("banFirstMinutes") * 60
    ceiling = get_setting("banMaxMinutes") * 60
    decay = get_setting("banStrikeDecayHours") * 3600
    now = time.time()
    with BAN_LOCK:
        record = BANS.get(ip)
        if record and now - record.get("at", 0) > decay:
            record = None            # strikes lapsed; treat as a first offence
        strikes = (record.get("strikes", 0) if record else 0) + 1
        seen = (record.get("count", 0) if record else 0) + 1
        term = min(ceiling, first * (2 ** (strikes - 1)))
        entry = {
            "until": (now + term) if enabled else 0,
            "strikes": strikes,
            "count": seen,
            "at": now,
            "path": path[:120],
            "method": method,
            "reason": "honeypot",
            "enforced": enabled,
        }
        BANS[ip] = entry
        BAN_HISTORY.append({"ip": ip, **entry})
        del BAN_HISTORY[:-BAN_HISTORY_MAX]
        if len(BANS) > BAN_MAX_TRACKED:
            for stale in sorted(BANS, key=lambda k: BANS[k].get("at", 0))[:len(BANS) // 4]:
                BANS.pop(stale, None)
    ops_persist_bans()
    return term if enabled else 0


def ban_list() -> list:
    """Active and lapsed ban records, newest first - the UI's table."""
    now = time.time()
    with BAN_LOCK:
        rows = [{"ip": ip, **record} for ip, record in BANS.items()]
    for row in rows:
        row["remaining"] = max(0, int(row.get("until", 0) - now))
        row["active"] = row["remaining"] > 0
    rows.sort(key=lambda r: r.get("at", 0), reverse=True)
    return rows


def ban_clear(ip: str) -> bool:
    with BAN_LOCK:
        removed = BANS.pop(ip, None) is not None
    if removed:
        ops_persist_bans()
    return removed


def ban_add_manual(ip: str, minutes: int, reason: str = "manual") -> bool:
    """Operator ban from the UI. Refuses the tunnel and anything unparseable
    so a mistyped entry cannot lock everyone out."""
    ip = str(ip).strip()
    if not ip or ip in BAN_NEVER or len(ip) > 64:
        return False
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return False
    if ipaddress.ip_address(ip).is_loopback:
        return False
    minutes = max(1, min(get_setting("banMaxMinutes"), int(minutes)))
    now = time.time()
    with BAN_LOCK:
        BANS[ip] = {"until": now + minutes * 60, "strikes": 1, "count": 0,
                    "at": now, "path": "", "method": "", "reason": reason[:60],
                    "enforced": True}
    ops_persist_bans()
    return True


# ----------------------------------------------------------------------
# Ops store: the console's data, on disk
# ----------------------------------------------------------------------
# Every request is recorded here so the operator console can show what the
# terminal used to. Two requirements shaped this:
#
#   1. Recording must not slow the request. Requests land in an in-memory
#      deque and a background thread batches them into SQLite, so the hot
#      path costs one append and never touches the disk or waits on a lock
#      held by a writer.
#   2. It must survive a restart. Bans especially - an in-memory ban list
#      means a reboot unbans every scanner, and a scanner that comes back
#      every 13 minutes will outlast any uptime.
#
# sqlite3 is in the standard library, so this adds no dependency.
OPS_DB_LOCK = threading.Lock()
OPS_BUFFER_LOCK = threading.Lock()
OPS_BUFFER: "deque" = deque(maxlen=20000)
OPS_DB: "sqlite3.Connection | None" = None
OPS_SEQ = itertools.count(1)
OPS_FLUSH_SECONDS = 1.0
OPS_DROPPED = [0]        # requests lost to a full buffer, surfaced in /stats
# When true, honeypot 403/404s are recorded to the console but NOT printed
# to stdout - the console is the place to read them now. Togglable live
# from the UI so a suspicious moment can be watched in the journal too.
OPS_CONSOLE_QUIET = [True]


def ops_db_path() -> Path:
    return admin_dir() / "ops.db"


def ops_db() -> "sqlite3.Connection":
    """The shared connection. WAL so the writer thread and reader requests do
    not block each other; check_same_thread off because ThreadingHTTPServer
    serves each request on its own thread and OPS_DB_LOCK serialises us."""
    global OPS_DB
    if OPS_DB is None:
        admin_dir().mkdir(parents=True, exist_ok=True)
        OPS_DB = sqlite3.connect(str(ops_db_path()), check_same_thread=False,
                                 timeout=5.0)
        OPS_DB.execute("PRAGMA journal_mode=WAL")
        OPS_DB.execute("PRAGMA synchronous=NORMAL")
        OPS_DB.executescript("""
            CREATE TABLE IF NOT EXISTS requests (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                at       REAL    NOT NULL,
                ip       TEXT    NOT NULL,
                method   TEXT    NOT NULL,
                path     TEXT    NOT NULL,
                status   INTEGER NOT NULL,
                ms       REAL    NOT NULL,
                bytes    INTEGER NOT NULL DEFAULT 0,
                agent    TEXT    NOT NULL DEFAULT '',
                priority INTEGER NOT NULL DEFAULT 0,
                tunnel   INTEGER NOT NULL DEFAULT 0,
                kind     TEXT    NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS requests_at  ON requests(at);
            CREATE INDEX IF NOT EXISTS requests_ip  ON requests(ip);
            CREATE TABLE IF NOT EXISTS bans (
                ip       TEXT PRIMARY KEY,
                until    REAL NOT NULL,
                strikes  INTEGER NOT NULL DEFAULT 1,
                count    INTEGER NOT NULL DEFAULT 0,
                at       REAL NOT NULL,
                path     TEXT NOT NULL DEFAULT '',
                method   TEXT NOT NULL DEFAULT '',
                reason   TEXT NOT NULL DEFAULT '',
                enforced INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS never_ban (
                ip    TEXT PRIMARY KEY,
                at    REAL NOT NULL,
                note  TEXT NOT NULL DEFAULT ''
            );
        """)
        OPS_DB.commit()
    return OPS_DB


# "kind" classifies a request once, at record time, so the console can filter
# on it without re-deriving intent from the path on every read.
#   honeypot - a scanner path (see is_honeypot_path)
#   banned   - refused because the IP is banned
#   untunnel - loopback with no CF-Connecting-IP: not tunnel traffic
#   api / asset / page - ordinary traffic
def ops_classify(path: str, status: int, tunnel: bool) -> str:
    if is_honeypot_path(path):
        return "honeypot"
    if not tunnel:
        return "untunnel"
    if status == 403:
        return "banned"
    bare = path.split("?", 1)[0]
    if bare.startswith("/api/"):
        return "api"
    if bare.startswith(("/assets/", "/data/", "/setup/")) or "." in bare.rsplit("/", 1)[-1]:
        return "asset"
    return "page"


def ops_record(ip: str, method: str, path: str, status: int, ms: float,
               size: int, agent: str, priority: int, tunnel: bool) -> None:
    """Hot path. Append only - never touches SQLite."""
    row = (time.time(), ip[:64], method[:8], path[:400], int(status),
           round(float(ms), 2), int(size or 0), agent[:200], int(priority or 0),
           1 if tunnel else 0, ops_classify(path, status, tunnel))
    with OPS_BUFFER_LOCK:
        if len(OPS_BUFFER) == OPS_BUFFER.maxlen:
            OPS_DROPPED[0] += 1
        OPS_BUFFER.append(row)


def ops_flush() -> int:
    with OPS_BUFFER_LOCK:
        if not OPS_BUFFER:
            return 0
        batch = list(OPS_BUFFER)
        OPS_BUFFER.clear()
    with OPS_DB_LOCK:
        db = ops_db()
        db.executemany(
            "INSERT INTO requests (at,ip,method,path,status,ms,bytes,agent,"
            "priority,tunnel,kind) VALUES (?,?,?,?,?,?,?,?,?,?,?)", batch)
        db.commit()
    return len(batch)


def ops_prune() -> None:
    """Drops rows past the retention window. Cheap enough to run each flush
    cycle, and keeps the file bounded without a separate maintenance job."""
    cutoff = time.time() - get_setting("opsLogRetentionHours") * 3600
    with OPS_DB_LOCK:
        db = ops_db()
        db.execute("DELETE FROM requests WHERE at < ?", (cutoff,))
        db.execute("DELETE FROM bans WHERE until < ? AND at < ?",
                   (time.time(), cutoff))
        db.commit()


def ops_persist_bans() -> None:
    """Mirrors the in-memory ban table to disk. Called after every change, so
    a restart does not amnesty every scanner currently serving a term."""
    with BAN_LOCK:
        rows = [(ip, r.get("until", 0), r.get("strikes", 1), r.get("count", 0),
                 r.get("at", 0), r.get("path", ""), r.get("method", ""),
                 r.get("reason", ""), 1 if r.get("enforced") else 0)
                for ip, r in BANS.items()]
    try:
        with OPS_DB_LOCK:
            db = ops_db()
            db.execute("DELETE FROM bans")
            db.executemany("INSERT INTO bans (ip,until,strikes,count,at,path,"
                           "method,reason,enforced) VALUES (?,?,?,?,?,?,?,?,?)", rows)
            db.commit()
    except Exception as error:      # never let bookkeeping break a request
        print(f"[ops] ban persist failed: {error}")


def ops_load_bans() -> int:
    """Restores bans and the operator never-ban list at startup."""
    try:
        with OPS_DB_LOCK:
            db = ops_db()
            rows = db.execute("SELECT ip,until,strikes,count,at,path,method,"
                              "reason,enforced FROM bans").fetchall()
            extra = db.execute("SELECT ip FROM never_ban").fetchall()
    except Exception as error:
        print(f"[ops] ban load failed: {error}")
        return 0
    now = time.time()
    with BAN_LOCK:
        for ip, until, strikes, count, at, path, method, reason, enforced in rows:
            BANS[ip] = {"until": until, "strikes": strikes, "count": count,
                        "at": at, "path": path, "method": method,
                        "reason": reason, "enforced": bool(enforced)}
    for (ip,) in extra:
        BAN_NEVER.add(str(ip))
    return sum(1 for r in rows if r[1] > now)


def ops_never_ban_add(ip: str, note: str = "") -> bool:
    ip = str(ip).strip()
    if not ip or len(ip) > 64:
        return False
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return False
    BAN_NEVER.add(ip)
    ban_clear(ip)
    with OPS_DB_LOCK:
        db = ops_db()
        db.execute("INSERT OR REPLACE INTO never_ban (ip,at,note) VALUES (?,?,?)",
                   (ip, time.time(), note[:120]))
        db.commit()
    ops_persist_bans()
    return True


def ops_never_ban_remove(ip: str) -> bool:
    """Loopback can never be removed from the allowlist - see BAN_NEVER."""
    ip = str(ip).strip()
    if ip in ("127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"):
        return False
    BAN_NEVER.discard(ip)
    with OPS_DB_LOCK:
        db = ops_db()
        db.execute("DELETE FROM never_ban WHERE ip = ?", (ip,))
        db.commit()
    return True


# ----------------------------------------------------------------------
# Custom honeypot patterns (console-editable, item 11)
# ----------------------------------------------------------------------
# The compiled-in HONEYPOT_PREFIXES are the ones that are certain. This file
# holds additions made from the console, so a new scanner pattern can be
# blocked without editing source and restarting. Removals are only ever of
# custom entries: the built-in list cannot be edited away from a web UI,
# because a mistake there would stop banning real scanners silently.
HONEYPOT_CUSTOM: set = set()


def honeypot_custom_path() -> Path:
    return admin_dir() / "honeypots.json"


def load_honeypot_custom() -> set:
    data = read_json(honeypot_custom_path(), {"prefixes": []})
    items = data.get("prefixes") if isinstance(data, dict) else None
    out = set()
    for entry in (items or []):
        text = str(entry).strip().lower()
        if text.startswith("/") and 1 < len(text) <= 120:
            out.add(text)
    return out


def save_honeypot_custom() -> None:
    with STORAGE_LOCK:
        atomic_write_json(honeypot_custom_path(),
                          {"prefixes": sorted(HONEYPOT_CUSTOM)})


def honeypot_custom_add(pattern: str) -> tuple:
    """Returns (ok, message). Refuses anything that would match ordinary
    traffic, which is the one way this feature could take the site down."""
    text = str(pattern).strip().lower()
    if not text.startswith("/"):
        return (False, "Must start with /")
    if len(text) < 2 or len(text) > 120:
        return (False, "Between 2 and 120 characters")
    # A pattern this short or this generic would match real requests. Checked
    # against the paths the viewer actually serves rather than a guess.
    reserved = ("/api", "/assets", "/data", "/setup", "/app", "/index",
                "/styles", "/js", "/favicon", "/health", "/log", "/storage")
    if any(text.startswith(r) or r.startswith(text) for r in reserved):
        return (False, f"Refused: {text} overlaps paths this viewer serves")
    if text in HONEYPOT_CUSTOM:
        return (False, "Already listed")
    HONEYPOT_CUSTOM.add(text)
    save_honeypot_custom()
    return (True, f"Added {text}")


def honeypot_custom_remove(pattern: str) -> bool:
    text = str(pattern).strip().lower()
    if text not in HONEYPOT_CUSTOM:
        return False
    HONEYPOT_CUSTOM.discard(text)
    save_honeypot_custom()
    return True


def _ops_writer_loop() -> None:
    prune_at = 0.0
    while True:
        time.sleep(OPS_FLUSH_SECONDS)
        try:
            ops_flush()
            now = time.monotonic()
            if now - prune_at > 300:
                prune_at = now
                ops_prune()
        except Exception as error:
            print(f"[ops] writer error: {error}")


def start_ops_writer() -> None:
    HONEYPOT_CUSTOM.update(load_honeypot_custom())
    if HONEYPOT_CUSTOM:
        print(f"[ops] {len(HONEYPOT_CUSTOM)} custom honeypot pattern(s) loaded")
    restored = ops_load_bans()
    threading.Thread(target=_ops_writer_loop, daemon=True,
                     name="ops-writer").start()
    if restored:
        print(f"[ops] restored {restored} active ban(s) from {ops_db_path().name}")



# ---------------------------------------------------------------------------
# Image cache (/imagecache/<asset path>). Serves game asset images (building
# sprites, terrain tiles) for the base viewer. Every image is fetched from
# the refitted server AT MOST ONCE, forever: on first request it is written
# to STORAGE_ROOT/imagecache/<path> and every later request - from anyone -
# is served from disk. Cached files are NEVER overwritten or re-fetched, so
# viewing bases puts load on the refitted servers only for images we have
# never seen. Upstream misses are remembered briefly so a missing sprite
# cannot be hammered.
#
# Asset fetches are NEVER rate limited: they go to the game's CDN, which is
# built to serve static art, and each file is fetched once ever (then served
# from disk forever). ASSET_MAX_PARALLEL is a connection-concurrency guard,
# not a rate limit - it stops a single first-time base view from opening a
# hundred simultaneous sockets, without capping throughput over time.
# ---------------------------------------------------------------------------
# Game art lives on a dedicated CDN, NOT on the API server. The client's
# compiled CDN_URL constant resolves to https://cdn.bymrefitted.com, and
# GAME.as builds sprite URLs as cdnUrl + "assets/" + path. Fetching art from
# the API host instead only appears to work because that host mirrors part of
# the tree - individual files (observed: assets/monsters/korath_5.png) are
# missing there, which is why some champions never rendered.
BYM_CDN_BASE_URL = "https://cdn.bymrefitted.com"
BYM_ASSETS_BASE_URL = os.environ.get("BYM_ASSETS_BASE_URL", "").strip().rstrip("/") or None
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
ASSET_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]*$")
ASSET_MAX_PARALLEL = 8
ASSET_MAX_BYTES = 5 * 1024 * 1024
ASSET_MISS_TTL = 600  # seconds a 404/failure is remembered
ASSET_FETCH_SEMAPHORE = threading.Semaphore(ASSET_MAX_PARALLEL)
ASSET_MISSES_LOCK = threading.Lock()
ASSET_MISSES: dict = {}


def imagecache_dir() -> Path:
    path = STORAGE_ROOT / "imagecache"
    path.mkdir(parents=True, exist_ok=True)
    return path


def sanitize_asset_path(rel: str):
    """Validates an asset path into safe segments, or returns None."""
    parts = [p for p in str(rel or "").split("/") if p]
    if not parts or len(parts) > 8 or sum(len(p) for p in parts) > 300:
        return None
    for part in parts:
        if not ASSET_SEGMENT_RE.fullmatch(part) or ".." in part:
            return None
    if Path(parts[-1]).suffix.lower() not in IMAGE_EXTENSIONS:
        return None
    return parts


def asset_base_urls() -> list:
    """Hosts to try for game art, best first.

    An explicit BYM_ASSETS_BASE_URL wins outright (operator override). With
    no override we try the game's real CDN first, then fall back to the API
    host, which mirrors much - but not all - of the same tree.
    """
    if BYM_ASSETS_BASE_URL:
        return [BYM_ASSETS_BASE_URL]
    bases = [BYM_CDN_BASE_URL]
    if BYM_BASE_URL and BYM_BASE_URL not in bases:
        bases.append(BYM_BASE_URL)
    return bases


def fetch_upstream_asset(parts: list):
    # Bundled assets are authoritative when present: the live CDN 404s
    # these (korath_5/6 et al.), so don't even ask it first.
    _bundled_root = Path(__file__).resolve().parent / "app" / "static" / "assets" / "cdnfallback"
    _bundled = _bundled_root.joinpath(*parts)
    try:
        if _bundled.is_file() and str(_bundled.resolve()).startswith(str(_bundled_root.resolve())):
            return _bundled.read_bytes()
    except OSError:
        pass
    """Fetches one asset from the game's CDN (falling back to the API host).
    Returns bytes or None. Never called for a path already on disk."""
    joined = "/".join(parts)
    now = time.time()
    with ASSET_MISSES_LOCK:
        missed_at = ASSET_MISSES.get(joined, 0)
        if now - missed_at < ASSET_MISS_TTL:
            return None
    payload = None
    for base in asset_base_urls():
        url = f"{base}/{joined}"
        request = urllib.request.Request(url, headers={
            "User-Agent": BYM_USER_AGENT,
            "Accept": "image/*,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        })
        with ASSET_FETCH_SEMAPHORE:
            try:
                with urllib.request.urlopen(request, timeout=15) as response:
                    data = response.read(ASSET_MAX_BYTES + 1)
                    if len(data) <= ASSET_MAX_BYTES and data:
                        payload = data
            except Exception as error:  # noqa: BLE001 - 404/timeout/etc = miss
                print(f"[imagecache] fetch failed: {url} ({error!r})")
        if payload is not None:
            break
    if payload is None:
        # Bundled fallback: assets the live CDN is known to 404 on
        # (observed: monsters/korath_5.png and korath_6.png - Korath's top
        # two evolution sheets) ship under assets/cdnfallback/.
        bundled = Path(__file__).resolve().parent / "app" / "static" / "assets" / "cdnfallback"
        candidate = bundled.joinpath(*parts)
        try:
            if candidate.is_file() and str(candidate.resolve()).startswith(str(bundled.resolve())):
                payload = candidate.read_bytes()
        except OSError:
            payload = None
    if payload is None:
        with ASSET_MISSES_LOCK:
            ASSET_MISSES[joined] = now
            if len(ASSET_MISSES) > 2000:
                for key in [k for k, at in ASSET_MISSES.items() if now - at > ASSET_MISS_TTL]:
                    ASSET_MISSES.pop(key, None)
    return payload


def store_asset(parts: list, payload: bytes) -> Path:
    """Writes the asset to the cache WITHOUT ever overwriting an existing
    file (first write wins, racing writers are harmless)."""
    local = imagecache_dir().joinpath(*parts)
    local.parent.mkdir(parents=True, exist_ok=True)
    if not local.exists():
        temp = local.with_suffix(local.suffix + f".tmp{os.getpid()}")
        with temp.open("wb") as handle:
            handle.write(payload)
        if local.exists():
            temp.unlink(missing_ok=True)
        else:
            os.replace(temp, local)
    return local


# A full-world cache read walks every zone file for a world. Streaming keeps
# each one's memory footprint tiny, but several at once still saturate a small
# droplet's single core and disk. This bounds how many run concurrently;
# arrivals beyond the bound wait briefly, then get a 503 + Retry-After rather
# than piling up. Admin-tunable as "fullMapConcurrency".
FULL_MAP_GATE = threading.Semaphore(8)
FULL_MAP_GATE_LOCK = threading.Lock()
FULL_MAP_GATE_SIZE = 8


def full_map_gate_acquire(timeout: float = 10.0) -> bool:
    """Reserves a slot for an unfiltered world read, resizing the gate live if
    an admin changed the setting."""
    global FULL_MAP_GATE, FULL_MAP_GATE_SIZE
    wanted = get_setting("fullMapConcurrency")
    with FULL_MAP_GATE_LOCK:
        if wanted != FULL_MAP_GATE_SIZE:
            # Replace rather than adjust: in-flight readers hold the old
            # semaphore and release into it harmlessly as they finish.
            FULL_MAP_GATE = threading.Semaphore(wanted)
            FULL_MAP_GATE_SIZE = wanted
        gate = FULL_MAP_GATE
    return gate.acquire(timeout=timeout)


def full_map_gate_release() -> None:
    with FULL_MAP_GATE_LOCK:
        gate = FULL_MAP_GATE
    try:
        gate.release()
    except ValueError:
        pass  # gate was resized under us; the old one is being discarded


# MR2 wild monster generation, mirroring app/static/js/shared.js exactly.
# Tribe and level are pure functions of (x + y): wildMonsterCell.ts does
# Tribes[(x + y) % 4] and calculateTribeLevel.ts does
# ((x + y) % (45 - minimum)) + minimum. Array order is the tribe index, so this
# list must stay in the server's order. Kozu's declared 29 is unreachable -
# (x+y) % 4 == 1 forces (x+y) % 16 into {1,5,9,13} - and that quirk is
# reproduced rather than corrected.
MR2_TRIBE_ORDER = ("legionnaire", "kozu", "abunakki", "dreadnaut")
MR2_TRIBE_MIN_LEVEL = {
    "legionnaire": 25,
    "kozu": 29,
    "abunakki": 25,
    "dreadnaut": 25,
}
MR2_TRIBE_MAX_LEVEL = 45


def generated_wild_cell(x: int, y: int, terrain_height: int) -> dict:
    """The wild monster cell that (x, y) generates."""
    total = int(x) + int(y)
    tribe = MR2_TRIBE_ORDER[total % len(MR2_TRIBE_ORDER)]
    lower = MR2_TRIBE_MIN_LEVEL[tribe]
    level = (total % (MR2_TRIBE_MAX_LEVEL - lower)) + lower
    return {
        "x": int(x),
        "y": int(y),
        "b": 1,  # MapRoomCell.WM
        "uid": 0,
        "i": int(terrain_height),
        "n": tribe,
        "l": level,
        "dm": 0,
        "d": 0,
    }


def anonymize_hidden_cells(cells: list, hidden: set) -> list:
    """Replaces cells owned by hidden players with the wild monster cell that
    coordinate would have generated.

    The previous version blanked the cell to {x, y, i: <zone average>}. That
    removed the owner but left a tell: an empty patch of land, at a height
    that matched nothing in particular, exactly where a base plainly used to
    be. It also destroyed the real terrain height on the way through, which is
    lossy for a cache that other readers share.

    MR2 generation removes the guesswork. Tribe and level are pure functions
    of (x + y), so the cell can be replaced with precisely the wild monster
    camp that would exist there if nobody had ever settled it - not an
    approximation of one.

    The terrain height passes through unchanged. userCell.ts and
    wildMonsterCell.ts both emit `i: cell.terrainHeight` from the same seeded
    noise, so an occupied cell's height is already identical to its wild
    counterpart's; it is a function of world seed and position, not of who
    lives there. Keeping it is what makes the disguise seamless. (The old
    comment here assumed bases sit on elevated ground and blended the height
    to compensate - findFreeCell only rejects water, so that was never true,
    and the blending was itself the thing that made these tiles stand out.)
    """
    if not isinstance(cells, list) or not hidden:
        return cells
    out = []
    for cell in cells:
        if (
            isinstance(cell, dict)
            and int(cell.get("uid", 0) or 0) > 0
            and str(cell.get("n", "")).strip().lower() in hidden
        ):
            height = int(cell.get("i", 0) or 0)
            if HIDDEN_TILE_STYLE == "water":
                out.append({"x": cell.get("x"), "y": cell.get("y"),
                            "i": HIDDEN_WATER_HEIGHT})
            else:
                out.append(generated_wild_cell(
                    int(cell.get("x", 0) or 0), int(cell.get("y", 0) or 0), height))
        else:
            out.append(cell)
    return out


def rate_limit_take(key: str, per_minute: float, burst: float):
    """Takes one token from key's bucket. Returns (allowed, retry_after_s,
    should_log_denial)."""
    now = time.monotonic()
    rate = per_minute / 60.0
    with RATE_LIMIT_LOCK:
        bucket = RATE_BUCKETS.get(key)
        if bucket is None:
            bucket = [burst, now, 0.0]
            RATE_BUCKETS[key] = bucket
        tokens = min(burst, bucket[0] + (now - bucket[1]) * rate)
        bucket[1] = now
        if tokens >= 1.0:
            bucket[0] = tokens - 1.0
            allowed, retry, log_denial = True, 0, False
        else:
            bucket[0] = tokens
            retry = int((1.0 - tokens) / rate) + 1
            log_denial = now - bucket[2] >= RATE_DENY_LOG_INTERVAL
            if log_denial:
                bucket[2] = now
            allowed = False
        if len(RATE_BUCKETS) > 2000:
            for stale in [k for k, v in RATE_BUCKETS.items()
                          if now - v[1] > RATE_BUCKET_IDLE_SECONDS]:
                RATE_BUCKETS.pop(stale, None)
    return allowed, retry, log_denial

# Rank ladder. The "leader" field on the alliance stays the source of truth
# for who leads; every other member's rank lives in the "ranks" map
# (lower-cased name -> rank) and defaults to "member" for alliances created
# before ranks existed. New joiners start as recruits.
ALLIANCE_RANKS = ("recruit", "member", "officer", "leader")
RANK_ORDER = {rank: index for index, rank in enumerate(ALLIANCE_RANKS)}


def member_rank(data: dict, name: str) -> str:
    low = str(name or "").strip().lower()
    if str(data.get("leader", "")).strip().lower() == low:
        return "leader"
    rank = str((data.get("ranks") or {}).get(low, "member"))
    return rank if rank in RANK_ORDER and rank != "leader" else "member"


# ---------------------------------------------------------------------------
# Player directory: which world a player lives on, how many outposts they
# hold, and where their main yard sits - aggregated from the cached zone
# files. Built lazily per world and cached in memory; with every MR2 world
# fully cached this is authoritative enough for alliance rosters.
# ---------------------------------------------------------------------------
PLAYER_INDEX: dict = {}
PLAYER_INDEX_LOCK = threading.Lock()
PLAYER_INDEX_TTL_SECONDS = 600

# Ownership-change index for the Activity tabs: per world, the cells whose
# cached copy carries a takeover stamp (tt/po/pn/pb, written by the viewer's
# merge path). Rebuilt at most once per TTL per world; the scan is the same
# zone-file walk the player index does.
CHANGES_INDEX: dict = {}
CHANGES_INDEX_LOCK = threading.Lock()
CHANGES_INDEX_TTL_SECONDS = 60
CHANGES_INDEX_MAX_RECORDS = 300


def get_changes_index(world: str) -> list:
    now = time.time()
    with CHANGES_INDEX_LOCK:
        cached = CHANGES_INDEX.get(world)
        if cached and now - cached["builtAt"] < CHANGES_INDEX_TTL_SECONDS:
            return cached["records"]

    records: list = []
    zones_dir = STORAGE_ROOT / f"server_{world}" / "zones"
    if zones_dir.is_dir():
        for path in zones_dir.glob("zone_*.json"):
            payload = read_json(path, None)
            cells = payload.get("cells") if isinstance(payload, dict) else None
            if not isinstance(cells, list):
                continue
            for cell in cells:
                if not isinstance(cell, dict):
                    continue
                try:
                    takeover_at = int(cell.get("tt", 0) or 0)
                except (TypeError, ValueError):
                    takeover_at = 0
                if takeover_at <= 0:
                    continue
                records.append({
                    "world": world,
                    "x": int(cell.get("x", 0) or 0),
                    "y": int(cell.get("y", 0) or 0),
                    "at": takeover_at,
                    "prevUid": int(cell.get("po", 0) or 0),
                    "prevName": str(cell.get("pn", "") or "").strip(),
                    "prevType": int(cell.get("pb", 0) or 0),
                    "newUid": int(cell.get("uid", 0) or 0),
                    "newName": str(cell.get("n", "") or "").strip(),
                    "newType": int(cell.get("b", 0) or 0),
                })
    records.sort(key=lambda record: record["at"], reverse=True)
    records = records[:CHANGES_INDEX_MAX_RECORDS]

    with CHANGES_INDEX_LOCK:
        CHANGES_INDEX[world] = {"builtAt": now, "records": records}
    return records


def update_activity_file(world: str, players: dict) -> None:
    # Tracks when each player's outpost count last INCREASED - the basis for
    # the inactivity filter. Runs at most once per index rebuild (10 min).
    path = STORAGE_ROOT / f"server_{world}" / "activity.json"
    with STORAGE_LOCK:
        data = read_json(path, {})
        if not isinstance(data, dict):
            data = {}
        now_ms = int(time.time() * 1000)
        changed = False
        for low, info in players.items():
            count = int(info.get("outposts", 0) or 0)
            entry = data.get(low)
            if not isinstance(entry, dict):
                data[low] = {"c": count, "inc": now_ms}
                changed = True
            elif count > int(entry.get("c", 0) or 0):
                entry["c"] = count
                entry["inc"] = now_ms
                changed = True
            elif count < int(entry.get("c", 0) or 0):
                # Losses do not reset the clock, but the count must track so
                # a later re-capture registers as an increase.
                entry["c"] = count
                changed = True
        if changed:
            atomic_write_json(path, data)


def get_player_index(world: str) -> dict:
    now = time.time()
    with PLAYER_INDEX_LOCK:
        cached = PLAYER_INDEX.get(world)
        if cached and now - cached["builtAt"] < PLAYER_INDEX_TTL_SECONDS:
            return cached["players"]

    players: dict = {}
    zones_dir = STORAGE_ROOT / f"server_{world}" / "zones"
    if zones_dir.is_dir():
        for path in zones_dir.glob("zone_*.json"):
            payload = read_json(path, None)
            cells = payload.get("cells") if isinstance(payload, dict) else None
            if not isinstance(cells, list):
                continue
            try:
                fetched_at = int(payload.get("fetchedAt", 0) or 0)
            except (TypeError, ValueError):
                fetched_at = 0
            for cell in cells:
                if not isinstance(cell, dict):
                    continue
                name = str(cell.get("n", "")).strip()
                if not name or not int(cell.get("uid", 0) or 0):
                    continue
                low = name.lower()
                entry = players.setdefault(
                    low,
                    {"name": name, "world": world, "outposts": 0, "main": None,
                     "seenAt": 0, "zones": set()},
                )
                if len(entry["zones"]) < 80:
                    entry["zones"].add((cell.get("x", 0) // 10 * 10, cell.get("y", 0) // 10 * 10))
                # When the player was last spotted in this world - the newest
                # zone fetch that contained any of their cells. Decides which
                # world wins for players who moved servers.
                entry["seenAt"] = max(entry["seenAt"], fetched_at)
                base_type = cell.get("b")
                if base_type == 3:
                    entry["outposts"] += 1
                elif base_type == 2:
                    entry["main"] = {"x": cell.get("x"), "y": cell.get("y")}

    update_activity_file(world, players)
    with PLAYER_INDEX_LOCK:
        PLAYER_INDEX[world] = {"builtAt": now, "players": players}
    return players


def lookup_player(name: str):
    """Finds a player across every cached world. The MOST RECENT sighting
    wins (newest fetchedAt of any zone containing their cells), so a player
    who moved servers resolves to the new server as soon as its cache sees
    them - their stale cells on the old server no longer pin them there.
    Main-yard knowledge only breaks exact-recency ties."""
    low = str(name or "").strip().lower()
    if not low:
        return None
    hits = []
    for server_dir in sorted(STORAGE_ROOT.glob("server_*")):
        world = server_dir.name[len("server_"):]
        hit = get_player_index(world).get(low)
        if hit:
            hits.append(hit)
    if not hits:
        return None
    return max(hits, key=lambda h: (int(h.get("seenAt", 0) or 0), 1 if h.get("main") else 0))


def enrich_member(data: dict, name: str) -> dict:
    info = lookup_player(name) or {}
    return {
        "name": name,
        "rank": member_rank(data, name),
        "world": info.get("world", ""),
        "outposts": int(info.get("outposts", 0) or 0),
        "main": info.get("main"),
        "seenAt": int(info.get("seenAt", 0) or 0),
    }


def enrich_enemy(name: str, alliance_by_member: dict | None = None) -> dict:
    info = lookup_player(name) or {}
    low = str(name or "").strip().lower()
    return {
        "name": name,
        "alliance": str((alliance_by_member or {}).get(low, "")),
        "world": info.get("world", ""),
        "outposts": int(info.get("outposts", 0) or 0),
        "main": info.get("main"),
        "seenAt": int(info.get("seenAt", 0) or 0),
    }


def build_alliance_by_member(all_alliances: list) -> dict:
    """lowercased member name -> alliance name, over every alliance."""
    by_member = {}
    for _, data in all_alliances:
        alliance_name = str(data.get("name", "")).strip()
        if not alliance_name:
            continue
        for member in data.get("members", []):
            low = str(member).strip().lower()
            if low:
                by_member[low] = alliance_name
    return by_member


def alliances_dir() -> Path:
    path = STORAGE_ROOT / "alliances"
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_alliances() -> list:
    """Returns [(path, data)] for every valid alliance file."""
    out = []
    for entry in sorted(alliances_dir().glob("*.json")):
        data = read_json(entry, None)
        if isinstance(data, dict) and isinstance(data.get("members"), list):
            out.append((entry, data))
    return out


def alliance_of(username: str):
    """(path, data) of the alliance the user belongs to, or (None, None)."""
    low = str(username or "").strip().lower()
    for path, data in load_alliances():
        if any(str(m).strip().lower() == low for m in data.get("members", [])):
            return (path, data)
    return (None, None)


def alliance_public_view(data: dict, you: str) -> dict:
    members = [
        {"name": str(m), "rank": member_rank(data, str(m))}
        for m in data.get("members", [])
    ]
    members.sort(key=lambda m: (-RANK_ORDER[m["rank"]], m["name"].lower()))
    return {
        "name": data.get("name", ""),
        "leader": data.get("leader", ""),
        "members": members,
        "invites": [str(m) for m in data.get("invites", [])],
        "enemies": [str(m) for m in data.get("enemies", [])],
        "enemyAlliances": [str(a) for a in data.get("enemyAlliances", [])],
        "createdAt": data.get("createdAt", ""),
        "you": you,
        "yourRank": member_rank(data, you),
    }


ZONE_FILE_RE = re.compile(r"^zone_(-?\d+)_(-?\d+)\.json$")


class StaticViewerHandler(SimpleHTTPRequestHandler):
    # ------------------------------------------------------------------
    # Static file serving
    # ------------------------------------------------------------------
    def guess_type(self, path) -> str:
        suffix = Path(str(path)).suffix.lower()
        if suffix in MIME_TYPES:
            return MIME_TYPES[suffix]
        return super().guess_type(path)

    def end_headers(self) -> None:
        # Asset responses are content-addressed forever (an image path never
        # changes what it serves), so they may be cached hard by browsers;
        # everything else stays no-store.
        if getattr(self, "suppress_no_store", False):
            self.suppress_no_store = False
        else:
            self.send_header("Cache-Control", "no-store")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    # ------------------------------------------------------------------
    # /imagecache/<asset path>: disk-cached game asset images. First
    # request fetches from the refitted server and stores the file; every
    # later request serves from disk. Existing files are never re-fetched
    # or overwritten.
    # ------------------------------------------------------------------
    def handle_imagecache(self, method: str, path: str) -> None:
        if method != "GET":
            self.send_json(405, {"error": "Method not allowed"})
            return
        parts = sanitize_asset_path(unquote(path[len("/imagecache/"):]))
        if parts is None:
            self.send_json(400, {"error": "Invalid asset path"})
            return
        root = imagecache_dir().resolve()
        local = root.joinpath(*parts).resolve()
        # is_relative_to rather than a string prefix: startswith() would also
        # accept a sibling directory whose name merely begins with the cache
        # root ("imagecacheEVIL"). Unreachable today because
        # sanitize_asset_path already rejects "..", but the weaker check should
        # not be the thing standing between us and a traversal.
        if not local.is_relative_to(root):
            self.send_json(400, {"error": "Invalid asset path"})
            return

        payload = None
        if local.is_file():
            try:
                payload = local.read_bytes()
            except OSError:
                payload = None
        if payload is None:
            payload = fetch_upstream_asset(parts)
            if payload is not None:
                try:
                    store_asset(parts, payload)
                except OSError as error:
                    print(f"[imagecache] store failed for {'/'.join(parts)}: {error!r}")
        if payload is None:
            self.send_json(404, {"error": "Asset not available"})
            return

        mime = MIME_TYPES.get(Path(parts[-1]).suffix.lower(), "application/octet-stream")
        self.suppress_no_store = True
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except ConnectionError:
            print(f"[net] client disconnected during {self.command} {self.path}")

    def log_request(self, code="-", size="-") -> None:
        """Records every request for the operator console, then logs as usual.

        BaseHTTPRequestHandler calls this from send_response with the status,
        so it is the one place that sees method, path and outcome together.
        """
        status = code.value if hasattr(code, "value") else code
        try:
            status = int(status)
        except (TypeError, ValueError):
            status = 0
        try:
            ops_record(
                ip=self.client_ip(),
                method=str(self.command or "-"),
                path=str(self.path or "-"),
                status=status,
                ms=(time.monotonic() - getattr(self, "_req_start", time.monotonic())) * 1000.0,
                size=0 if size == "-" else size,
                agent=str(self.headers.get("User-Agent", "") or ""),
                priority=getattr(self, "_fetch_priority", 0) or 0,
                tunnel=bool(self.headers.get("CF-Connecting-IP")),
            )
        except Exception:
            pass          # the console is never worth failing a request over
        if OPS_CONSOLE_QUIET[0] and status in (403, 404) and \
                is_honeypot_path(str(self.path or "")):
            return        # scanner noise: it is in the console, not the journal
        # Verbosity is a setting now that every request is queryable in the
        # console. Recording already happened above; this only decides whether
        # a line is also printed.
        try:
            verbosity = get_setting("journalRequestLines")
        except Exception:
            verbosity = 1
        if verbosity == 0:
            return
        if verbosity == 1 and status < 400 and self.headers.get("CF-Connecting-IP"):
            return        # ordinary tunnel traffic that succeeded
        super().log_request(code, size)

    def log_error(self, format: str, *args: object) -> None:
        """Suppresses the duplicate line that send_error produces.

        Every 404 previously printed TWICE - once here as
        `code 404, message File not found`, and once from log_request as the
        request line with its status. The second is strictly more informative,
        so this one is dropped for the ordinary not-found and forbidden cases
        and kept for anything genuinely unexpected. That alone halves the
        volume the journal was carrying.
        """
        message = format % args if args else format
        if "code 404" in message or "code 403" in message:
            return
        self.log_message("%s", message)

    def log_message(self, format: str, *args: object) -> None:
        # Line shape: <ip> - <UTC timestamp> - <priority> - "<request>" <status> -
        #
        # client_ip() so journal lines show the real address behind Caddy (the
        # socket peer there is always 127.0.0.1). The timestamp is UTC to match
        # the daily log file names. Priority is what the request was scheduled
        # at (1-10), or "-" when it never reaches the upstream scheduler.
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        priority = getattr(self, "_fetch_priority", None)
        print(f"{self.client_ip()} - {stamp} - "
              f"{priority if priority is not None else '-'} - {format % args}")

    def read_fetch_priority(self) -> int:
        """X-Fetch-Priority clamped to 1..10 (1 = lowest). Recorded on the
        handler so the access log can show what the request was scheduled at."""
        try:
            value = int(self.headers.get("X-Fetch-Priority", "1") or 1)
        except (TypeError, ValueError):
            value = BYM_PRIORITY_MIN
        value = max(BYM_PRIORITY_MIN, min(BYM_PRIORITY_MAX, value))
        self._fetch_priority = value
        return value

    # ------------------------------------------------------------------
    # Storage API routing
    # ------------------------------------------------------------------
    def do_GET(self) -> None:
        if not self.security_gate():
            return
        if self.route_storage("GET"):
            return
        # The admin console fragment is never served as a static file; it is
        # only reachable through /api/admin/console, which verifies the
        # requester is an administrator first.
        # Decode percent-escapes before matching: SimpleHTTPRequestHandler
        # unquotes the path when locating the file on disk, so a raw-string
        # check would let /setup/%63onsole.html (and %2E, trailing %2F, ...)
        # slip through and serve the admin markup as a static file.
        normalized = unquote(self.path.split("?", 1)[0]).rstrip("/")
        if (normalized.endswith("/setup/console.html")
                or normalized.endswith("/setup/console")
                or normalized.endswith("/setup/ops.html")
                or normalized.endswith("/setup/ops")):
            self.send_json(404, {"error": "Not found"})
            return
        super().do_GET()

    def do_POST(self) -> None:
        if not self.security_gate():
            return
        if self.route_storage("POST"):
            return
        self.send_json(405, {"error": "Method not allowed"})

    def do_PUT(self) -> None:
        if not self.security_gate():
            return
        if self.route_storage("PUT"):
            return
        self.send_json(405, {"error": "Method not allowed"})

    def client_ip(self) -> str:
        """Real client address, from the one header the tunnel controls.

        Everything arrives through cloudflared, so the socket peer is always
        loopback and the client address has to come from a header. Which
        header matters enormously, because this value keys the rate limiter
        and the ban list:

        Cloudflare APPENDS to X-Forwarded-For, it does not replace it. A
        client that sends `X-Forwarded-For: 1.2.3.4` gets `1.2.3.4,
        <real client IP>` delivered here - everything the client wrote is
        passed through untouched and the true address is added on the RIGHT.
        Reading the LEFTMOST entry, as this function used to, therefore read
        an attacker-supplied string: rotate it per request to escape the rate
        limiter entirely, or set it to somebody else's address to get them
        banned instead. "Danger on the left, trust on the right."

        CF-Connecting-IP is a single value that Cloudflare sets on every
        request crossing its edge and does not pass through from the client,
        so it is the trustworthy one here. It is only trustworthy because the
        peer is loopback and the only thing on loopback is our tunnel - if
        this server is ever exposed directly, an attacker sets this header to
        whatever it likes and we are back to square one. Hence HOST defaults
        to 127.0.0.1 and require_tunnel() rejects anything without the header.

        Duplicate headers are read defensively: get_all returns every
        instance, and we take the LAST, since a client-injected copy would be
        seen before Cloudflare's.
        """
        peer = str(self.client_address[0])
        if peer not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            # Direct connection: no header is trustworthy, use the socket.
            return peer
        values = self.headers.get_all("CF-Connecting-IP") or []
        for candidate in reversed(values):
            candidate = str(candidate).strip()
            if not candidate or len(candidate) > 64:
                continue
            try:
                ipaddress.ip_address(candidate)
            except ValueError:
                continue
            return candidate
        return peer

    def require_tunnel(self) -> bool:
        """Rejects requests that did not come through the cloudflared tunnel.

        Returns True if the request may proceed.

        A request whose peer is loopback but which carries no CF-Connecting-IP
        did not cross Cloudflare's edge - it was made on this host, or by
        something else reaching the port locally. Those are exactly the lines
        that showed up as `127.0.0.1` in the access log: a local scanner, not
        tunnel traffic. Since every real visitor arrives through the tunnel,
        anything without the header is refused rather than served and logged
        as an unattributable request.

        Loopback with no header is still allowed for a small set of local
        health probes, so `curl localhost/api/health` from a shell or a
        systemd/docker healthcheck keeps working.
        """
        peer = str(self.client_address[0])
        if peer not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            # Reached the port directly: HOST should have prevented this.
            self.send_json(403, {"error": "Direct access not permitted"})
            print(f"[tunnel] 403 direct connection from {peer} on "
                  f"{self.command} {self.path[:120]} - is HOST bound to 0.0.0.0?")
            return False
        if self.headers.get("CF-Connecting-IP"):
            return True
        path = unquote(self.path.split("?", 1)[0]).rstrip("/")
        # Only the explicit health endpoints. NOT "" - the root path strips to
        # the empty string, and letting that through would have exempted the
        # whole app from the tunnel requirement, which is the one thing this
        # function exists to enforce.
        if path in ("/api/health", "/health"):
            return True
        self.send_json(403, {"error": "Requests must arrive through the tunnel"})
        print(f"[tunnel] 403 no CF-Connecting-IP on {self.command} {self.path[:120]} "
              f"(local request, not tunnel traffic)")
        return False

    def security_gate(self) -> bool:
        """Tunnel check, then ban check, then honeypot check. Returns True if
        the request may proceed to normal routing.

        Runs before any other work on every request: a banned scanner should
        cost a dict lookup, not a file read or an upstream call.
        """
        self._req_start = time.monotonic()
        if not self.require_tunnel():
            return False
        ip = self.client_ip()
        remaining = ban_remaining(ip)
        if remaining > 0:
            # 403 rather than 429: this is not "slow down", it is "go away",
            # and no Retry-After invites a retry schedule.
            self.send_json(403, {"error": "Forbidden"})
            return False
        path = self.path.split("?", 1)[0]
        if is_honeypot_path(path):
            term = ban_record_hit(ip, path, self.command)
            if term:
                print(f"[honeypot] banned {ip} for {term // 60}m - "
                      f"{self.command} {path[:120]}")
            else:
                print(f"[honeypot] would ban {ip} (bans disabled) - "
                      f"{self.command} {path[:120]}")
            self.send_json(404, {"error": "Not found"})
            return False
        return True

    def cached_session_name(self) -> str:
        """Signed-in username from the token cache ONLY - never a network call.

        requester_is_admin() resolves identity through verify_bym_token(),
        which on a cache miss calls the game server AND rotates the token.
        That is fine on admin endpoints; it must never happen on the
        rate-limit hot path, which runs on every request. An admin whose
        token is not currently cached simply gets limited like anyone else
        until their next verified call warms it.
        """
        token = str(self.headers.get("X-Viewer-Token", "")).strip()
        if not token:
            auth = self.headers.get("Authorization", "")
            token = auth[7:].strip() if auth.startswith("Bearer ") else ""
        if not token:
            return ""
        with TOKEN_CACHE_LOCK:
            cached = TOKEN_CACHE.get(token)
        if (isinstance(cached, tuple) and len(cached) >= 3
                and cached[0] and cached[2] > time.time()):
            return str(cached[0])
        return ""

    def requester_bypasses_limits(self) -> bool:
        """True when this caller is an admin and the bypass toggle is on.

        Covers the viewer's own token buckets and the outbound BYM budget
        queue. It does NOT cover fullMapConcurrency: that semaphore bounds how
        much of a world is held in memory at once, so bypassing it would risk
        the process rather than merely spending budget faster.
        """
        if not get_setting("adminBypassLimits"):
            return False
        name = self.cached_session_name()
        return bool(name) and name.lower() in admin_name_set_lower()

    def rate_limit_key(self):
        """(key, per_minute, burst) for this request - the signed-in user's
        bucket when the presented token is currently cache-verified, else the
        client IP's bucket. Purely a cache lookup; never calls upstream."""
        token = str(self.headers.get("X-Viewer-Token", "")).strip()
        if not token:
            auth = self.headers.get("Authorization", "")
            token = auth[7:].strip() if auth.startswith("Bearer ") else ""
        if token:
            with TOKEN_CACHE_LOCK:
                cached = TOKEN_CACHE.get(token)
            if (isinstance(cached, tuple) and len(cached) >= 3
                    and cached[0] and cached[2] > time.time()):
                return (f"user:{str(cached[0]).lower()}",
                        float(get_setting("viewerUserPerMin")),
                        float(get_setting("viewerUserBurst")))
        return (f"ip:{self.client_ip()}",
                float(get_setting("viewerIpPerMin")),
                float(get_setting("viewerIpBurst")))

    def enforce_rate_limit(self, path: str) -> bool:
        """Returns True if the request may proceed; sends the 429 otherwise."""
        if self.requester_bypasses_limits():
            return True
        if path == "/log":
            key = f"log:{self.client_ip()}"
            per_minute = float(get_setting("viewerLogPerMin"))
            burst = max(per_minute, RATE_LOG_BURST)
        else:
            key, per_minute, burst = self.rate_limit_key()
        allowed, retry, log_denial = rate_limit_take(key, per_minute, burst)
        if allowed:
            return True
        if log_denial:
            print(f"[rate-limit] 429 {key} on {self.command} {path} "
                  f"({per_minute:g}/min, burst {burst:g})")
        self.send_json(429, {"error": "Too many requests - slow down"},
                       {"Retry-After": retry})
        return False

    def route_storage(self, method: str) -> bool:
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            self.send_json(200, {"ok": True, "version": SERVER_VERSION, "features": ["storage", "admin", "proxy"]})
            return True
        # Viewer-endpoint rate limit: /api/* and /log, but not /proxy (its
        # own budget), health (above), or static files (never reach here
        # with an /api-style path).
        if (path == "/log" or path.startswith("/api/")) and not self.enforce_rate_limit(path):
            return True
        if path.startswith("/proxy/") or path == "/proxy":
            self.handle_proxy(method)
            return True
        if path.startswith("/imagecache/"):
            self.handle_imagecache(method, path)
            return True
        if path == "/log":
            self.handle_log(method)
            return True
        if path == "/api/basedata":
            if method != "GET":
                self.send_json(405, {"error": "GET only"})
                return True
            query = urllib.parse.parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            uid = re.sub(r"[^0-9]", "", str((query.get("uid") or [""])[0]))
            if not uid:
                self.send_json(400, {"error": "uid parameter required"})
                return True
            path_file = STORAGE_ROOT / "baseloads" / f"{uid}.json"
            if not path_file.is_file():
                self.send_json(200, {"found": False})
                return True
            data = read_json(path_file, None)
            if not isinstance(data, dict):
                self.send_json(200, {"found": False})
                return True
            # Attacks are one record per hit; the same attacker recurs.
            # Group by name: total the counts, keep the most recent time
            # and the avatar, newest attacker first.
            grouped: dict = {}
            for entry in (data.get("attacks") or []):
                if not isinstance(entry, dict):
                    continue
                name = str(entry.get("name", "") or "").strip()
                if not name:
                    continue
                when = int(entry.get("starttime", 0) or 0)
                g = grouped.get(name)
                if g is None:
                    grouped[name] = {
                        "name": name,
                        "starttime": when,
                        "count": int(entry.get("count", 1) or 1),
                        "pic": str(entry.get("pic_square", "") or ""),
                    }
                else:
                    g["count"] += int(entry.get("count", 1) or 1)
                    if when > g["starttime"]:
                        g["starttime"] = when
            attacks = sorted(grouped.values(),
                             key=lambda a: a["starttime"], reverse=True)[:20]
            self.send_json(200, {
                "found": True,
                "capturedAt": int(path_file.stat().st_mtime * 1000),
                "name": str(data.get("name", "") or ""),
                "createtime": int(data.get("createtime", 0) or 0),
                "savetime": int(data.get("savetime", 0) or 0),
                "attacks": attacks,
                # The game's own battle-log HTML; capped defensively.
                "attackreport": str(data.get("attackreport", "") or "")[:20000],
            })
            return True
        if path == "/api/baseload-freshness":
            if method != "GET":
                self.send_json(405, {"error": "GET only"})
                return True
            uids = {}
            try:
                base_dir = STORAGE_ROOT / "baseloads"
                if base_dir.is_dir():
                    for entry in base_dir.glob("*.json"):
                        if entry.stem.isdigit():
                            uids[entry.stem] = int(entry.stat().st_mtime * 1000)
            except OSError:
                pass
            self.send_json(200, {"uids": uids})
            return True
        if path == "/api/leaderboard-history":
            if method != "GET":
                self.send_json(405, {"error": "GET only"})
                return True
            query = urllib.parse.parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            world = str((query.get("world") or [""])[0]).strip()
            if not world or "/" in world or "\\" in world or ".." in world:
                self.send_json(400, {"error": "world parameter required"})
                return True
            try:
                self.send_json(200, leaderboard_history(world))
            except Exception as error:
                self.send_json(500, {"error": f"history unavailable: {error}"})
            return True
        if path == "/api/storage/changes":
            # Recent ownership changes (captures/losses) from the shared map
            # cache, for the Activity tabs. Public like the map itself, with
            # the same moderation-hiding rules; ?server=NAME scopes to one
            # world, otherwise every cached world contributes ("Global").
            if method != "GET":
                self.send_json(405, {"error": "Method not allowed"})
                return True
            params = {}
            if "?" in self.path:
                params = urllib.parse.parse_qs(self.path.split("?", 1)[1])
            wanted = sanitize_name(params.get("server", [""])[0] or "")
            try:
                limit = int(params.get("limit", ["100"])[0])
            except (TypeError, ValueError):
                limit = 100
            limit = max(1, min(200, limit))

            worlds = []
            if wanted:
                worlds = [wanted]
            else:
                for entry in sorted(STORAGE_ROOT.glob("server_*")):
                    if (entry / "zones").is_dir():
                        worlds.append(entry.name[len("server_"):])

            if self.requester_is_admin():
                hidden = set()
            else:
                hidden = hidden_name_set()
            records = []
            for world in worlds:
                for record in get_changes_index(world):
                    if hidden and (
                        record["newName"].lower() in hidden
                        or record["prevName"].lower() in hidden
                    ):
                        continue
                    records.append(record)
            records.sort(key=lambda record: record["at"], reverse=True)
            self.send_json(200, {"changes": records[:limit]})
            return True
        if path == "/api/storage/servers":
            # Public list of worlds with cached map data, so a signed-out
            # visitor can pick one to view. Names are world ids only - no
            # cell data is exposed here.
            if method != "GET":
                self.send_json(405, {"error": "Method not allowed"})
                return True
            servers = []
            for entry in sorted(STORAGE_ROOT.glob("server_*")):
                zones_dir = entry / "zones"
                if not zones_dir.is_dir():
                    continue
                files = list(zones_dir.glob("zone_*.json"))
                if not files:
                    continue
                servers.append({
                    "name": entry.name[len("server_"):],
                    "zones": len(files),
                    "newest": int(max(f.stat().st_mtime for f in files) * 1000),
                })
            self.send_json(200, {"servers": servers})
            return True
        if re.fullmatch(r"/api/storage/server/[^/]+/activity", path):
            if method != "GET":
                self.send_json(405, {"error": "Method not allowed"})
                return True
            world = path.split("/")[4]
            # activity.json is written as a side effect of the player-index
            # rebuild, which otherwise only runs when alliance endpoints are
            # used. Rebuild it here (TTL-cached, at most once per 10 min) so
            # the inactivity filter reads current data instead of whatever an
            # unrelated feature last left on disk - or nothing at all.
            if (STORAGE_ROOT / f"server_{world}" / "zones").is_dir():
                get_player_index(world)
            data = read_json(STORAGE_ROOT / f"server_{world}" / "activity.json", {})
            hidden = hidden_name_set()
            players = {}
            if isinstance(data, dict):
                for low, entry in data.items():
                    if low in hidden or not isinstance(entry, dict):
                        continue
                    players[low] = int(entry.get("inc", 0) or 0)
            self.send_json(200, {"players": players})
            return True

        if path == "/api/storage/profile" or path.startswith("/api/storage/profile/"):
            self.handle_public_profile(method, path)
            return True
        if path == "/api/hide-request":
            username, current_token = self.requester_identity()
            if not username:
                self.send_json(401, {"error": "Sign in to manage hiding for your account"})
                return True
            requests_path = admin_dir() / "hide-requests.json"
            if method == "GET":
                data = read_json(requests_path, [])
                mine = next((r for r in reversed(data) if isinstance(r, dict)
                             and str(r.get("name", "")).lower() == username.lower()), None)
                already_hidden = any(
                    str(e.get("name", "")).strip().lower() == username.lower()
                    for e in load_hidden_players() if isinstance(e, dict))
                self.send_json(200, {
                    "request": mine, "alreadyHidden": already_hidden, "token": current_token,
                })
                return True
            if method == "POST":
                body = self.read_json_body()
                if body is None:
                    return True
                reason = str(body.get("reason", "")).strip()[:300]
                if not reason:
                    self.send_json(400, {"error": "Please give a short reason"})
                    return True
                with STORAGE_LOCK:
                    data = read_json(requests_path, [])
                    if not isinstance(data, list):
                        data = []
                    # One live request per player: replace any earlier pending one.
                    data = [r for r in data if not (isinstance(r, dict)
                            and str(r.get("name", "")).lower() == username.lower()
                            and r.get("status") == "pending")]
                    data.append({
                        "name": username,
                        "reason": reason,
                        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "status": "pending",
                    })
                    atomic_write_json(requests_path, data[-200:])
                self.send_json(200, {"submitted": True, "token": current_token})
                return True
            self.send_json(405, {"error": "Method not allowed"})
            return True

        if path.startswith("/api/alliance/"):
            try:
                self.handle_alliance(method, path)
            except ConnectionError:
                print(f"[net] client disconnected during {method} {path}")
            except Exception as error:  # noqa: BLE001
                print(f"[alliance] {method} {path} failed: {error!r}")
                self.send_json(500, {"error": "Alliance operation failed"})
            return True
        if path.startswith("/api/admin/"):
            try:
                self.route_admin(method, path)
            except ConnectionError:
                print(f"[net] client disconnected during {method} {path}")
            except Exception as error:  # noqa: BLE001
                print(f"[admin] {method} {path} failed: {error!r}")
                self.send_json(500, {"error": "Admin operation failed"})
            return True
        if not path.startswith("/api/storage/"):
            return False

        segments = [segment for segment in path.split("/") if segment]
        # segments: ["api", "storage", scope, name, resource]
        try:
            if len(segments) == 5 and segments[2] == "server" and segments[4] == "map":
                self.handle_server_map(method, segments[3])
            elif len(segments) == 5 and segments[2] == "user" and segments[4] == "settings":
                self.handle_user_settings(method, segments[3])
            elif len(segments) == 5 and segments[2] == "user" and segments[4] == "logins":
                self.handle_user_logins(method, segments[3])
            else:
                self.send_json(404, {"error": "Unknown storage endpoint"})
        except ConnectionError:
            print(f"[net] client disconnected during {method} {path}")
        except Exception as error:  # noqa: BLE001 - report, don't crash the thread
            print(f"[storage] {method} {path} failed: {error!r}")
            self.send_json(500, {"error": "Storage operation failed"})
        return True

    # ------------------------------------------------------------------
    # Shared per-server map cache: server_{name}/zones/zone_{x}_{y}.json
    # ------------------------------------------------------------------
    def handle_server_map(self, method: str, raw_name: str) -> None:
        server_name = sanitize_name(raw_name)
        if not server_name:
            self.send_json(400, {"error": "Invalid server name"})
            return

        zones_dir = server_map_dir(server_name)

        if method == "GET":
            if self.requester_is_admin():
                hidden = set()
            else:
                hidden = hidden_name_set()
                if hidden:
                    # Alliance members always see each other's bases and
                    # outposts, hidden or not - and every player sees their
                    # own. Moderation hiding only applies to outsiders.
                    requester = self.requester_user()
                    if requester:
                        visible = {requester.strip().lower()}
                        _, mine = alliance_of(requester)
                        if mine:
                            visible |= {
                                str(m).strip().lower()
                                for m in mine.get("members", [])
                            }
                        hidden -= visible
            zone_filter = None
            if "?" in self.path:
                params = urllib.parse.parse_qs(self.path.split("?", 1)[1])
                raw_zones = params.get("zones", [""])[0]
                if raw_zones:
                    zone_filter = {
                        token.strip() for token in raw_zones.split(",") if token.strip()
                    }
                    if len(zone_filter) > 200:
                        zone_filter = set(list(zone_filter)[:200])
            # An unfiltered request walks the whole world (thousands of files,
            # tens of MB). Those are gated and streamed; targeted reads are
            # small and go straight through.
            if zone_filter is None:
                if not full_map_gate_acquire():
                    self.send_json(503, {
                        "error": "Server busy loading world data - try again in a moment",
                    }, {"Retry-After": "5"})
                    return
                try:
                    self.stream_server_map(server_name, zones_dir, None, hidden)
                finally:
                    full_map_gate_release()
                return
            self.stream_server_map(server_name, zones_dir, zone_filter, hidden)
            return

        if method == "POST":
            # The shared cache is world state every user and guest sees, so
            # anonymous writes would let anyone poison it (fake bases/names)
            # or grow it without bound. Any signed-in player may contribute;
            # verifying rotates the game token, so the response echoes the
            # current one for the client to adopt (same contract as the
            # per-user endpoints).
            username, current_token = self.requester_identity()
            if not username:
                self.send_json(401, self.unauthenticated_payload())
                return
            # First write for a world: only create the directory if the game
            # server currently lists that world uuid. Fails closed while the
            # list is unfetchable; existing worlds are unaffected.
            if not zones_dir.is_dir():
                world_ids, fetch_ok = known_world_ids()
                if not fetch_ok:
                    self.send_json(503, {
                        "error": "Could not verify the world with the game server - try again shortly",
                        "token": current_token,
                    })
                    return
                if server_name.lower() not in world_ids:
                    self.send_json(403, {
                        "error": f"Unknown world: {server_name}",
                        "token": current_token,
                    })
                    return
            body = self.read_json_body()
            if body is None:
                return
            raw_zones = body.get("zones") if isinstance(body, dict) else None
            if not isinstance(raw_zones, list):
                self.send_json(400, {"error": "Body must be {\"zones\": [...]}"})
                return

            saved = 0
            rejected = 0
            with STORAGE_LOCK:
                for zone in raw_zones:
                    if not isinstance(zone, dict):
                        rejected += 1
                        continue
                    try:
                        zone_x = int(zone["x"])
                        zone_y = int(zone["y"])
                    except (KeyError, TypeError, ValueError):
                        rejected += 1
                        continue
                    # Only real zone origins may exist on disk; this bounds
                    # the cache at (MAX_MAP_SIZE/ZONE_SIZE)^2 files per world.
                    if not valid_zone_origin(zone_x, zone_y):
                        rejected += 1
                        continue
                    cells = zone.get("cells")
                    if isinstance(cells, list):
                        kept = []
                        for cell in cells:
                            if not isinstance(cell, dict):
                                continue
                            # Every cell must sit inside this zone's box; at
                            # most one cell per coordinate can be genuine, so
                            # the list is also hard-capped at the box size.
                            try:
                                cell_x = int(cell.get("x"))
                                cell_y = int(cell.get("y"))
                            except (TypeError, ValueError):
                                continue
                            if not (zone_x <= cell_x < zone_x + ZONE_SIZE
                                    and zone_y <= cell_y < zone_y + ZONE_SIZE):
                                continue
                            kept.append(minify_cell(cell))
                            if len(kept) >= ZONE_SIZE * ZONE_SIZE:
                                break
                        cells = kept
                    # Clamp fetchedAt to the server clock: a client with its
                    # clock set ahead would otherwise share future-dated
                    # timestamps that keep zones "fresh" past the 1h window
                    # for every user of this cache. Earlier times pass
                    # through unchanged (batched scan persists rely on it).
                    try:
                        fetched_at = min(int(zone.get("fetchedAt", 0)), int(time.time() * 1000))
                    except (TypeError, ValueError):
                        fetched_at = 0
                    atomic_write_json(
                        zones_dir / f"zone_{zone_x}_{zone_y}.json",
                        {
                            "fetchedAt": fetched_at,
                            "cells": cells if isinstance(cells, list) else [],
                        },
                    )
                    saved += 1
            self.send_json(200, {"saved": saved, "rejected": rejected, "token": current_token})
            return

        self.send_json(405, {"error": "Method not allowed"})

    # ------------------------------------------------------------------
    # Simple append-only log: logs/log-YYYY-MM-DD.log (UTC-dated,
    # pruned after LOG_RETENTION_DAYS).
    # Accepts the two arguments as GET query params (?a=&b=) or as a JSON
    # POST body {"a": ..., "b": ...}. Both fields are treated as untrusted:
    # control characters (including newlines) are stripped so a caller can't
    # forge extra log lines, and each field is length-capped.
    # ------------------------------------------------------------------
    def stream_server_map(self, server_name, zones_dir, zone_filter, hidden) -> None:
        """Writes {"server": ..., "zones": [...]} one zone at a time.

        The previous implementation parsed every matching zone file into a
        list, serialized the whole list, then gzipped that - three full copies
        of the world in memory at once. A single guest opening a 90 MB world
        could therefore exhaust a 1 GB host, and several at once reliably did.

        Streaming keeps peak memory at roughly one zone (~tens of KB)
        regardless of world size. The response body is byte-identical to
        before, so no client change is needed. Gzip is applied incrementally
        via zlib; because the handler speaks HTTP/1.0 the body is framed by
        connection close rather than Content-Length, which is what allows the
        length to remain unknown while we stream.
        """
        accepts_gzip = "gzip" in str(self.headers.get("Accept-Encoding", "")).lower()
        compressor = zlib.compressobj(6, zlib.DEFLATED, 31) if accepts_gzip else None
        written = 0

        # Frame the body with HTTP/1.1 chunked encoding rather than by closing
        # the connection. A bodyless-length response forces intermediaries
        # (Cloudflare Tunnel, nginx, any buffering proxy) to read the WHOLE
        # thing before they can forward it, which for a full world means tens
        # of megabytes buffered and a client that sits there with nothing.
        # Chunked lets every zone reach the browser as it is produced.
        self.protocol_version = "HTTP/1.1"
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if compressor is not None:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        def write_chunk(data: bytes) -> None:
            if not data:
                return
            self.wfile.write(b"%X\r\n" % len(data))
            self.wfile.write(data)
            self.wfile.write(b"\r\n")

        def emit(text: str) -> None:
            data = text.encode("utf-8")
            if compressor is not None:
                data = compressor.compress(data)
            write_chunk(data)

        try:
            emit('{"server": ' + json.dumps(server_name) + ', "zones": [')
            first = True
            if zones_dir.is_dir():
                for entry in sorted(zones_dir.iterdir()):
                    match = ZONE_FILE_RE.match(entry.name)
                    if not match:
                        continue
                    if zone_filter is not None and f"{int(match.group(1))}_{int(match.group(2))}" not in zone_filter:
                        continue
                    payload = read_json(entry, None)
                    if not isinstance(payload, dict):
                        continue
                    cells = payload.get("cells", [])
                    if hidden and isinstance(cells, list):
                        cells = anonymize_hidden_cells(cells, hidden)
                    zone = {
                        "x": int(match.group(1)),
                        "y": int(match.group(2)),
                        "fetchedAt": payload.get("fetchedAt", 0),
                        "cells": cells,
                    }
                    emit(("" if first else ",") + json.dumps(zone, ensure_ascii=False))
                    first = False
                    written += 1
                    # Release references before the next file is read.
                    del payload, cells, zone
            emit("]}")
            if compressor is not None:
                tail = compressor.flush()
                if tail:
                    write_chunk(tail)
            self.wfile.write(b"0\r\n\r\n")  # end of chunked body
        except (ConnectionError, BrokenPipeError):
            # Browser navigated away mid-download. Expected for big worlds;
            # one line instead of a traceback per abandoned request.
            print(f"[net] client disconnected during map stream for {server_name}")
        finally:
            metric_inc("cache:zoneread", max(1, written))

    def handle_log(self, method: str) -> None:
        if method == "GET":
            params = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            a = (params.get("a", [""])[0])
            b = (params.get("b", [""])[0])
        elif method == "POST":
            body = self.read_json_body()
            if body is None:
                return
            if not isinstance(body, dict):
                self.send_json(400, {"error": "Body must be a JSON object"})
                return
            a = str(body.get("a", ""))
            b = str(body.get("b", ""))
        else:
            self.send_json(405, {"error": "Method not allowed"})
            return

        def clean(value: str) -> str:
            return "".join(ch for ch in str(value) if ch >= " ")[:500]

        a, b = clean(a), clean(b)
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with STORAGE_LOCK:
            with dated_log_path("log").open("a", encoding="utf-8") as handle:
                handle.write(f"{stamp} - {a} {b}\n")
        prune_old_logs()
        self.send_json(200, {"logged": True})

    # ------------------------------------------------------------------
    # API-call log for reproducing errors: logs/api-calls-YYYY-MM-DD.log
    # (UTC-dated, pruned after LOG_RETENTION_DAYS), one JSON object per
    # line (ts, method, path, status, ms, request body, response body).
    # Passwords and session tokens are redacted (see api_log_redact); set
    # BYM_API_LOG_TOKENS=1 to keep tokens when reproducing a call needs them.
    # ------------------------------------------------------------------
    def log_api_call(self, method, target, request_body, status, response_payload, elapsed_ms):
        category = api_log_category(target)
        if not api_log_should_record(category, status, target):
            return
        try:
            req_text = ""
            if isinstance(request_body, (bytes, bytearray)):
                req_text = request_body.decode("utf-8", "replace")
            req_text = api_log_redact(req_text)
            req_text, req_full_len = api_log_cap(req_text)

            resp_text = ""
            if isinstance(response_payload, (bytes, bytearray)):
                resp_text = response_payload.decode("utf-8", "replace")
            elif response_payload is not None:
                resp_text = str(response_payload)
            # The response matters as much as the request here: player/getinfo
            # MINTS a fresh token and echoes it, so the reply carries a live
            # credential even when the request did not.
            resp_text = api_log_redact(resp_text)
            resp_text, resp_full_len = api_log_cap(resp_text)

            entry = {
                "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
                "category": category,
                "method": method,
                "path": target,
                "status": status,
                "ms": round(elapsed_ms, 1),
                "request": req_text,
                "response": resp_text,
            }
            if req_full_len is not None:
                entry["requestTruncated"] = req_full_len
            if resp_full_len is not None:
                entry["responseTruncated"] = resp_full_len
            with STORAGE_LOCK:
                with dated_log_path("api-calls").open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
            prune_old_logs()
        except Exception as error:  # noqa: BLE001 - logging must never break the proxy
            print(f"[api-log] failed to write entry: {error!r}")

    # ------------------------------------------------------------------
    # Game-API proxy: /proxy/<path> -> {BYM_BASE_URL}/<path>
    #
    # All game-API calls the viewer makes (login/getinfo, getnewmap, base/load,
    # worldmapv2/getarea, worlds, leaderboards, ...) come through here instead of
    # the browser hitting the BYM server directly. Benefits: no browser CORS, the
    # Cloudflare-friendly User-Agent is applied server-side, and the upstream
    # host stays server-side. This is a single-target reverse proxy - it only
    # ever talks to the one configured BYM_BASE_URL, never an arbitrary host.
    # ------------------------------------------------------------------
    def handle_proxy(self, method: str) -> None:
        # self.path is a server-relative request target beginning with /proxy.
        tail = self.path[len("/proxy"):]
        if not tail.startswith("/"):
            tail = "/" + tail
        path_part, sep, query_part = tail.partition("?")
        # Refuse anything in the PATH that could redirect us off the configured
        # host (protocol-relative //host, or an absolute scheme://host). The
        # query string is left untouched - it may legitimately contain "://".
        if path_part.startswith("//") or "://" in path_part:
            self.send_json(400, {"error": "Invalid proxy path"})
            return

        # Fetch priority runs 1 (lowest) to 10 (highest); higher priorities
        # are served first when the outbound budget is contended. A request
        # without the header is treated as lowest priority - every call the
        # viewer makes sets it explicitly.
        request_priority = self.read_fetch_priority()

        # Identify the caller for the per-user window - from the token cache
        # only, never a network lookup. Unknown tokens still limit per-token
        # (rotating tokens to evade costs getinfo calls, which are limited
        # themselves); anonymous calls limit per-IP.
        auth_header = self.headers.get("Authorization", "")
        bearer = auth_header[7:].strip() if auth_header.startswith("Bearer ") else ""
        # client_ip(), NOT client_address[0]: the socket peer is always the
        # tunnel, so keying on it put every anonymous caller in one bucket.
        user_key = f"ip:{self.client_ip()}"
        if bearer:
            with TOKEN_CACHE_LOCK:
                cached = TOKEN_CACHE.get(bearer)
            cached_name = None
            if isinstance(cached, tuple) and len(cached) >= 3 and cached[0] and cached[2] > time.time():
                cached_name = str(cached[0])
            user_key = f"user:{cached_name.lower()}" if cached_name else f"tok:{bearer[:16]}"

        if self.requester_bypasses_limits():
            # Ungated, but NOT unrecorded: the call still lands in the global
            # and per-user windows so the console's usage figures stay honest
            # and everyone else's scheduling accounts for the traffic. Same
            # treatment token verification already gets.
            record_bym_call()
            attribute_bym_call(user_key, request_priority)
            ok, reason, waited_seconds, retry_after = (True, "admin-bypass", 0.0, 0)
        else:
            ok, reason, waited_seconds, retry_after = acquire_bym_slot(request_priority, user_key)
        if not ok:
            metric_inc("reject:queue" if reason.endswith("queue-full") else "reject:timeout")
            self.send_json(
                429,
                {"error": "BYM API rate limit reached - try again shortly", "reason": reason},
                {"Retry-After": str(retry_after)},
            )
            return
        metric_inc(f"prio:{request_priority}")
        metric_inc(f"cat:{api_log_category(path_part)}")
        metric_user_call(user_key)
        metric_wait(waited_seconds * 1000.0, request_priority)

        upstream_url = f"{BYM_BASE_URL}{path_part}{sep}{query_part}"
        # Defence in depth: only ever reach the configured upstream host.
        if urllib.parse.urlsplit(upstream_url).netloc != urllib.parse.urlsplit(BYM_BASE_URL).netloc:
            self.send_json(400, {"error": "Invalid proxy target"})
            return

        if method not in ("GET", "POST", "PUT"):
            self.send_json(405, {"error": "Method not allowed"})
            return

        body = None
        if method in ("POST", "PUT"):
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if length > MAX_BODY_BYTES:
                self.send_json(413, {"error": "Request body too large"})
                return
            body = self.rfile.read(length) if length > 0 else b""

        # Adopt the newest session token at DISPATCH time. The game's getinfo
        # endpoint mints a new token and invalidates the old one on every call,
        # so a request that queued for budget may hold a token that was rotated
        # (by a login, a session refresh, or admin verification) while it
        # waited. TOKEN_CACHE maps every token it has seen to the currently
        # minted one; rewriting the Authorization header - and the form-encoded
        # `token` field worldmapv2/getarea requires - lets the long-queued
        # request succeed first try instead of 401ing, retrying client-side,
        # and spending a second budget slot. The client's one-shot auth retry
        # remains as a backstop for tokens the cache has genuinely lost.
        def _current_token_for(presented: str):
            # Follow the rotation chain: T1 may map to T2 which was itself
            # rotated to T3 by a later refresh. Bounded to avoid cycles.
            current = presented
            with TOKEN_CACHE_LOCK:
                for _hop in range(5):
                    cached_entry = TOKEN_CACHE.get(current)
                    if not (isinstance(cached_entry, tuple) and len(cached_entry) >= 3
                            and cached_entry[0] and cached_entry[2] > time.time()):
                        break
                    nxt = str(cached_entry[1] or "").strip()
                    if not nxt or nxt == current:
                        break
                    current = nxt
            return current if current != presented else None

        presented_tokens = []  # every session token this request carried
        authorization = self.headers.get("Authorization")
        tokens_rewritten = False
        if authorization and authorization.startswith("Bearer "):
            presented = authorization[7:].strip()
            if presented:
                presented_tokens.append(presented)
            adopted = _current_token_for(presented)
            if adopted:
                authorization = f"Bearer {adopted}"
                tokens_rewritten = True
        content_type = self.headers.get("Content-Type")
        if (body and content_type
                and content_type.split(";")[0].strip().lower() == "application/x-www-form-urlencoded"):
            try:
                fields = urllib.parse.parse_qsl(
                    body.decode("utf-8"), keep_blank_values=True)
                changed = False
                for index, (name, value) in enumerate(fields):
                    if name == "token" and value:
                        presented_tokens.append(value.strip())
                        adopted = _current_token_for(value.strip())
                        if adopted:
                            fields[index] = (name, adopted)
                            changed = True
                if changed:
                    body = urllib.parse.urlencode(fields).encode("utf-8")
                    tokens_rewritten = True
            except (UnicodeDecodeError, ValueError):
                pass  # not decodable form data: forward untouched
        if tokens_rewritten:
            metric_inc("rewrite")

        # Forward only safe, relevant headers; add the browser-like signature the
        # BYM server's Cloudflare requires (a default urllib UA is blocked 1010).
        forward_headers = {
            "User-Agent": BYM_USER_AGENT,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
        }
        if content_type:
            forward_headers["Content-Type"] = content_type
        if authorization:
            forward_headers["Authorization"] = authorization

        request = urllib.request.Request(
            upstream_url, data=body, headers=forward_headers, method=method
        )
        started_at = time.monotonic()
        log_target = f"{path_part}{sep}{query_part}"
        try:
            with urllib.request.urlopen(request, timeout=PROXY_TIMEOUT) as response:
                payload = response.read()
                status = response.status
                resp_content_type = response.headers.get("Content-Type", "application/json; charset=utf-8")
        except urllib.error.HTTPError as error:
            # Relay the upstream error verbatim so the viewer sees the real
            # status and error body (e.g. an auth/version error) unchanged.
            payload = error.read()
            status = error.code
            resp_content_type = error.headers.get("Content-Type", "application/json; charset=utf-8")
        except Exception as error:  # noqa: BLE001 - DNS/TLS/timeout/etc.
            print(f"[proxy] {method} {upstream_url} failed: {error!r}")
            self.log_api_call(
                method, log_target, body, "transport-error",
                repr(error), (time.monotonic() - started_at) * 1000,
            )
            metric_upstream((time.monotonic() - started_at) * 1000, False)
            self.send_json(502, {"error": "Upstream request failed"})
            return

        elapsed_ms = (time.monotonic() - started_at) * 1000
        self.log_api_call(method, log_target, body, status, payload, elapsed_ms)
        metric_upstream(elapsed_ms, 200 <= int(status) < 400)

        # Every successful base/load response is archived verbatim under
        # storage/baseloads/ for later data analysis: one file per view,
        # named {baseid}_{mode}_{UTC timestamp}.json. Never fatal.
        if "/base/load" in path_part and int(status) == 200 and payload:
            try:
                save_baseload_capture(body, payload)
            except Exception as error:  # noqa: BLE001
                print(f"[baseloads] capture failed: {error!r}")

        # Learn rotations flowing THROUGH the proxy: a successful getinfo just
        # invalidated every token this request presented and minted a new one.
        # Recording presented->minted (and minted->minted) here keeps the
        # dispatch-time adoption above accurate for tokens that were never
        # verified via /api/admin/me - i.e. ordinary session refreshes.
        if "/player/getinfo" in path_part and int(status) == 200:
            try:
                info = json.loads(payload.decode("utf-8", "replace"))
                minted = str(info.get("token", "")).strip()
                minted_user = str(info.get("username", "")).strip()
                if minted and minted_user and not info.get("error"):
                    # Sign-in is where a rename made in the game first reaches
                    # the viewer. Record the authoritative userid->name pair
                    # (migrating per-name data if it moved) BEFORE the
                    # whitelist check below, which may still list the old
                    # name - otherwise a whitelisted player would be locked
                    # out by their own rename.
                    record_user_identity(info.get("userid", info.get("userId", 0)), minted_user)
                    # Sign-in whitelist: refuse to hand the session back to a
                    # player who is not allowed on this viewer. The game
                    # already rotated their token, which is harmless - they
                    # simply never receive it, so no session is established.
                    if whitelist_blocks(minted_user):
                        print(f"[whitelist] refused sign-in for {minted_user}")
                        self.send_json(403, {"error": WHITELIST_DENIED_MESSAGE})
                        return
                    expiry = time.time() + TOKEN_CACHE_TTL
                    with TOKEN_CACHE_LOCK:
                        TOKEN_CACHE[minted] = (minted_user, minted, expiry)
                        for presented in presented_tokens:
                            if presented and presented != minted:
                                TOKEN_CACHE[presented] = (minted_user, minted, expiry)
            except (ValueError, AttributeError):
                pass

        try:
            self.send_response(status)
            self.send_header("Content-Type", resp_content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            if method != "HEAD":
                self.wfile.write(payload)
        except (ConnectionError, BrokenPipeError):
            # The browser went away mid-response (page reload, tab closed, or
            # an abandoned zone fetch). Harmless: note it in one line instead
            # of letting socketserver dump a traceback per aborted request.
            print(f"[net] client disconnected during {method} {log_target}")

    # ------------------------------------------------------------------
    # Public profile: users/{username}/profile.json currently stores only
    # the game avatar URL, captured when that player signs into the viewer.
    # Read access is public (avatars are public in the game); writes happen
    # via the authenticated login-record endpoint.
    # ------------------------------------------------------------------
    def handle_public_profile(self, method: str, path: str) -> None:
        if method != "GET":
            self.send_json(405, {"error": "Method not allowed"})
            return
        raw_name = path[len("/api/storage/profile"):].strip("/")
        username = sanitize_name(raw_name)
        if not username:
            self.send_json(400, {"error": "Invalid username"})
            return
        # Moderation-hidden players are excluded from profiles for normal
        # users. Answer exactly like a player with no stored avatar, so the
        # endpoint does not confirm that hiding is in effect for this name.
        if not self.requester_is_admin():
            hidden = hidden_name_set()
            current = resolve_current_name(username)
            if (username.lower() in hidden
                    or (current and str(current).strip().lower() in hidden)):
                self.send_json(200, {"name": username, "pic": ""})
                return
        payload = read_json(user_dir(username) / "profile.json", {})
        pic = str(payload.get("pic", "")) if isinstance(payload, dict) else ""
        if not pic:
            # The name may be somebody's PREVIOUS name (they renamed in the
            # game). Resolve it through the identity index so stale links and
            # cached map cells still find the player's avatar - and tell the
            # caller the current name so the UI can show it.
            current = resolve_current_name(username)
            current_safe = sanitize_name(current) if current else None
            if current_safe and current_safe.lower() != username.lower():
                payload = read_json(user_dir(current_safe) / "profile.json", {})
                pic = str(payload.get("pic", "")) if isinstance(payload, dict) else ""
                self.send_json(200, {"name": current, "pic": pic, "renamedFrom": username})
                return
        self.send_json(200, {"name": username, "pic": pic})

    # ------------------------------------------------------------------
    # Alliances. Every endpoint requires a verified session; the game
    # username IS the alliance identity. Responses echo the current token
    # (verification rotates it) exactly like the per-user storage endpoints.
    # ------------------------------------------------------------------
    def handle_alliance(self, method: str, path: str) -> None:
        username, current_token = self.requester_identity()
        if not username:
            self.send_json(401, self.unauthenticated_payload())
            return
        endpoint = path[len("/api/alliance/"):].strip("/").split("?", 1)[0]

        if method == "GET" and endpoint == "me":
            _, mine = alliance_of(username)
            low = username.strip().lower()
            invites = [
                data.get("name", "")
                for _, data in load_alliances()
                if any(str(i).strip().lower() == low for i in data.get("invites", []))
            ]
            view = None
            if mine:
                view = alliance_public_view(mine, username)
                view["members"] = [
                    enrich_member(mine, str(m)) for m in mine.get("members", [])
                ]
                view["members"].sort(
                    key=lambda m: (-RANK_ORDER[m["rank"]], m["name"].lower()))
                all_alliances = load_alliances()
                alliance_by_member = build_alliance_by_member(all_alliances)
                view["enemies"] = [
                    enrich_enemy(str(e), alliance_by_member) for e in mine.get("enemies", [])
                ]
                groups = []
                for enemy_name in mine.get("enemyAlliances", []):
                    low_name = str(enemy_name).strip().lower()
                    match = next(
                        (d for _, d in all_alliances
                         if str(d.get("name", "")).strip().lower() == low_name),
                        None,
                    )
                    groups.append({
                        "name": str(enemy_name),
                        "exists": match is not None,
                        "members": [
                            enrich_enemy(str(m), alliance_by_member)
                            for m in (match or {}).get("members", [])
                        ],
                    })
                view["enemyAlliances"] = groups
                view["targets"] = [
                    t for t in mine.get("targets", []) if isinstance(t, dict)
                ][-100:]
                now_ms = int(time.time() * 1000)
                view["feed"] = list(reversed([
                    e for e in mine.get("feed", [])
                    if isinstance(e, dict)
                    and now_ms - int(e.get("at", 0) or 0) <= FEED_MAX_AGE_MS
                ][-50:]))
            self.send_json(200, {
                "alliance": view,
                "invites": [name for name in invites if name],
                "token": current_token,
            })
            return

        if method == "GET" and endpoint == "watch-zones":
            _, mine = alliance_of(username)
            if not mine:
                self.send_json(403, {"error": "You are not in an alliance"})
                return
            member_lows = {str(m).strip().lower() for m in mine.get("members", [])}
            worlds: dict = {}
            for server_dir in sorted(STORAGE_ROOT.glob("server_*")):
                world = server_dir.name[len("server_"):]
                index = get_player_index(world)
                origins = set()
                for low in member_lows:
                    hit = index.get(low)
                    if hit:
                        origins |= set(hit.get("zones", set()))
                if origins:
                    worlds[world] = [
                        {"x": x, "y": y} for x, y in sorted(origins)
                    ][:80]
            self.send_json(200, {"worlds": worlds, "token": current_token})
            return

        if method == "GET" and endpoint == "chat":
            _, mine = alliance_of(username)
            if not mine:
                self.send_json(403, {"error": "You are not in an alliance"})
                return
            params = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            try:
                since = int(params.get("since", ["0"])[0])
            except ValueError:
                since = 0
            messages = [
                m for m in mine.get("chat", [])
                if isinstance(m, dict) and int(m.get("at", 0)) > since
            ]
            self.send_json(200, {"messages": messages, "token": current_token})
            return

        if method != "POST":
            self.send_json(405, {"error": "Method not allowed"})
            return
        # Body is optional (e.g. /leave sends none); when present it must be
        # a JSON object.
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length > 0:
            body = self.read_json_body()
            if body is None:
                return
            if not isinstance(body, dict):
                self.send_json(400, {"error": "Body must be a JSON object"})
                return
        else:
            body = {}

        with STORAGE_LOCK:
            if endpoint == "create":
                display = str(body.get("name", "")).strip()[:40]
                safe = sanitize_name(display)
                if not display or not safe:
                    self.send_json(400, {"error": "Alliance name is required"})
                    return
                _, mine = alliance_of(username)
                if mine:
                    self.send_json(400, {"error": "Leave your current alliance first"})
                    return
                file_path = alliances_dir() / f"{safe.lower()}.json"
                if file_path.exists():
                    self.send_json(400, {"error": "An alliance with that name already exists"})
                    return
                data = {
                    "name": display,
                    "leader": username,
                    "members": [username],
                    "invites": [],
                    "enemies": [],
                    "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "chat": [],
                }
                atomic_write_json(file_path, data)
                self.send_json(200, {"alliance": alliance_public_view(data, username), "token": current_token})
                return

            if endpoint == "invite":
                target = str(body.get("name", "")).strip()[:80]
                if not target:
                    self.send_json(400, {"error": "A username to invite is required"})
                    return
                file_path, mine = alliance_of(username)
                if not mine:
                    self.send_json(403, {"error": "You are not in an alliance"})
                    return
                if RANK_ORDER[member_rank(mine, username)] < RANK_ORDER["member"]:
                    self.send_json(403, {"error": "Recruits cannot invite players"})
                    return
                low = target.lower()
                _, theirs = alliance_of(target)
                if theirs:
                    self.send_json(400, {"error": f"{target} is already in an alliance"})
                    return
                if any(str(m).strip().lower() == low for m in mine["members"]):
                    self.send_json(400, {"error": f"{target} is already a member"})
                    return
                if not any(str(i).strip().lower() == low for i in mine.get("invites", [])):
                    mine.setdefault("invites", []).append(target)
                    atomic_write_json(file_path, mine)
                self.send_json(200, {"alliance": alliance_public_view(mine, username), "token": current_token})
                return

            if endpoint == "uninvite":
                target = str(body.get("name", "")).strip()
                if not target:
                    self.send_json(400, {"error": "A username is required"})
                    return
                file_path, mine = alliance_of(username)
                if not mine:
                    self.send_json(403, {"error": "You are not in an alliance"})
                    return
                if RANK_ORDER[member_rank(mine, username)] < RANK_ORDER["member"]:
                    self.send_json(403, {"error": "Recruits cannot revoke invites"})
                    return
                low = target.lower()
                before = len(mine.get("invites", []))
                mine["invites"] = [
                    i for i in mine.get("invites", []) if str(i).strip().lower() != low
                ]
                if len(mine["invites"]) == before:
                    self.send_json(404, {"error": f"{target} has no pending invite"})
                    return
                atomic_write_json(file_path, mine)
                self.send_json(200, {"alliance": alliance_public_view(mine, username), "token": current_token})
                return

            if endpoint == "feed-clear":
                file_path, mine = alliance_of(username)
                if not mine:
                    self.send_json(403, {"error": "You are not in an alliance"})
                    return
                if RANK_ORDER[member_rank(mine, username)] < RANK_ORDER["officer"]:
                    self.send_json(403, {"error": "Only officers and the leader can clear the feed"})
                    return
                mine["feed"] = []
                atomic_write_json(file_path, mine)
                self.send_json(200, {"cleared": True, "token": current_token})
                return

            if endpoint == "respond":
                target_name = str(body.get("alliance", "")).strip()
                action = str(body.get("action", "")).strip().lower()
                if action not in ("accept", "decline"):
                    self.send_json(400, {"error": "action must be accept or decline"})
                    return
                low_me = username.strip().lower()
                match = None
                for file_path, data in load_alliances():
                    if str(data.get("name", "")).strip().lower() == target_name.lower():
                        match = (file_path, data)
                        break
                if not match or not any(str(i).strip().lower() == low_me for i in match[1].get("invites", [])):
                    self.send_json(404, {"error": "No such invite"})
                    return
                file_path, data = match
                data["invites"] = [i for i in data.get("invites", []) if str(i).strip().lower() != low_me]
                if action == "accept":
                    _, mine = alliance_of(username)
                    if mine:
                        self.send_json(400, {"error": "Leave your current alliance first"})
                        return
                    data["members"].append(username)
                    data.setdefault("ranks", {})[username.strip().lower()] = "recruit"
                atomic_write_json(file_path, data)
                self.send_json(200, {
                    "alliance": alliance_public_view(data, username) if action == "accept" else None,
                    "token": current_token,
                })
                return

            if endpoint == "leave":
                file_path, mine = alliance_of(username)
                if not mine:
                    self.send_json(403, {"error": "You are not in an alliance"})
                    return
                low_me = username.strip().lower()
                mine["members"] = [m for m in mine["members"] if str(m).strip().lower() != low_me]
                mine.setdefault("ranks", {}).pop(low_me, None)
                if not mine["members"]:
                    file_path.unlink(missing_ok=True)
                else:
                    if str(mine.get("leader", "")).strip().lower() == low_me:
                        # Leadership passes to the highest-ranked remaining member.
                        successor = max(
                            mine["members"],
                            key=lambda m: RANK_ORDER[member_rank(mine, str(m))],
                        )
                        mine["leader"] = successor
                        mine["ranks"].pop(str(successor).strip().lower(), None)
                    atomic_write_json(file_path, mine)
                self.send_json(200, {"alliance": None, "token": current_token})
                return

            if endpoint == "kick":
                target = str(body.get("name", "")).strip()
                file_path, mine = alliance_of(username)
                if not mine:
                    self.send_json(403, {"error": "You are not in an alliance"})
                    return
                actor_rank = member_rank(mine, username)
                # NOTE: this rank matrix is intentionally duplicated in the
                # client (app/static/js/viewer-app.js, renderAlliancePanel -
                # canPromote / canDemote / canKick). The client decides which
                # buttons to show; this is the authority. Change both together.
                # Members may remove recruits; officers members and
                # recruits; the leader anyone below. (Mirrors the client's
                # rank matrix exactly.)
                if RANK_ORDER[actor_rank] < RANK_ORDER["member"]:
                    self.send_json(403, {"error": "Recruits cannot remove members"})
                    return
                low = target.lower()
                if low == username.strip().lower():
                    self.send_json(400, {"error": "Use Leave to exit your own alliance"})
                    return
                if not any(str(m).strip().lower() == low for m in mine["members"]):
                    self.send_json(404, {"error": f"{target} is not a member"})
                    return
                if RANK_ORDER[member_rank(mine, target)] >= RANK_ORDER[actor_rank]:
                    self.send_json(403, {"error": "You cannot remove someone of equal or higher rank"})
                    return
                mine["members"] = [m for m in mine["members"] if str(m).strip().lower() != low]
                mine.setdefault("ranks", {}).pop(low, None)
                atomic_write_json(file_path, mine)
                self.send_json(200, {"alliance": alliance_public_view(mine, username), "token": current_token})
                return

            if endpoint in ("promote", "demote"):
                target = str(body.get("name", "")).strip()
                file_path, mine = alliance_of(username)
                if not mine:
                    self.send_json(403, {"error": "You are not in an alliance"})
                    return
                actor_rank = member_rank(mine, username)
                low = target.lower()
                is_self = low == username.strip().lower()
                # Promotion is leader-only, never on yourself. Demotion is
                # leader-only on others - but an officer may step down and
                # demote THEMSELF (officer -> member).
                target_rank = member_rank(mine, target)
                if endpoint == "promote":
                    if is_self:
                        self.send_json(400, {"error": "You cannot change your own rank"})
                        return
                    allowed = (
                        actor_rank == "leader"
                        or (actor_rank == "officer"
                            and target_rank in ("recruit", "member"))
                    )
                    if not allowed:
                        self.send_json(403, {"error": "Officers may promote recruits and members; only the leader can promote officers"})
                        return
                elif not (
                    (actor_rank == "leader" and not is_self)
                    or (actor_rank == "officer" and not is_self and target_rank == "member")
                    or (is_self and actor_rank == "officer")
                ):
                    self.send_json(403, {
                        "error": "Officers may demote members or step down themselves; the leader may demote anyone",
                    })
                    return
                if not any(str(m).strip().lower() == low for m in mine["members"]):
                    self.send_json(404, {"error": f"{target} is not a member"})
                    return
                current = member_rank(mine, target)
                ranks = mine.setdefault("ranks", {})
                if endpoint == "promote":
                    if current == "officer":
                        # Promoting an officer transfers leadership; the old
                        # leader steps down to officer.
                        old_leader = str(mine.get("leader", ""))
                        mine["leader"] = target
                        ranks.pop(low, None)
                        ranks[old_leader.strip().lower()] = "officer"
                    elif current == "leader":
                        self.send_json(400, {"error": f"{target} already leads the alliance"})
                        return
                    else:
                        ranks[low] = ALLIANCE_RANKS[RANK_ORDER[current] + 1]
                else:
                    if current in ("recruit", "leader"):
                        self.send_json(400, {"error": f"{target} cannot be demoted further"
                                             if current == "recruit"
                                             else "Promote another officer to replace the leader instead"})
                        return
                    ranks[low] = ALLIANCE_RANKS[RANK_ORDER[current] - 1]
                atomic_write_json(file_path, mine)
                self.send_json(200, {"alliance": alliance_public_view(mine, username), "token": current_token})
                return

            if endpoint == "enemies":
                # Alliance-wide enemy list: these players render red on every
                # member's map. Officers and the leader manage it.
                action = str(body.get("action", "")).strip().lower()
                target = str(body.get("name", "")).strip()[:80]
                if not target or action not in ("add", "remove", "remove_alliance"):
                    self.send_json(400, {"error": "Body must be {action: add|remove|remove_alliance, name}"})
                    return
                file_path, mine = alliance_of(username)
                if not mine:
                    self.send_json(403, {"error": "You are not in an alliance"})
                    return
                if RANK_ORDER[member_rank(mine, username)] < RANK_ORDER["officer"]:
                    self.send_json(403, {"error": "Only officers and the leader can edit the enemy list"})
                    return
                low = target.lower()
                enemies = [str(e) for e in mine.get("enemies", []) if str(e).strip()]
                enemy_alliances = [str(a) for a in mine.get("enemyAlliances", []) if str(a).strip()]
                if action == "add":
                    if any(str(m).strip().lower() == low for m in mine.get("members", [])):
                        self.send_json(400, {"error": f"{target} is an alliance member"})
                        return
                    # If the target belongs to an alliance, the whole alliance
                    # becomes the enemy: current AND future members, tracked
                    # dynamically by alliance name rather than a roster copy.
                    _, theirs = alliance_of(target)
                    if theirs:
                        their_name = str(theirs.get("name", "")).strip()
                        if not any(a.strip().lower() == their_name.lower() for a in enemy_alliances):
                            enemy_alliances.append(their_name)
                            enemy_alliances = enemy_alliances[-50:]
                    elif not any(e.strip().lower() == low for e in enemies):
                        enemies.append(target)
                        enemies = enemies[-200:]
                elif action == "remove":
                    enemies = [e for e in enemies if e.strip().lower() != low]
                else:  # remove_alliance
                    enemy_alliances = [a for a in enemy_alliances if a.strip().lower() != low]
                mine["enemies"] = enemies
                mine["enemyAlliances"] = enemy_alliances
                atomic_write_json(file_path, mine)
                self.send_json(200, {"alliance": alliance_public_view(mine, username), "token": current_token})
                return

            if endpoint == "targets":
                # Shared target list: coordinates + note, world-tagged so
                # cross-server alliances can jump correctly. Members and up
                # may add; removal is officer+ or the original adder.
                action = str(body.get("action", "")).strip().lower()
                if action not in ("add", "remove"):
                    self.send_json(400, {"error": "Body must be {action: add|remove, ...}"})
                    return
                file_path, mine = alliance_of(username)
                if not mine:
                    self.send_json(403, {"error": "You are not in an alliance"})
                    return
                actor_rank = member_rank(mine, username)
                try:
                    tx = int(body.get("x"))
                    ty = int(body.get("y"))
                except (TypeError, ValueError):
                    self.send_json(400, {"error": "x and y must be integers"})
                    return
                world = str(body.get("world", "")).strip()[:64]
                targets = [t for t in mine.get("targets", []) if isinstance(t, dict)]
                if RANK_ORDER[actor_rank] < RANK_ORDER["officer"]:
                    self.send_json(403, {"error": "Only officers and the leader manage targets"})
                    return
                if action == "add":
                    note = "".join(
                        ch for ch in str(body.get("note", "")) if ch >= " "
                    ).strip()[:120]
                    entry = {
                        "x": tx, "y": ty, "world": world, "note": note,
                        "addedBy": username,
                        "at": int(time.time() * 1000),
                    }
                    targets = [
                        t for t in targets
                        if not (t.get("x") == tx and t.get("y") == ty and t.get("world") == world)
                    ]
                    targets.append(entry)
                    targets = targets[-100:]
                else:
                    match = next(
                        (t for t in targets
                         if t.get("x") == tx and t.get("y") == ty
                         and str(t.get("world", "")) == world),
                        None,
                    )
                    if not match:
                        self.send_json(404, {"error": "No such target"})
                        return
                    targets.remove(match)
                mine["targets"] = targets
                atomic_write_json(file_path, mine)
                self.send_json(200, {"alliance": alliance_public_view(mine, username), "token": current_token})
                return

            if endpoint == "feed":
                # Shared activity feed: members report capture/loss events
                # their clients detected during normal zone refetches. Events
                # are deduplicated across reporters (several members often
                # observe the same change).
                events = body.get("events")
                if not isinstance(events, list) or not events:
                    self.send_json(400, {"error": "Body must be {events: [...]}"})
                    return
                file_path, mine = alliance_of(username)
                if not mine:
                    self.send_json(403, {"error": "You are not in an alliance"})
                    return
                feed = [e for e in mine.get("feed", []) if isinstance(e, dict)]
                latest_by_cell = {}
                for e in feed:
                    latest_by_cell[(e.get("x"), e.get("y"), str(e.get("world", "")))] = e
                added = 0
                for raw in events[:20]:
                    if not isinstance(raw, dict):
                        continue
                    kind = str(raw.get("kind", "")).strip().lower()
                    player = str(raw.get("playerName", "")).strip()[:80]
                    if kind not in ("captured", "lost") or not player:
                        continue
                    try:
                        ex = int(raw.get("x"))
                        ey = int(raw.get("y"))
                        at = int(raw.get("at", 0) or 0)
                    except (TypeError, ValueError):
                        continue
                    world = str(raw.get("world", "")).strip()[:64]
                    low = player.lower()
                    cell_key = (ex, ey, world)
                    latest = latest_by_cell.get(cell_key)
                    if (latest
                            and latest.get("kind") == kind
                            and str(latest.get("playerName", "")).strip().lower() == low):
                        continue  # same transition already recorded by another member
                    entry = {
                        "kind": kind,
                        "playerName": player,
                        "x": ex, "y": ey,
                        "world": world,
                        "cellType": str(raw.get("cellType", "")).strip()[:20],
                        "level": int(raw.get("level", 0) or 0),
                        "otherParty": str(raw.get("otherParty", "")).strip()[:80],
                        "at": at,
                        "by": username,
                    }
                    feed.append(entry)
                    latest_by_cell[cell_key] = entry
                    added += 1
                if added:
                    cutoff = int(time.time() * 1000) - FEED_MAX_AGE_MS
                    feed = [e for e in feed if int(e.get("at", 0) or 0) >= cutoff]
                    mine["feed"] = feed[-200:]
                    atomic_write_json(file_path, mine)
                self.send_json(200, {"added": added, "token": current_token})
                return

            if endpoint == "chat":
                file_path, mine = alliance_of(username)
                if not mine:
                    self.send_json(403, {"error": "You are not in an alliance"})
                    return
                if not chat_flood_allow(username):
                    self.send_json(429, {
                        "error": "Slow down - a few messages per half minute is the limit",
                        "token": current_token,
                    })
                    return
                text = "".join(
                    ch for ch in str(body.get("text", "")) if ch >= " " or ch == "\t"
                ).strip()[:ALLIANCE_CHAT_TEXT_LIMIT]
                if not text:
                    self.send_json(400, {"error": "Message text is required"})
                    return
                message = {
                    "at": int(time.time() * 1000),
                    "from": username,
                    "text": text,
                }
                chat = mine.get("chat", [])
                chat = chat if isinstance(chat, list) else []
                chat.append(message)
                mine["chat"] = chat[-ALLIANCE_CHAT_LIMIT:]
                atomic_write_json(file_path, mine)
                self.send_json(200, {"message": message, "token": current_token})
                return

        self.send_json(404, {"error": "Unknown alliance endpoint"})

    # ------------------------------------------------------------------
    # Per-user viewer settings blob: users/{username}/settings.json
    # ------------------------------------------------------------------
    # Per-user data requires a signed-in session: the X-Viewer-Token is
    # verified against the game server, and the verified username must match
    # the requested user directory (admins may access any user). Verifying
    # rotates the game token, so on success this returns the CURRENT valid
    # token; every response below echoes it as "token" for the client to
    # adopt (the same contract as /api/admin/me). Returns None after sending
    # the error response.
    def require_user_access(self, username: str):
        """Returns (current_token, effective_username) or None after erroring.

        Rename-aware: a client that signed in before renaming keeps requesting
        its OLD directory name for the rest of the session (the game client
        also keeps the old name in memory until restart). Verification just
        migrated the data to the new name, so a request for one of the
        requester's recorded previous names is treated as a request for their
        current directory rather than a 403.
        """
        requester, current_token = self.requester_identity()
        if not requester:
            self.send_json(401, self.unauthenticated_payload())
            return None
        requester_dir = sanitize_name(requester) or ""
        if requester_dir.lower() == username.lower():
            return (current_token, requester_dir)
        current = resolve_current_name(username)
        if current and (sanitize_name(current) or "").lower() == requester_dir.lower():
            # The requested name is a previous name of the requester; serve
            # their current (already-migrated) directory.
            return (current_token, requester_dir)
        if requester.lower() in admin_name_set_lower():
            return (current_token, username)
        self.send_json(403, {"error": "You can only access your own data"})
        return None

    def handle_user_settings(self, method: str, raw_name: str) -> None:
        username = sanitize_name(raw_name)
        if not username:
            self.send_json(400, {"error": "Invalid username"})
            return
        access = self.require_user_access(username)
        if access is None:
            return
        current_token, username = access

        settings_path = user_dir(username) / "settings.json"

        if method == "GET":
            payload = read_json(settings_path, {})
            payload = payload if isinstance(payload, dict) else {}
            self.send_json(200, {**payload, "token": current_token})
            return

        if method == "PUT":
            body = self.read_json_body()
            if body is None:
                return
            if not isinstance(body, dict):
                self.send_json(400, {"error": "Settings must be a JSON object"})
                return
            # Never persist a stray "token" echo back into the settings blob.
            body.pop("token", None)
            with STORAGE_LOCK:
                atomic_write_json(settings_path, body)
            self.send_json(200, {"saved": True, "token": current_token})
            return

        self.send_json(405, {"error": "Method not allowed"})

    # ------------------------------------------------------------------
    # Per-user login times (UTC): users/{username}/logins.json
    # ------------------------------------------------------------------
    def handle_user_logins(self, method: str, raw_name: str) -> None:
        username = sanitize_name(raw_name)
        if not username:
            self.send_json(400, {"error": "Invalid username"})
            return
        access = self.require_user_access(username)
        if access is None:
            return
        current_token, username = access

        logins_path = user_dir(username) / "logins.json"

        if method == "GET":
            payload = read_json(logins_path, [])
            self.send_json(200, payload if isinstance(payload, list) else [])
            return

        if method == "POST":
            body = self.read_json_body()
            if body is None:
                return
            via = str(body.get("via", "")) if isinstance(body, dict) else ""
            pic = str(body.get("pic", "")).strip()[:300] if isinstance(body, dict) else ""
            if pic.startswith("http://") or pic.startswith("https://"):
                # Capture the player's game avatar for the public profile view.
                with STORAGE_LOCK:
                    atomic_write_json(user_dir(username) / "profile.json", {
                        "pic": pic,
                        "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    })
            entry = {"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
            if via:
                entry["via"] = via[:32]
            with STORAGE_LOCK:
                logins = read_json(logins_path, [])
                if not isinstance(logins, list):
                    logins = []
                logins.append(entry)
                atomic_write_json(logins_path, logins)
            self.send_json(200, {"count": len(logins), "recorded": entry, "token": current_token})
            return

        self.send_json(405, {"error": "Method not allowed"})

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    # Admin console API (/setup/). Identity is proven with a real BYM session
    # token (X-Viewer-Token), verified against the game server, then checked
    # against the editable admin allowlist (admin/admins.json).
    # ------------------------------------------------------------------
    def requester_identity(self):
        """Returns (username, current_valid_token) for the caller's session.

        Verifying the token rotates it on the game server, so the returned token
        is the one that is actually active afterwards - the caller should adopt
        it for subsequent authenticated requests.
        """
        token = str(self.headers.get("X-Viewer-Token", "")).strip()
        if not token:
            return ("", "")
        username, current = verify_bym_token(token)
        # A player refused by the sign-in whitelist is anonymous to the viewer
        # even if they still hold a live game token (e.g. the list was enabled
        # after they signed in). They can still browse the cache as a guest;
        # they just cannot write to it or act as themselves.
        if username and whitelist_blocks(username):
            return ("", current or token)
        return (username or "", current or token)

    def unauthenticated_payload(self) -> dict:
        """401 body that says WHY, so the client can react correctly.

        "expired" means the game server refused the token - rotation moved
        past this session and the player must sign in again. A transport
        failure must not say that: the token is probably fine and the viewer
        could not reach the game server, so telling the player to sign in
        again sends them to re-authenticate against something that is down.
        """
        token = str(self.headers.get("X-Viewer-Token", "")).strip()
        reason = token_failure_reason(token) if token else ""
        if reason == "expired":
            return {"error": "Your game session expired - sign in again",
                    "reason": "expired", "retry": False}
        if reason in ("transport", "rejected"):
            return {"error": "Could not reach the game server to verify your "
                             "session - try again in a moment",
                    "reason": reason, "retry": True}
        return {"error": "Sign in required", "reason": "anonymous", "retry": False}

    def requester_user(self) -> str:
        return self.requester_identity()[0]

    def requester_is_admin(self) -> bool:
        # Compare case-insensitively on both sides: names may be written in any
        # casing, and the username the game reports may differ in case.
        return self.requester_user().lower() in admin_name_set_lower()

    def route_ops(self, method: str, endpoint: str, admin: str) -> None:
        """Operator console API. Every caller is already a verified admin -
        route_admin gates before dispatching here.

        The live view is CURSOR POLLING, not SSE, and that is a deliberate
        change from the plan. EventSource cannot send a custom header, and auth
        in this server is the X-Viewer-Token header with no cookie anywhere -
        so an EventSource stream would have to carry the token in the query
        string and leak it into this very request log. ThreadingHTTPServer also
        gives each connection its own thread, so an open stream pins a thread
        per watching operator. Polling /requests?since=<id> once a second is a
        single indexed query, needs no reconnect logic, and makes pause/resume
        simply "stop asking".
        """
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

        def one(name: str, default: str = "") -> str:
            return str(query.get(name, [default])[0])

        # ---- 15. rate-limit bucket inspector -------------------------------
        if method == "GET" and endpoint == "buckets":
            now = time.monotonic()
            user_rate = float(get_setting("viewerUserPerMin"))
            user_burst = float(get_setting("viewerUserBurst"))
            ip_rate = float(get_setting("viewerIpPerMin"))
            ip_burst = float(get_setting("viewerIpBurst"))
            rows = []
            with RATE_LIMIT_LOCK:
                snapshot = list(RATE_BUCKETS.items())
            for key, bucket in snapshot:
                kind = key.split(":", 1)[0]
                rate = user_rate if kind == "user" else ip_rate
                burst = user_burst if kind == "user" else ip_burst
                # Replay the refill so the reading is current rather than
                # whatever it was at the bucket's last request.
                tokens = min(burst, bucket[0] + (now - bucket[1]) * (rate / 60.0))
                rows.append({
                    "key": key,
                    "kind": kind,
                    "tokens": round(tokens, 2),
                    "burst": burst,
                    "perMinute": rate,
                    "headroom": round(100.0 * tokens / burst, 1) if burst else 0,
                    "idleSeconds": round(now - bucket[1], 1),
                    # Keyed on loopback means the tunnel is being treated as one
                    # client - the bug fixed earlier. Surfaced so a regression
                    # is visible rather than silent.
                    "suspicious": key in ("ip:127.0.0.1", "ip:::1",
                                          "ip:::ffff:127.0.0.1"),
                })
            rows.sort(key=lambda r: r["headroom"])
            self.send_json(200, {
                "buckets": rows,
                "total": len(rows),
                "idleCutoff": RATE_BUCKET_IDLE_SECONDS,
                "limits": {"userPerMin": user_rate, "userBurst": user_burst,
                           "ipPerMin": ip_rate, "ipBurst": ip_burst},
            })
            return

        # ---- 17/33. sessions and the token cache ---------------------------
        if method == "GET" and endpoint == "sessions":
            now = time.time()
            with TOKEN_CACHE_LOCK:
                snapshot = list(TOKEN_CACHE.items())
            seen, rows = {}, []
            for token, entry in snapshot:
                if not (isinstance(entry, tuple) and len(entry) >= 3):
                    continue
                username, current, expiry = entry[0], entry[1], entry[2]
                # Tokens are secrets: only a short prefix is ever sent, enough
                # to identify a row for revocation and nothing more.
                rows.append({
                    "handle": str(token)[:10],
                    "user": str(username or "(anonymous)"),
                    "expiresIn": int(expiry - now),
                    "live": expiry > now,
                    "rotated": bool(current and current != token),
                })
                if username:
                    seen[str(username).lower()] = seen.get(
                        str(username).lower(), 0) + 1
            rows.sort(key=lambda r: (-r["expiresIn"], r["user"]))
            self.send_json(200, {
                "sessions": rows,
                "users": [{"user": u, "tokens": n} for u, n in
                          sorted(seen.items(), key=lambda kv: -kv[1])],
                "ttl": TOKEN_CACHE_TTL,
                "note": "Only a 10-character handle is exposed; full tokens "
                        "never leave the server.",
            })
            return

        if method == "POST" and endpoint == "revoke":
            body = self.read_json_body()
            if not isinstance(body, dict):
                self.send_json(400, {"error": "Expected a JSON object"})
                return
            handle = str(body.get("handle", "")).strip()
            target_user = str(body.get("user", "")).strip().lower()
            if not handle and not target_user:
                self.send_json(400, {"error": "Give a handle or a user"})
                return
            dropped = 0
            with TOKEN_CACHE_LOCK:
                for token in [t for t, e in TOKEN_CACHE.items()
                              if (handle and str(t).startswith(handle))
                              or (target_user and isinstance(e, tuple) and e
                                  and str(e[0] or "").lower() == target_user)]:
                    TOKEN_CACHE.pop(token, None)
                    dropped += 1
            # Dropping the cache entry does not invalidate the game token: it
            # forces the next request to re-verify upstream, which is what
            # "revoke" can mean from here. Said plainly so it is not mistaken
            # for a hard sign-out.
            append_audit(admin, "ops-revoke-cache",
                         (handle or target_user) + f" ({dropped} entr(ies))")
            self.send_json(200, {
                "dropped": dropped,
                "note": "Cache entries dropped. The next request from these "
                        "tokens re-verifies against the game server; this is "
                        "not a hard sign-out.",
            })
            return

        # ---- 11. honeypot pattern editing ----------------------------------
        if method == "POST" and endpoint == "honeypot-add":
            body = self.read_json_body()
            pattern = str(body.get("pattern", "")) if isinstance(body, dict) else ""
            accepted, message = honeypot_custom_add(pattern)
            if not accepted:
                self.send_json(400, {"error": message})
                return
            append_audit(admin, "ops-honeypot-add", pattern)
            self.send_json(200, {"message": message,
                                 "custom": sorted(HONEYPOT_CUSTOM)})
            return

        if method == "POST" and endpoint == "honeypot-remove":
            body = self.read_json_body()
            pattern = str(body.get("pattern", "")) if isinstance(body, dict) else ""
            if not honeypot_custom_remove(pattern):
                self.send_json(400, {
                    "error": "Not a custom pattern. Built-in patterns cannot be "
                             "removed from the console - edit HONEYPOT_PREFIXES."})
                return
            append_audit(admin, "ops-honeypot-remove", pattern)
            self.send_json(200, {"custom": sorted(HONEYPOT_CUSTOM)})
            return

        # ---- 23. audit log: filter, search, export --------------------------
        if method == "GET" and endpoint == "audit":
            entries = read_json(admin_dir() / "audit.json", [])
            if not isinstance(entries, list):
                entries = []
            rows = [e for e in entries if isinstance(e, dict)]
            who = one("admin").strip().lower()
            what = one("action").strip().lower()
            needle = one("q").strip().lower()
            if who:
                rows = [r for r in rows
                        if who in str(r.get("admin", "")).lower()]
            if what:
                rows = [r for r in rows
                        if what in str(r.get("action", "")).lower()]
            if needle:
                # Searches the whole entry, so an IP in a ban detail is findable
                # without knowing which field it landed in.
                rows = [r for r in rows if needle in " ".join(
                    str(r.get(k, "")) for k in ("at", "admin", "action", "detail")
                ).lower()]
            since_iso = one("since").strip()
            if since_iso:
                rows = [r for r in rows if str(r.get("at", "")) >= since_iso]
            rows.reverse()          # newest first
            # The distinct action list drives the UI's dropdown, computed from
            # the unfiltered log so filtering never hides the other options.
            actions = sorted({str(e.get("action", "")) for e in entries
                              if isinstance(e, dict) and e.get("action")})

            if one("format") == "csv":
                out = ["at,admin,action,detail"]
                for r in rows:
                    out.append(",".join(
                        '"' + str(r.get(k, "")).replace('"', '""') + '"'
                        for k in ("at", "admin", "action", "detail")))
                payload = "\n".join(out).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Disposition",
                                 'attachment; filename="audit.csv"')
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return

            limit = max(1, min(2000, int(one("limit", "200") or 200)))
            self.send_json(200, {
                "audit": rows[:limit],
                "matched": len(rows),
                "total": len(entries),
                "actions": actions,
            })
            return

        # ---- markup -------------------------------------------------------
        if method == "GET" and endpoint == "console":
            fragment = STATIC_DIR / "setup" / "ops.html"
            try:
                markup = fragment.read_text(encoding="utf-8")
            except OSError:
                self.send_json(500, {"error": "Ops console template missing"})
                return
            body = markup.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        # ---- live request feed --------------------------------------------
        if method == "GET" and endpoint == "requests":
            ops_flush()          # so the caller sees its own last request
            limit = max(1, min(1000, int(one("limit", "300") or 300)))
            since = int(one("since", "0") or 0)
            wheres, params = [], []
            if since:
                wheres.append("id > ?")
                params.append(since)
            band = one("status")
            if band:
                if band.endswith("xx"):
                    wheres.append("status >= ? AND status < ?")
                    params += [int(band[0]) * 100, (int(band[0]) + 1) * 100]
                else:
                    wheres.append("status = ?")
                    params.append(int(band))
            if one("method"):
                wheres.append("method = ?")
                params.append(one("method").upper()[:8])
            if one("ip"):
                wheres.append("ip = ?")
                params.append(one("ip")[:64])
            if one("kind"):
                wheres.append("kind = ?")
                params.append(one("kind")[:12])
            if one("hideNoise", "1") == "1":
                # The default view: scanners and non-tunnel probes are counted
                # in the stats but kept out of the stream.
                wheres.append("kind NOT IN ('honeypot','untunnel')")
            clause = (" WHERE " + " AND ".join(wheres)) if wheres else ""
            with OPS_DB_LOCK:
                rows = ops_db().execute(
                    "SELECT id,at,ip,method,path,status,ms,bytes,agent,priority,"
                    "tunnel,kind FROM requests" + clause +
                    " ORDER BY id DESC LIMIT ?", params + [limit]).fetchall()
            cols = ("id", "at", "ip", "method", "path", "status", "ms", "bytes",
                    "agent", "priority", "tunnel", "kind")
            items = [dict(zip(cols, row)) for row in rows]
            # Regex runs server-side so a filter applies to the whole retained
            # history, not only the rows already in the browser.
            pattern = one("q")
            if pattern:
                try:
                    matcher = re.compile(pattern, re.I)
                except re.error as error:
                    self.send_json(400, {"error": "Bad regex: " + str(error)})
                    return
                items = [i for i in items
                         if matcher.search(i["path"]) or matcher.search(i["ip"])
                         or matcher.search(i["agent"])]
            items.reverse()      # oldest first: the console appends downward
            self.send_json(200, {
                "requests": items,
                "cursor": max([i["id"] for i in items], default=since),
                "quiet": OPS_CONSOLE_QUIET[0],
            })
            return

        # ---- headline numbers ---------------------------------------------
        if method == "GET" and endpoint == "stats":
            window = max(60, min(86400, int(one("window", "3600") or 3600)))
            now = time.time()
            since = now - window
            with OPS_DB_LOCK:
                db = ops_db()
                buckets = db.execute(
                    "SELECT CAST((? - at) / 60 AS INT) AS minute, kind, status, "
                    "COUNT(*) FROM requests WHERE at >= ? "
                    "GROUP BY minute, kind, status", (now, since)).fetchall()
                top_ips = db.execute(
                    "SELECT ip, COUNT(*) c, SUM(kind='honeypot') hp FROM requests "
                    "WHERE at >= ? GROUP BY ip ORDER BY c DESC LIMIT 15",
                    (since,)).fetchall()
                top_paths = db.execute(
                    "SELECT path, COUNT(*) c, MAX(status) s FROM requests "
                    "WHERE at >= ? GROUP BY path ORDER BY c DESC LIMIT 15",
                    (since,)).fetchall()
                top_agents = db.execute(
                    "SELECT agent, COUNT(*) c FROM requests WHERE at >= ? "
                    "AND agent <> '' GROUP BY agent ORDER BY c DESC LIMIT 15",
                    (since,)).fetchall()
                totals = db.execute(
                    "SELECT COUNT(*), SUM(status >= 500), SUM(status = 404), "
                    "SUM(status = 403), SUM(kind='honeypot'), "
                    "SUM(kind='untunnel'), AVG(ms) FROM requests WHERE at >= ?",
                    (since,)).fetchone()
                retained = db.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
            minutes = max(1, window // 60)
            series = {"all": [0] * minutes, "s404": [0] * minutes,
                      "s403": [0] * minutes, "honeypot": [0] * minutes}
            for minute, kind, status, count in buckets:
                if minute is None or not (0 <= minute < minutes):
                    continue
                slot = minutes - 1 - int(minute)      # oldest first
                series["all"][slot] += count
                if status == 404:
                    series["s404"][slot] += count
                if status == 403:
                    series["s403"][slot] += count
                if kind == "honeypot":
                    series["honeypot"][slot] += count
            active = [r for r in ban_list() if r["active"]]
            self.send_json(200, {
                "window": window,
                "series": series,
                "totals": {
                    "requests": totals[0] or 0, "errors": totals[1] or 0,
                    "notFound": totals[2] or 0, "forbidden": totals[3] or 0,
                    "honeypot": totals[4] or 0, "untunnelled": totals[5] or 0,
                    "avgMs": round(totals[6] or 0, 1), "retained": retained,
                    "dropped": OPS_DROPPED[0],
                },
                "topIps": [{"ip": i, "count": c, "honeypot": h or 0}
                           for i, c, h in top_ips],
                "topPaths": [{"path": p, "count": c, "status": s}
                             for p, c, s in top_paths],
                "topAgents": [{"agent": a, "count": c} for a, c in top_agents],
                "tunnel": {
                    "host": HOST,
                    "boundToLoopback": HOST in ("127.0.0.1", "::1", "localhost"),
                    "untunnelled": totals[5] or 0,
                },
                "bans": {
                    "enforcing": get_setting("honeypotBansEnabled") == 1,
                    "active": len(active),
                    "tracked": len(ban_list()),
                },
            })
            return

        # ---- bans ----------------------------------------------------------
        if method == "GET" and endpoint == "bans":
            self.send_json(200, {
                "bans": ban_list(),
                "history": list(reversed(BAN_HISTORY))[:200],
                "neverBan": sorted(BAN_NEVER),
                "enforcing": get_setting("honeypotBansEnabled") == 1,
                "firstMinutes": get_setting("banFirstMinutes"),
                "maxMinutes": get_setting("banMaxMinutes"),
            })
            return

        if method == "POST" and endpoint == "bans":
            body = self.read_json_body()
            if not isinstance(body, dict):
                self.send_json(400, {"error": "Expected a JSON object"})
                return
            action = str(body.get("action", "")).strip()
            target = str(body.get("ip", "")).strip()
            if action == "ban":
                minutes = int(body.get("minutes") or get_setting("banFirstMinutes"))
                reason = str(body.get("reason", "manual"))
                if not ban_add_manual(target, minutes, reason):
                    self.send_json(400, {
                        "error": "Refused: not a valid non-loopback address, or "
                                 "on the never-ban list"})
                    return
                append_audit(admin, "ops-ban",
                             target + " for " + str(minutes) + "m (" + reason + ")")
                self.send_json(200, {"banned": target, "minutes": minutes})
                return
            if action == "unban":
                ban_clear(target)
                append_audit(admin, "ops-unban", target)
                self.send_json(200, {"unbanned": target})
                return
            if action == "never-ban":
                if not ops_never_ban_add(target, str(body.get("note", ""))):
                    self.send_json(400, {"error": "Not a valid address"})
                    return
                append_audit(admin, "ops-never-ban", target)
                self.send_json(200, {"neverBan": sorted(BAN_NEVER)})
                return
            if action == "allow-bans":
                if not ops_never_ban_remove(target):
                    self.send_json(400, {
                        "error": "Loopback cannot be removed: cloudflared "
                                 "connects over it, so allowing it to be banned "
                                 "would take the site offline"})
                    return
                append_audit(admin, "ops-allow-bans", target)
                self.send_json(200, {"neverBan": sorted(BAN_NEVER)})
                return
            self.send_json(400, {"error": "Unknown action: " + action})
            return

        # ---- honeypot patterns + live tester -------------------------------
        if method == "GET" and endpoint == "honeypots":
            self.send_json(200, {
                "prefixes": list(HONEYPOT_PREFIXES),
                "exact": list(HONEYPOT_EXACT),
                "custom": sorted(HONEYPOT_CUSTOM),
            })
            return

        if method == "POST" and endpoint == "honeypot-test":
            body = self.read_json_body()
            paths = body.get("paths") if isinstance(body, dict) else None
            if not isinstance(paths, list):
                self.send_json(400, {"error": "Expected {paths: [...]}"})
                return
            self.send_json(200, {"results": [
                {"path": str(p)[:200], "match": is_honeypot_path(str(p))}
                for p in paths[:50]]})
            return

        # ---- journal verbosity ---------------------------------------------
        if method == "POST" and endpoint == "quiet":
            body = self.read_json_body()
            OPS_CONSOLE_QUIET[0] = (bool(body.get("quiet", True))
                                    if isinstance(body, dict) else True)
            self.send_json(200, {"quiet": OPS_CONSOLE_QUIET[0]})
            return

        self.send_json(404, {"error": "Unknown ops endpoint: " + endpoint})

    def route_admin(self, method: str, path: str) -> None:
        endpoint = path[len("/api/admin/"):].strip("/")

        # Public reads (the viewer needs these to apply hiding).
        if method == "GET" and endpoint == "hidden-players":
            players = load_hidden_players()
            if not self.requester_is_admin():
                # Normal clients only need the names to apply hiding; the
                # reason and moderator identity stay admin-only.
                players = [{"name": entry.get("name", "")} for entry in players if isinstance(entry, dict)]
            self.send_json(200, {
                "players": players,
                "hiddenTileStyle": HIDDEN_TILE_STYLE,
                "maxApiPerMinute": get_max_api_per_minute(),
                "maxApiPerMinutePerUser": get_max_api_per_minute_per_user(),
                # Client pacing pushed to browsers; 0 means "client decides".
                "clientZonePace": get_setting("clientZonePace"),
                "clientZoneConcurrency": get_setting("clientZoneConcurrency"),
            })
            return
        if method == "GET" and endpoint == "announcement":
            payload = read_json(admin_dir() / "announcement.json", {})
            self.send_json(200, payload if isinstance(payload, dict) else {})
            return
        if method == "GET" and endpoint == "me":
            username, current = self.requester_identity()
            is_admin = username.lower() in admin_name_set_lower()
            # Return the current valid token: verifying rotated it on the game
            # server, so the viewer must adopt this token or its own map/getarea
            # requests will fail with "Could not authenticate".
            self.send_json(200, {"admin": is_admin, "user": username, "token": current})
            return

        if not self.requester_is_admin():
            self.send_json(403, {"error": "Admin access required"})
            return

        if method == "GET" and endpoint == "settings":
            self.send_json(200, {
                "values": {field: get_setting(field) for field in SETTINGS_FIELD_RULES},
                "rules": {field: {"default": rule[0], "min": rule[1], "max": rule[2]}
                          for field, rule in SETTINGS_FIELD_RULES.items()},
                # Whether the admin bypass is on, and whether it is actually
                # applying to this caller right now - identity comes from the
                # token cache only, so those can disagree.
                "bypassEnabled": bool(get_setting("adminBypassLimits")),
                "bypassActive": self.requester_bypasses_limits(),
                # Back-compat for anything still reading the old shape.
                "maxApiPerMinute": get_max_api_per_minute(),
                "maxApiPerMinutePerUser": get_max_api_per_minute_per_user(),
                "stats": metrics_summary(),
            })
            return

        if method == "GET" and endpoint == "usage":
            # Aggregated history over a UTC day range. Defaults to the last 7
            # days including today, which is what the console opens on.
            query = urllib.parse.parse_qs(
                self.path.split("?", 1)[1] if "?" in self.path else "")
            today = _utc_day()
            default_from = _utc_day(time.time() - 6 * 86400)
            day_from = str(query.get("from", [default_from])[0])[:10] or default_from
            day_to = str(query.get("to", [today])[0])[:10] or today
            if day_from > day_to:
                day_from, day_to = day_to, day_from
            report = usage_report(day_from, day_to)
            if str(query.get("format", [""])[0]).lower() == "csv":
                body = usage_report_csv(report).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Disposition",
                                 f'attachment; filename="bym-usage-{day_from}_to_{day_to}.csv"')
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_json(200, {"report": report})
            return

        if method == "GET" and endpoint == "api-stats":
            # Lightweight poll target for the console's live stats panel.
            # bypassActive is deliberately the *live* answer rather than just
            # the setting: identity is resolved from the token cache only, so
            # an admin whose token has aged out is limited normally until
            # their next verified call warms it. Reporting the setting alone
            # would tell them "on" while they were being queued.
            self.send_json(200, {
                "stats": metrics_summary(),
                "bypassEnabled": bool(get_setting("adminBypassLimits")),
                "bypassActive": self.requester_bypasses_limits(),
                # The queue runs on limit minus the sign-in reserve, so the
                # number the admin typed is not the number map traffic gets.
                "queueLimit": max(1, get_max_api_per_minute()
                                  - auth_reserve(get_max_api_per_minute())),
                "authReserve": auth_reserve(get_max_api_per_minute()),
            })
            return

        if method == "POST" and endpoint == "settings":
            body = self.read_json_body()
            if body is None:
                return
            updates = {}
            for field, (default, low, high) in SETTINGS_FIELD_RULES.items():
                if field not in body:
                    continue
                try:
                    value = int(body.get(field))
                except (TypeError, ValueError):
                    self.send_json(400, {"error": f"{field} must be an integer"})
                    return
                if not low <= value <= high:
                    self.send_json(400, {"error": f"{field} must be between {low} and {high}"})
                    return
                updates[field] = value
            if not updates:
                self.send_json(400, {"error": "No settings provided"})
                return
            settings = read_json(admin_dir() / "settings.json", {})
            if not isinstance(settings, dict):
                settings = {}
            settings.update(updates)
            with STORAGE_LOCK:
                atomic_write_json(admin_dir() / "settings.json", settings)
            invalidate_settings_cache()
            append_audit(self.requester_user() or "?", "settings",
                         ", ".join(f"{k}={v}" for k, v in updates.items()))
            with BYM_CALL_LOCK:
                BYM_CALL_LOCK.notify_all()
            self.send_json(200, {
                "values": {field: get_setting(field) for field in SETTINGS_FIELD_RULES},
            })
            return

        if method == "GET" and endpoint == "whitelist":
            self.send_json(200, load_whitelist())
            return

        if method == "POST" and endpoint == "whitelist":
            body = self.read_json_body()
            if body is None:
                return
            state = load_whitelist()
            names = list(state["names"])
            enabled = state["enabled"]
            detail = []
            if "enabled" in body:
                enabled = bool(body.get("enabled"))
                detail.append("enabled" if enabled else "disabled")
            action = str(body.get("action", "")).strip().lower()
            name = str(body.get("name", "")).strip()[:80]
            if action:
                if action not in ("add", "remove") or not name:
                    self.send_json(400, {"error": "Body must be {action: add|remove, name} and/or {enabled: bool}"})
                    return
                # Names are compared, never used as paths, so keep them
                # verbatim - sanitizing would mangle usernames containing
                # characters the game allows and they would never match.
                names = [n for n in names if n.lower() != name.lower()]
                if action == "add":
                    names.append(name)
                detail.append(f"{action} {name}")
            if not detail:
                self.send_json(400, {"error": "No changes provided"})
                return
            payload = {"enabled": enabled, "names": sorted(set(names), key=str.lower)}
            with STORAGE_LOCK:
                atomic_write_json(admin_dir() / "whitelist.json", payload)
            append_audit(self.requester_user() or "?", "whitelist", ", ".join(detail))
            self.send_json(200, payload)
            return

        if method == "GET" and endpoint == "hide-requests":
            data = read_json(admin_dir() / "hide-requests.json", [])
            entries = [r for r in data if isinstance(r, dict)]
            self.send_json(200, {"requests": list(reversed(entries))[:100]})
            return

        if method == "POST" and endpoint == "hide-requests":
            body = self.read_json_body()
            if body is None:
                return
            target = str(body.get("name", "")).strip()
            action = str(body.get("action", "")).strip()
            if action not in ("approve", "deny"):
                self.send_json(400, {"error": "action must be approve or deny"})
                return
            requests_path = admin_dir() / "hide-requests.json"
            admin_user = self.requester_user() or "?"
            with STORAGE_LOCK:
                data = read_json(requests_path, [])
                entry = next((r for r in data if isinstance(r, dict)
                              and str(r.get("name", "")).lower() == target.lower()
                              and r.get("status") == "pending"), None)
                if entry is None:
                    self.send_json(404, {"error": f"No pending request from {target}"})
                    return
                entry["status"] = "approved" if action == "approve" else "denied"
                entry["resolvedBy"] = admin_user
                entry["resolvedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                atomic_write_json(requests_path, data)
            if action == "approve":
                with STORAGE_LOCK:
                    players = load_hidden_players()
                    low = target.lower()
                    if not any(str(e.get("name", "")).strip().lower() == low
                               for e in players if isinstance(e, dict)):
                        players.append({
                            "name": entry.get("name", target),
                            "reason": f"Requested by player: {entry.get('reason', '')}"[:300],
                            "hiddenBy": admin_user,
                            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        })
                        atomic_write_json(admin_dir() / "hidden_players.json", {"players": players})
            append_audit(admin_user, f"hide-request-{action}", target)
            self.send_json(200, {"name": target, "status": entry["status"]})
            return

        if method == "GET" and endpoint == "alliances":
            payload = []
            for _, data in load_alliances():
                payload.append({
                    "name": data.get("name", ""),
                    "leader": data.get("leader", ""),
                    "members": [
                        {"name": str(m), "rank": member_rank(data, str(m))}
                        for m in data.get("members", [])
                    ],
                    "invites": [str(i) for i in data.get("invites", [])],
                    "enemies": len(data.get("enemies", [])) + len(data.get("enemyAlliances", [])),
                    "targets": len(data.get("targets", [])),
                    "chat": len(data.get("chat", [])),
                    "feed": len(data.get("feed", [])),
                    "createdAt": data.get("createdAt", ""),
                })
            self.send_json(200, {"alliances": payload})
            return

        if method == "POST" and endpoint == "alliance-delete":
            body = self.read_json_body()
            if body is None:
                return
            target = str(body.get("name", "")).strip()
            for file_path, data in load_alliances():
                if str(data.get("name", "")).strip().lower() == target.lower():
                    file_path.unlink(missing_ok=True)
                    append_audit(self.requester_user() or "?", "alliance-delete", target)
                    self.send_json(200, {"deleted": target})
                    return
            self.send_json(404, {"error": f"No alliance named {target}"})
            return

        if method == "POST" and endpoint == "alliance-set-leader":
            body = self.read_json_body()
            if body is None:
                return
            target = str(body.get("name", "")).strip()
            new_leader = str(body.get("leader", "")).strip()
            for file_path, data in load_alliances():
                if str(data.get("name", "")).strip().lower() != target.lower():
                    continue
                low = new_leader.lower()
                match = next(
                    (str(m) for m in data.get("members", []) if str(m).strip().lower() == low),
                    None,
                )
                if not match:
                    self.send_json(400, {"error": f"{new_leader} is not a member of {target}"})
                    return
                old_leader = str(data.get("leader", ""))
                data["leader"] = match
                ranks = data.setdefault("ranks", {})
                ranks.pop(low, None)
                if old_leader and old_leader.strip().lower() != low:
                    ranks[old_leader.strip().lower()] = "officer"
                atomic_write_json(file_path, data)
                append_audit(self.requester_user() or "?", "alliance-set-leader",
                             f"{target}: {old_leader} -> {match}")
                self.send_json(200, {"alliance": target, "leader": match})
                return
            self.send_json(404, {"error": f"No alliance named {target}"})
            return

        admin = self.requester_user()

        # ------------------------------------------------------------------
        # Operator console (/setup/ops)
        # ------------------------------------------------------------------
        if endpoint.startswith("ops"):
            self.route_ops(method, endpoint[3:].strip("/"), admin)
            return

        if method == "GET" and endpoint == "console":
            # The admin console markup lives in a separate file that is only
            # ever sent to a verified administrator, so the sensitive UI is
            # never present in the page a normal visitor receives.
            fragment = STATIC_DIR / "setup" / "console.html"
            try:
                markup = fragment.read_text(encoding="utf-8")
            except OSError:
                self.send_json(500, {"error": "Console template missing"})
                return
            body = markup.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if method == "GET" and endpoint == "admins":
            self.send_json(200, {
                "admins": sorted(load_admin_users(), key=str.lower),
                "you": admin,
            })
            return

        # ------------------------------------------------------------------
        # Username changes. GET lists every rename the identity index has
        # recorded; POST applies one BY HAND for renames that predate the
        # index (the viewer never saw the old name paired with a userid, so
        # automatic detection has nothing to compare against). Manual moves
        # are admin-only on purpose: letting a player "claim" an arbitrary
        # old name would hand them that name's settings, alliance seat and
        # any allowlist entries.
        # ------------------------------------------------------------------
        if method == "GET" and endpoint == "renames":
            entries = []
            for uid, entry in load_users_index().items():
                if not isinstance(entry, dict):
                    continue
                previous = [str(p) for p in entry.get("previous", []) if str(p).strip()]
                if not previous:
                    continue
                entries.append({
                    "userid": uid,
                    "name": str(entry.get("name", "")),
                    "previous": previous,
                    "updatedAt": str(entry.get("updatedAt", "")),
                })
            entries.sort(key=lambda e: e.get("updatedAt", ""), reverse=True)
            self.send_json(200, {"renames": entries})
            return

        if method == "POST" and endpoint == "rename-user":
            body = self.read_json_body()
            if body is None:
                return
            old = str(body.get("from", "")).strip()
            new = str(body.get("to", "")).strip()
            if (not old or not new or len(old) > 80 or len(new) > 80
                    or not sanitize_name(old) or not sanitize_name(new)):
                self.send_json(400, {"error": "Body must be {from, to} with valid player names"})
                return
            if old.lower() == new.lower() and old == new:
                self.send_json(400, {"error": "Those are the same name"})
                return
            with STORAGE_LOCK:
                summary = migrate_username_locked(old, new)
                # Keep the identity index consistent with the manual move so
                # resolve_current_name() (profile fallback, mid-session
                # settings access) knows about this rename too. Only an entry
                # that currently carries the OLD name is touched - if the
                # index already tracks the new name the game told us so and
                # there is nothing to patch.
                index = load_users_index()
                patched = False
                for entry in index.values():
                    if isinstance(entry, dict) and str(entry.get("name", "")).strip().lower() == old.lower():
                        previous = [str(p) for p in entry.get("previous", []) if str(p).strip()]
                        if old.lower() != new.lower():
                            previous = [p for p in previous
                                        if p.strip().lower() != old.lower()] + [old]
                        entry.update({
                            "name": new,
                            "previous": previous[-10:],
                            "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        })
                        patched = True
                if patched:
                    atomic_write_json(users_index_path(), index)
            rename_token_cache(old, new)
            with PLAYER_INDEX_LOCK:
                PLAYER_INDEX.clear()
            append_audit(admin, "rename-user", f"{old} -> {new} ({summary})")
            self.send_json(200, {"summary": summary})
            return

        if method == "POST" and endpoint == "admins":
            body = self.read_json_body()
            if body is None:
                return
            action = str(body.get("action", "")).strip().lower()
            name = str(body.get("name", "")).strip()
            if not name or len(name) > 80 or action not in ("add", "remove"):
                self.send_json(400, {"error": "Body must be {action: add|remove, name}"})
                return
            with STORAGE_LOCK:
                path = admin_dir() / "admins.json"
                payload = read_json(path, None)
                names = payload.get("admins") if isinstance(payload, dict) else None
                if not isinstance(names, list):
                    names = sorted(SEED_ADMIN_USERS)
                current = {str(n).strip() for n in names if str(n).strip()}
                lowered = {n.lower() for n in current}
                if action == "add":
                    if name.lower() not in lowered:
                        current.add(name)
                else:  # remove
                    if name.lower() in lowered:
                        remaining = {n for n in current if n.lower() != name.lower()}
                        if not remaining:
                            self.send_json(400, {"error": "Cannot remove the last administrator"})
                            return
                        current = remaining
                ordered = sorted(current, key=str.lower)
                atomic_write_json(path, {"admins": ordered})
            append_audit(admin, f"admins:{action}", name)
            self.send_json(200, {"admins": ordered, "you": admin})
            return

        if method == "POST" and endpoint == "hidden-players":
            body = self.read_json_body()
            if body is None:
                return
            action = str(body.get("action", "")).strip().lower()
            name = str(body.get("name", "")).strip()
            reason = str(body.get("reason", "")).strip()[:200]
            if not name or action not in ("add", "remove"):
                self.send_json(400, {"error": "Body must be {action: add|remove, name, reason?}"})
                return
            with STORAGE_LOCK:
                players = [
                    entry for entry in load_hidden_players()
                    if isinstance(entry, dict) and str(entry.get("name", "")).strip().lower() != name.lower()
                ]
                if action == "add":
                    players.append({
                        "name": name,
                        "reason": reason,
                        "hiddenBy": admin,
                        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    })
                atomic_write_json(admin_dir() / "hidden_players.json", {"players": players})
            append_audit(admin, f"hidden-players:{action}", f"{name}{f' ({reason})' if reason else ''}")
            self.send_json(200, {"players": players})
            return

        if method == "POST" and endpoint == "announcement":
            body = self.read_json_body()
            if body is None:
                return
            text = str(body.get("text", "")).strip()[:500]
            payload = {
                "text": text,
                "updatedBy": admin,
                "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            with STORAGE_LOCK:
                atomic_write_json(admin_dir() / "announcement.json", payload)
            append_audit(admin, "announcement", text[:80] if text else "(cleared)")
            self.send_json(200, payload)
            return

        if method == "GET" and endpoint == "overview":
            worlds = []
            for entry in sorted(STORAGE_ROOT.glob("server_*")):
                zones_dir = entry / "zones"
                if not zones_dir.is_dir():
                    continue
                files = list(zones_dir.glob("zone_*.json"))
                newest = max((f.stat().st_mtime for f in files), default=0)
                worlds.append({
                    "name": entry.name[len("server_"):],
                    "zones": len(files),
                    "bytes": sum(f.stat().st_size for f in files),
                    "newest": int(newest),
                })
            users = []
            users_root = STORAGE_ROOT / "users"
            if users_root.is_dir():
                for entry in sorted(users_root.iterdir()):
                    if not entry.is_dir():
                        continue
                    logins = read_json(entry / "logins.json", [])
                    if not isinstance(logins, list):
                        logins = []
                    users.append({
                        "name": entry.name,
                        "logins": len(logins),
                        "lastLogin": (logins[-1].get("at") if logins and isinstance(logins[-1], dict) else None),
                    })
            audit = read_json(admin_dir() / "audit.json", [])
            self.send_json(200, {
                "worlds": worlds,
                "users": users,
                "audit": (audit if isinstance(audit, list) else [])[-50:],
            })
            return

        if method == "POST" and endpoint == "purge":
            body = self.read_json_body()
            if body is None:
                return
            world = sanitize_name(str(body.get("world", "")))
            if not world:
                self.send_json(400, {"error": "Body must include a valid world name"})
                return
            older_than_hours = body.get("olderThanHours")
            cutoff = None
            if older_than_hours is not None:
                try:
                    cutoff = time.time() - float(older_than_hours) * 3600
                except (TypeError, ValueError):
                    self.send_json(400, {"error": "olderThanHours must be a number"})
                    return
            zones_dir = server_map_dir(world)
            removed = 0
            with STORAGE_LOCK:
                for f in zones_dir.glob("zone_*.json"):
                    if cutoff is None or f.stat().st_mtime < cutoff:
                        f.unlink(missing_ok=True)
                        removed += 1
            append_audit(admin, "purge", f"{world} removed {removed} zones"
                         + (f" older than {older_than_hours}h" if cutoff is not None else " (all)"))
            self.send_json(200, {"removed": removed})
            return

        self.send_json(404, {"error": "Unknown admin endpoint"})

    def read_json_body(self) -> object | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            self.send_json(400, {"error": "Missing or oversized request body"})
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self.send_json(400, {"error": "Body is not valid JSON"})
            return None

    def send_json(self, status: int, payload: object, extra_headers: dict | None = None) -> None:
        try:
            self.send_json_raw(status, payload, extra_headers)
        except ConnectionError:
            # The client (browser) closed the connection mid-response -
            # typically a page refresh cancelling an in-flight fetch. There
            # is nobody left to answer, so this is a quiet non-event.
            print(f"[net] client disconnected during {self.command} {self.path}")

    def send_json_raw(self, status: int, payload: object, extra_headers: dict | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        # Gzip large responses (the shared map cache is highly repetitive
        # JSON, ~90% compressible) when the client accepts it.
        accepts_gzip = "gzip" in str(self.headers.get("Accept-Encoding", "")).lower()
        encoded = None
        if accepts_gzip and len(body) > 1024:
            encoded = gzip.compress(body, compresslevel=6)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        for name, value in (extra_headers or {}).items():
            self.send_header(name, str(value))
        if encoded is not None and len(encoded) < len(body):
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            return
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def cleanup_cache() -> None:
    """One-shot maintenance pass over every cached zone file: strips the
    monster blob, the leaked per-session "mine" flag, unread "bid" strings,
    and zero/empty default fields from every cell, and clamps any
    future-dated fetchedAt to the server clock. Lossless for the viewer -
    the client re-derives every dropped default on restore."""
    now_ms = int(time.time() * 1000)
    total_before = total_after = total_files = total_changed = 0
    bad_files = 0

    for server_dir in sorted(STORAGE_ROOT.glob("server_*")):
        zones_dir = server_dir / "zones"
        if not zones_dir.is_dir():
            continue
        world_before = world_after = world_changed = 0
        files = sorted(zones_dir.glob("zone_*.json"))
        for path in files:
            before = path.stat().st_size
            payload = read_json(path, None)
            if not isinstance(payload, dict):
                bad_files += 1
                continue

            cells = payload.get("cells")
            new_cells = [
                minify_cell(cell) for cell in cells
                if isinstance(cell, dict)
            ] if isinstance(cells, list) else []
            try:
                fetched_at = min(int(payload.get("fetchedAt", 0)), now_ms)
            except (TypeError, ValueError):
                fetched_at = 0
            new_payload = {"fetchedAt": fetched_at, "cells": new_cells}

            if new_payload != payload:
                atomic_write_json(path, new_payload)
                world_changed += 1
            after = path.stat().st_size
            world_before += before
            world_after += after

        total_before += world_before
        total_after += world_after
        total_files += len(files)
        total_changed += world_changed
        if files:
            saved_pct = (100 - world_after * 100 // world_before) if world_before else 0
            print(f"  {server_dir.name[len('server_'):]}: {len(files)} zones, "
                  f"{world_changed} rewritten, {world_before:,} -> {world_after:,} bytes ({saved_pct}% smaller)")

    if not total_files:
        print("No cached zone files found under", STORAGE_ROOT)
        return
    saved_pct = (100 - total_after * 100 // total_before) if total_before else 0
    print(f"Cleanup complete: {total_files} zone files ({total_changed} rewritten"
          + (f", {bad_files} unreadable skipped" if bad_files else "")
          + f"), {total_before:,} -> {total_after:,} bytes ({saved_pct}% smaller).")


def backup_storage() -> None:
    """Zips everything precious under the storage root - alliances, per-user
    settings, admin config - into backups/. Zone caches (server_*) and the
    API log are excluded: both are bulky and reproducible."""
    import zipfile

    backups_dir = STORAGE_ROOT / "backups"
    backups_dir.mkdir(parents=True, exist_ok=True)
    out_path = backups_dir / f"bym-viewer-backup-{time.strftime('%Y%m%d-%H%M%S')}.zip"

    files = 0
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(STORAGE_ROOT.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(STORAGE_ROOT)
            parts = rel.parts
            if parts[0] == "backups" or parts[0].startswith("server_"):
                continue
            if parts[0] == "logs":
                continue
            archive.write(path, str(rel))
            files += 1
    size = out_path.stat().st_size
    print(f"Backup complete: {files} files, {size:,} bytes -> {out_path}")


def restore_storage() -> None:
    """Restores a --backup archive into the storage root. A file on disk that
    is NEWER than the archived copy is never overwritten (it would clobber
    changes made since the backup); everything else is restored."""
    import zipfile

    args = sys.argv
    explicit = None
    if "--restore" in args:
        idx = args.index("--restore")
        if idx + 1 < len(args) and not args[idx + 1].startswith("-"):
            explicit = Path(args[idx + 1])
    if explicit is None:
        candidates = sorted((STORAGE_ROOT / "backups").glob("*.zip"))
        if not candidates:
            print(f"No backup archives found under {STORAGE_ROOT / 'backups'}")
            return
        explicit = candidates[-1]
    if not explicit.is_file():
        print(f"Backup archive not found: {explicit}")
        return

    print(f"Restoring {explicit} into {STORAGE_ROOT} ...")
    restored = skipped = 0
    with zipfile.ZipFile(explicit) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            # Zip-slip guard: an archive entry may carry an absolute path or
            # "../" segments (or route through a symlinked directory) that
            # would land the write outside the storage root. Resolve the
            # destination and require it to stay inside STORAGE_ROOT (which
            # is itself resolved at startup).
            dest = (STORAGE_ROOT / info.filename).resolve()
            if not dest.is_relative_to(STORAGE_ROOT):
                print(f"  skipping unsafe archive path: {info.filename!r}")
                skipped += 1
                continue
            archived_mtime = time.mktime(info.date_time + (0, 0, -1))
            if dest.exists() and dest.stat().st_mtime > archived_mtime + 1:
                skipped += 1
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as src, open(dest, "wb") as out:
                out.write(src.read())
            restored += 1
    print(f"Restore complete: {restored} file(s) restored, {skipped} newer file(s) left untouched.")


def main() -> None:
    if "--restore" in sys.argv:
        restore_storage()
        return
    if "--backup" in sys.argv:
        print(f"Backing up storage under {STORAGE_ROOT} ...")
        backup_storage()
        return
    if "--cleanup" in sys.argv:
        print(f"Cleaning cached zone files under {STORAGE_ROOT} ...")
        cleanup_cache()
        prune_old_logs(force=True)
        return

    if not STATIC_DIR.exists():
        raise SystemExit(f"Static directory does not exist: {STATIC_DIR}")

    # Loads today's rollup back into memory and starts the background writer,
    # so counters continue across a restart instead of resetting to zero.
    start_metrics_writer()
    start_history_writer()

    handler = partial(StaticViewerHandler, directory=str(STATIC_DIR))
    start_ops_writer()
    server = ThreadingHTTPServer((HOST, PORT), handler)
    print(f"Serving BYM MR2 Viewer at http://{HOST}:{PORT} (dev_server {SERVER_VERSION})")
    print(f"Hidden-player tile style: {HIDDEN_TILE_STYLE} (BYM_HIDDEN_TILE_STYLE=tribe|water)")
    _version = bym_api_version()
    print(f"Game API version: {_version}"
          + (" (pinned via BYM_API_VERSION)" if BYM_API_VERSION_PIN
             else f" (from {BYM_VERSION_MANIFEST})"))
    _admins = sorted(load_admin_users(), key=str.lower)
    if _admins:
        print(f"Admin console: http://localhost:{PORT}/setup/ (admins: {', '.join(_admins)})")
    else:
        print(f"Admin console: http://localhost:{PORT}/setup/ (NO ADMINS configured - "
              f"set BYM_ADMIN_USERS or edit {admin_dir() / 'admins.json'} to grant access)")
    print(f"Static root: {STATIC_DIR}")
    print(f"Storage root: {STORAGE_ROOT} (server_{{name}}\\zones, users\\{{username}})")
    print(f"Serving .js as: {MIME_TYPES['.js']}")
    print(f"Usage history: {metrics_dir()} "
          f"(hourly, {get_setting('metricsRetentionDays')} day retention)")
    if not API_LOG_ENABLED_CATEGORIES:
        print("API-call log: OFF (BYM_API_LOG)")
    else:
        scope = ("all" if API_LOG_ENABLED_CATEGORIES == set(API_LOG_CATEGORIES)
                 else ", ".join(sorted(API_LOG_ENABLED_CATEGORIES)))
        suffix = ", errors only" if API_LOG_ERRORS_ONLY else ""
        cap = f"{API_LOG_MAX_BODY} chars/body" if API_LOG_MAX_BODY > 0 else "uncapped bodies"
        print(f"API-call log: {STORAGE_ROOT / 'logs'}/api-calls-<date>.log ({scope}{suffix}, {cap}; "
              f"configure via BYM_API_LOG / BYM_API_LOG_MAX_BODY)")
    try:
        server.serve_forever()
    finally:
        # Ctrl+C should not cost the last flush interval of history.
        metrics_flush(force=True)


if __name__ == "__main__":
    main()
