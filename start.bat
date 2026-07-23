@echo off
set BYM_API_LOG=errors
set BYM_API_LOG_MAX_BODY=200000
set BYM_HIDDEN_TILE_STYLE=blend 
:restart
python dev_server.py
goto restart