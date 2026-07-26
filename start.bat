@echo off
set BYM_API_LOG=errors
set BYM_API_LOG_MAX_BODY=200000
set BYM_HIDDEN_TILE_STYLE=blend

REM Only set if the environment has not already chosen one, so a second
REM machine does not silently fall back to a different storage root.
if not defined STORAGE_DIR set STORAGE_DIR=%~dp0storage
if not defined HOST set HOST=127.0.0.1
if not defined PORT set PORT=8080

:restart
python dev_server.py
REM Without the pause, an immediate failure (port in use, syntax error,
REM missing dependency) spins as fast as Python can start and exit.
echo Server exited; restarting in 3 seconds. Press Ctrl+C to stop.
timeout /t 3 /nobreak >nul
goto restart
