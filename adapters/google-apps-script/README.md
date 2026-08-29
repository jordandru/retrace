# Retrace ← Google Docs / Drive (Apps Script forwarder)

Logs who created / edited / commented on / shared / renamed / moved / deleted your Google Docs, Sheets, Slides and Drive files into Retrace — as `who · what · when · where · why · how` events on artifacts like `gdoc:<fileId>`.

1. Open https://script.google.com → **New project**, paste `Code.gs`. (Optional: Project Settings → *Show "appsscript.json"* → replace with the one here.)
2. **Services (+)** → add **Drive Activity API** (`DriveActivity`) and **Peopleapi** (`People`).
3. **Project Settings → Script properties**: `RETRACE_URL`, `RETRACE_TOKEN` (gdrive-forwarder assert token, not owner), `RETRACE_PROJECT` (this repo: `retrace`), optional `RETRACE_FOLDER` (a folder id to scope to), optional `RETRACE_BACKFILL_DAYS` (default 7), optional `RETRACE_CAUSED_BY` (current `retrace_instruct` id so new Drive events join that chain; empty = roots).
4. Run **`setup`** once → authorize → it backfills and installs a 5-minute `poll` trigger. `testOnce` forwards the last 24 h without moving the cursor; `stop` removes the trigger. Updating `Code.gs` later does **not** need another `setup`.

While a task is in progress, set `RETRACE_CAUSED_BY` to that task's instruct id; clear it when the task is done. Drive Activity does not send Doc bytes and Retrace does not store them. Already-forwarded activities dedupe — edit the watched Doc *after* setting the property so a new event is minted.

Local dev: run `retrace-serve` and expose it (e.g. `cloudflared tunnel --url http://localhost:7777`) or just use the CLI: `retrace-gdrive replay activity.json` / `retrace-gdrive backfill --token <access token>`.
