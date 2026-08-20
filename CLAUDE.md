# Projekt: Kescher — Idea Inbox

Eine installierbare PWA (reines HTML/CSS/JS, kein Build) zum schnellen Erfassen
von Ideen/Tickets **mit Screenshots**. Sie schreibt gesammelte Einträge über die
File System Access API als Markdown + Bilder nach `inbox/`.

## Wenn der Nutzer sagt „arbeite die Inbox ab" (o. Ä.)

1. `inbox/` durchgehen. Jeder Unterordner = ein Ticket:
   - `ticket.md` mit Frontmatter (`title`, `type`, `created`, `status`) + Beschreibung + Sektion `## Anhänge`
   - Anhänge: Bilder als `shot-*.png|jpg`, sonstige Dateien mit Originalnamen (PDF, MD, TXT, DOCX, PPTX, …)
2. Anhänge **lesen** (Read-Tool kann Bilder & PDFs; Text/MD direkt) und in die Ticket-Erstellung einbeziehen.
3. Daraus die finalen Tickets erzeugen. **Ziel ist noch nicht fixiert** — beim
   ersten Mal kurz klären. Empfehlung (weil Screenshots im Spiel sind):
   lokale Markdown-Tickets. Alternativen: GitHub Issues (`gh`), Linear/Jira.
4. Verarbeitete Ordner nicht kommentarlos löschen — nach `inbox/_done/` verschieben
   oder erst nach Bestätigung entfernen.

## Struktur
- `index.html`, `styles.css`, `app.js` — App-Shell & Logik
- `sw.js`, `manifest.webmanifest` — PWA/Offline
- `fonts/` (lokal gebündelt), `icons/` (via `tools/make_icons.py`)
- `inbox/` — erfasste Tickets (gitignored)

## Konventionen
- Sprache Deutsch. Ästhetik: Bernstein auf Fast-Schwarz, Bricolage Grotesque + JetBrains Mono.
- Nach Änderungen an App-Dateien die `CACHE`-Version in `sw.js` erhöhen.
