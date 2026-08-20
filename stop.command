#!/bin/bash
# ■ Kescher STOPPEN — den lokalen Server beenden.
# Die installierte PWA im Dock funktioniert weiterhin (offline aus dem Cache).
PORT="${KESCHER_PORT:-4177}"

if pkill -f "http.server $PORT" 2>/dev/null; then
  echo "▸ Kescher-Server (Port $PORT) beendet."
else
  echo "▸ Kein laufender Kescher-Server auf Port $PORT gefunden."
fi
