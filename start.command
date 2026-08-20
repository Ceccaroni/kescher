#!/bin/bash
# ▶ Kescher STARTEN — lokalen Server hochfahren (Hintergrund) + Browser öffnen.
# Nötig nur zum Installieren oder Update-Ziehen; die installierte PWA im Dock
# läuft danach ohnehin offline. Doppelklick im Finder genügt.
cd "$(dirname "$0")" || exit 1
PORT="${KESCHER_PORT:-4177}"

if curl -s -o /dev/null --max-time 2 "http://localhost:$PORT/"; then
  echo "▸ Kescher läuft bereits auf http://localhost:$PORT/"
else
  nohup python3 -m http.server "$PORT" >/tmp/kescher-server.log 2>&1 &
  disown 2>/dev/null || true
  for _ in $(seq 1 12); do
    curl -s -o /dev/null --max-time 1 "http://localhost:$PORT/" && break
    sleep 0.3
  done
  echo "▸ Kescher gestartet auf http://localhost:$PORT/"
fi

# Chromium-Browser bevorzugen (Safari kann die File-System-Access-API nicht)
opened=""
for app in "Google Chrome" "Arc" "Brave Browser" "Microsoft Edge"; do
  if [ -d "/Applications/$app.app" ]; then open -a "$app" "http://localhost:$PORT/"; opened=1; break; fi
done
[ -z "$opened" ] && open "http://localhost:$PORT/"

echo "  Beenden: stop.command   ·   Dieses Fenster kannst du schließen."
