# Retrace ← Google Docs / Drive (Apps Script forwarder)

Logs who created / edited / commented on / shared / renamed / moved / deleted your Google Docs, Sheets, Slides and Drive files into Retrace — as `who · what · when · where · why · how` events on artifacts like `gdoc:<fileId>`.

1. Open https://script.google.com → **New project**, paste `Code.gs`. (Optional: Project Settings → *Show "appsscript.json"* → replace with the one here.)
2. **Services (+)** → add **Drive Activity API** (`DriveActivity`) and **Peopleapi** (`People`).
3. **Project Settings → Script properties**: `RETRACE_URL`, `RETRACE_TOKEN`, `RETRACE_PROJECT` (e.g. `boxing-rpg`), optional `RETRACE_FOLDER` (a folder id to scope to), optional `RETRACE_BACKFILL_DAYS` (default 7).
4. Run **`setup`** once → authorize → it backfills and installs a 5-minute `poll` trigger. `testOnce` forwards the last 24 h without moving the cursor; `stop` removes the trigger.

Local dev: run `retrace-serve` and expose it (e.g. `cloudflared tunnel --url http://localhost:7777`) or just use the CLI: `retrace-gdrive replay activity.json` / `retrace-gdrive backfill --token <access token>`.
