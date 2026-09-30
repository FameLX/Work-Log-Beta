# Work Log

A single-file work tracker that runs entirely in the browser. No server, no install, no build step for users. Entries are stored in the browser's `localStorage`, and can optionally sync to Google Calendar, Google Tasks and (across devices) Google Drive.

| Site           | URL                                     | Source                             |
| -------------- | --------------------------------------- | ---------------------------------- |
| Production     | https://famelx.github.io/Work-Log/      | `1. Project/Work Log/worklog.html` |
| Beta (staging) | https://famelx.github.io/Work-Log-Beta/ | `1. Project/Work Log Dev/`         |

## Features

- Add entries as **Events** (date, optional start/end time, multi-day) or **Tasks** (due date).
- List and calendar views, filter by type, sort, archive, trash, and multi-select actions.
- Custom types with colours, plus light/dark and custom themes.
- **Google Calendar / Tasks** push with duplicate protection: each event is tagged with the entry id and looked up before it is created.
- Entries that could not be pushed (offline, expired sign-in) are flagged "not in Google Calendar yet" and retried on the next reconnect.
- **Cross-device sync** through a file in the user's own Google Drive.
- CSV, JSON and XLSX export.
- Optional AI panel using the user's own Groq / OpenAI-compatible key.

## Using it

Open the site, or open `worklog.html` directly in Chrome. Data stays in your browser. To use Google features, open Settings and paste your own Google OAuth **client ID**, then connect. The client ID is stored locally in your browser and is not part of this repo.

The OAuth redirect URI must be `https://famelx.github.io/Work-Log/`.

Google sign-in tokens last about an hour, so reconnect when prompted. Anything that failed to sync in the meantime is retried automatically.

## Repository layout

```
index.html                     Built page served by BOTH Pages sites
build.ps1                      Builds index.html from the dev source
1. Project/Work Log/           Production file (worklog.html) and its backups
1. Project/Work Log Dev/       Development source: html + css + js
1. Project/Work Log Shared/    Read-only shared view
1. Project/Work Log AI Proxy/  AI proxy utility
PROJECT_BACKUP/                Timestamped worklog backups
```

Only Work Log files belong here (see `.gitignore`, an allow-list). This repo is public.

## Development

The dev source is three files in `1. Project/Work Log Dev/`: `worklog dev.html` (markup), `worklog dev.css` and `worklog dev.js`. `worklog dev.html` opens straight from disk for local preview.

Build the single-file page from the repo root in PowerShell:

```powershell
.\build.ps1
```

This inlines the CSS and JS into `index.html`. Do not edit `index.html` by hand.

### Release flow

1. Edit the dev source, bump the version (topbar pill, comment on line 1 of the html, and the `CHANGELOG` in the js).
2. Save a timestamped copy to `PROJECT_BACKUP/` (`YYYY-MM-DD_HHMM_vX.Y.Z_name`); prune backups older than 10 days.
3. Run `.\build.ps1`, commit, and `git push beta main`.
4. Test on the beta site.
5. After approval, promote to production. This is **not** a plain copy:
   - replace `wl2dev_` with `wl2_` (localStorage keys and the `SYNC_NS` constant, which also switches the Drive file to `worklog-sync.json`);
   - remove the dev-only `migrateToDevNamespace` block;
   - change the topbar label `Work Log DEV` to `Work Log`;
   - set production's own version and changelog entry.
6. Save the result as `1. Project/Work Log/worklog.html`, copy it over `index.html`, `git push origin main`, then rebuild dev into `index.html` and push beta again.

Dev and production share one GitHub Pages origin, so dev uses the `wl2dev_` storage prefix to keep the two sites' data separate.

### Remotes

- `origin` is production. Push only after the change is approved on beta.
- `beta` is staging.

## Data

Entries live in `localStorage` under `wl2_*` keys (`wl2dev_*` on beta). Main keys: `wl2_entries`, `wl2_archived`, `wl2_trash`, `wl2_custom_types`, `wl2_type_colors`, `wl2_type_gcal_ids`, `wl2_ui_colors`. Entry ids are creation timestamps. Synced entries carry `gcalEventId` / `gtaskId` once pushed to Google.

## Security

Never commit OAuth client secrets, API keys or exported data to this public repo.
