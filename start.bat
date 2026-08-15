@echo off
setlocal
REM ===========================================================================
REM  BYM MR2 Viewer - Windows launcher
REM
REM  Everything below is an environment variable read by dev_server.py. Only
REM  the ACTIVE block is set; the rest are listed with their defaults so the
REM  full set is visible without reading the server source. Uncomment a REM
REM  line to change one.
REM
REM  Anything already set in the environment wins - see the "if not defined"
REM  lines - so a machine-wide setting is never silently overridden here.
REM ===========================================================================

REM --- Active settings -------------------------------------------------------

REM API-call log. Value is a comma/space list of:
REM   all | off | auth | map | base | meta | other | errors
REM "errors" logs only failed calls and is the usual repro setting.
REM Session tokens and the account email are redacted from the log; see
REM BYM_API_LOG_TOKENS below if a reproduction genuinely needs the real token.
if not defined BYM_API_LOG set BYM_API_LOG=errors

REM Max characters of request/response body kept per entry (0 = no cap).
REM Zone payloads are large; 200000 keeps them intact for replay.
if not defined BYM_API_LOG_MAX_BODY set BYM_API_LOG_MAX_BODY=200000

REM How moderation-hidden players' cells are disguised: tribe | water
REM   tribe - replaced with the wild monster cell that coordinate generates
REM   water - rendered as a water hex
REM ("blend" is the old name for "tribe" and is still accepted.)
if not defined BYM_HIDDEN_TILE_STYLE set BYM_HIDDEN_TILE_STYLE=tribe

REM Where storage/ lives (zones, users, admin, metrics, logs).
if not defined STORAGE_DIR set STORAGE_DIR=%~dp0storage
if not defined HOST set HOST=127.0.0.1
if not defined PORT set PORT=8080

REM --- Optional overrides (defaults shown) -----------------------------------

REM Keep session tokens in the API log instead of redacting them. The game
REM token IS the credential - anyone holding it can act as the account until
REM it expires - so this is off by default and should be turned on only for a
REM specific debugging session, then turned back off.
REM set BYM_API_LOG_TOKENS=1

REM Game API version. Left unset, the server reads currentGameVersion from the
REM CDN manifest exactly as the official launcher does, because the version is
REM embedded in the API path and changes with each release. Set this ONLY to
REM pin a specific version for testing.
REM set BYM_API_VERSION=v1.6.9-beta
REM set BYM_VERSION_MANIFEST=cdn.bymrefitted.com/versionManifest.json

REM Upstream game server and asset CDN.
REM set BYM_BASE_URL=https://server.bymrefitted.com
REM set BYM_ASSETS_BASE_URL=

REM Comma-separated game usernames with admin rights in the viewer console.
REM set BYM_ADMIN_USERS=

REM Shared game-API budget. These protect the game server; raising them
REM raises this viewer's share of a limited resource.
REM set BYM_MAX_API_PER_MINUTE=180
REM set BYM_MAX_API_PER_MINUTE_PER_USER=30
REM set BYM_MAX_LOW_PER_MINUTE_PER_USER=10
REM set BYM_MAX_MEDIUM_PER_MINUTE_PER_USER=10
REM set BYM_MAX_QUEUE_DEPTH=1000
REM set BYM_MAX_QUEUE_DEPTH_PER_USER=100
REM set BYM_MAX_WAIT_SECONDS=8
REM set BYM_FULL_MAP_CONCURRENCY=8
REM set BYM_MAX_MAP_SIZE=800

REM Identity sent to the BYM servers, and the message shown to a player who is
REM refused by the sign-in whitelist.
REM set BYM_USER_AGENT=BYM-MR2-Viewer/1.0 (community map viewer; Mozilla/5.0 compatible)
REM set BYM_WHITELIST_MESSAGE=Whitelist is enabled.

REM Static file root. Only needed if app\static has been moved.
REM set STATIC_DIR=%~dp0app\static

REM --- Launch ----------------------------------------------------------------

REM Prefer the py launcher, which is what a standard python.org install
REM provides; fall back to python on PATH. Checked once, up front, so a
REM missing interpreter reports itself instead of being swallowed by the
REM restart loop below.
set PY=
where py >nul 2>&1 && set "PY=py -3"
if not defined PY (
  where python >nul 2>&1 && set "PY=python"
)
if not defined PY (
  echo.
  echo Python 3 was not found on PATH.
  echo Install it from https://www.python.org/downloads/ and tick
  echo "Add python.exe to PATH" during setup, then run this again.
  echo.
  pause
  exit /b 1
)

echo Starting BYM MR2 Viewer on http://%HOST%:%PORT%/
echo Storage: %STORAGE_DIR%
echo API log: %BYM_API_LOG%   Hidden tiles: %BYM_HIDDEN_TILE_STYLE%
echo Press Ctrl+C twice to stop.
echo.

:restart
%PY% "%~dp0dev_server.py"
REM Without the pause, an immediate failure - port in use, syntax error,
REM missing dependency - spins as fast as Python can start and exit.
echo Server exited; restarting in 1 second. Press Ctrl+C to stop.
timeout /t 1 /nobreak >nul
goto restart
