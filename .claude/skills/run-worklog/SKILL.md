---
name: run-worklog
description: Run, screenshot, and drive worklog.html — the Work Log v2.1 single-file app. Use this skill to start the app, add entries, take screenshots, or verify UI state programmatically.
---

# run-worklog

Work Log v2.1 is a single-file HTML app (`worklog.html`) with no build step and no server. It runs entirely in the browser using `localStorage` for persistence. The driver opens it in Chrome with remote debugging (`--remote-debugging-port=9222`) and communicates via CDP (Chrome DevTools Protocol) using `cdp.exe` — a small compiled C# binary in this skill directory.

## Prerequisites

- Google Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe`
- The `cdp.exe` binary (pre-compiled, in this skill dir — source: `cdp.cs`)
- If you need to rebuild `cdp.exe`:
  ```
  C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:exe /out:.claude\skills\run-worklog\cdp.exe .claude\skills\run-worklog\cdp.cs
  ```

## Run (agent path)

All commands run from the project root (`C:\Users\Uesr01\Desktop\Work Files\AI\`):

```powershell
# Take a screenshot (launches Chrome automatically if not running)
.\.claude\skills\run-worklog\driver.ps1 screenshot C:\Temp\out.png

# Evaluate JavaScript in the page
.\.claude\skills\run-worklog\driver.ps1 eval "entries.length"

# Click a CSS selector
.\.claude\skills\run-worklog\driver.ps1 click ".btn-primary"

# Set a field value (fires input + change events)
.\.claude\skills\run-worklog\driver.ps1 set "#f-name" "My task name"

# Add an entry end-to-end
.\.claude\skills\run-worklog\driver.ps1 add-entry "Work name" "Type" "2026-06-25"

# Print current entry count
.\.claude\skills\run-worklog\driver.ps1 count

# Kill the debug Chrome instance
.\.claude\skills\run-worklog\driver.ps1 stop
```

Chrome is launched once and left running. The driver reconnects on each call via the CDP HTTP endpoint (`http://127.0.0.1:9222/json`). If Chrome is already running with the debug port, the driver reuses it. Screenshots land wherever you specify.

## Key selectors

| Element | Selector |
|---|---|
| Work name input | `#f-name` |
| Type dropdown | `#f-type` |
| Start/deadline date | `#f-deadline` |
| End date | `#f-deadline-end` |
| Task mode due date | `#f-deadline-task` |
| Time field | `#f-time` |
| Remark textarea | `#f-remark` |
| Add entry button | `.btn-primary` |
| Clear form button | `button.btn:not(.btn-primary)` (second sidebar btn) |
| Event/Task toggle — Event | `#mode-event-btn` |
| Event/Task toggle — Task | `#mode-task-btn` |

## Run (human path)

Double-click `worklog.html` (or open `file:///C:/Users/Uesr01/Desktop/Work%20Files/AI/worklog.html` in Chrome). The app loads instantly. Ctrl+C is not needed — just close the tab.

## Gotchas

- **Chrome debug port dies between sessions.** Each driver call checks if the tab is alive via `http://127.0.0.1:9222/json`. If Chrome was killed, the driver relaunches it automatically. The debug Chrome uses a separate `--user-data-dir` (`C:\Temp\chrome-worklog-debug`) so it doesn't conflict with your everyday Chrome.
- **`localStorage` persists across sessions.** Test entries added by the driver accumulate. Clear with: `.\.claude\skills\run-worklog\driver.ps1 eval "localStorage.clear(); location.reload()"`
- **The `cdp.exe` WebSocket read uses a 2MB buffer.** The screenshot response base64 is ~70KB so this is fine. If you add a command that returns a very large payload, increase `buf = new byte[2097152]` in `cdp.cs` and recompile.
- **`file://` origin.** The app runs from `file://` — localStorage works, but cross-origin `fetch` calls (Google Calendar/Tasks API) require network. The OAuth redirect URI must be `https://famelx.github.io/Work-Log/` per the setup guide.
- **Type dropdown values** are exactly: `Meeting`, `Review`, `Report`, `Research`, `Other` (and any custom types the user has added). Passing an unrecognised type to `add-entry` leaves the dropdown on "— Select type —" without error.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Unable to connect to the remote server` on port 9222 | Chrome was killed. Run any driver command — it auto-relaunches. |
| `cdp.exe is not recognized` | Rebuild: `csc.exe /target:exe /out:cdp.exe cdp.cs` from the skill dir. |
| Screenshot is 0 bytes | CDP WebSocket read was truncated. This happened with PS5.1 `Add-Type` WebSocket — use `cdp.exe` only, not the raw PS approach. |
| Entry count doesn't increase | The `add-entry` sub-command clicks `.btn-primary`. If the name field is empty, `addEntry()` calls `toast()` and bails silently. Always pass a non-empty name. |
