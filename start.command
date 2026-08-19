#!/bin/bash
# Kescher starten: lokalen Server hochfahren + Browser öffnen.
# Doppelklick im Finder genügt (oder: ./start.command im Terminal).
cd "$(dirname "$0")" || exit 1
PORT="${KESCHER_PORT:-4177}"

echo "▸ Kescher läuft auf http://localhost:$PORT/"
echo "  (Fenster offen lassen, solange du die App über den Browser lädst."
echo "   Nach dem Installieren als PWA läuft sie auch ohne diesen Server.)"
echo "  Beenden: Ctrl+C"
echo

python3 -m http.server "$PORT" >/dev/null 2>&1 &
SRV=$!
sleep 1
open "http://localhost:$PORT/" 2>/dev/null || true
trap 'kill $SRV 2>/dev/null' EXIT
wait $SRV
