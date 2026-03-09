#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /home/anieshchawla/nanoclaw-main/nanoclaw.pid)

set -euo pipefail

unset ASSISTANT_NAME

cd "/home/anieshchawla/nanoclaw-main"

# Stop existing instance if running
if [ -f "/home/anieshchawla/nanoclaw-main/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/home/anieshchawla/nanoclaw-main/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/usr/local/nvm/versions/node/v24.13.1/bin/node" "/home/anieshchawla/nanoclaw-main/dist/index.js" \
  >> "/home/anieshchawla/nanoclaw-main/logs/nanoclaw.log" \
  2>> "/home/anieshchawla/nanoclaw-main/logs/nanoclaw.error.log" &

echo $! > "/home/anieshchawla/nanoclaw-main/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /home/anieshchawla/nanoclaw-main/logs/nanoclaw.log"
