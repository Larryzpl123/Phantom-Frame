#!/bin/bash
# Double-click me: starts the local server and opens the game
cd "$(dirname "$0")"
PORT=8770
while lsof -i :$PORT >/dev/null 2>&1; do PORT=$((PORT+1)); done
echo "机甲对战 → http://localhost:$PORT"
echo "(close this window to stop the server)"
(sleep 1 && open "http://localhost:$PORT") &
python3 server.py "$PORT"
