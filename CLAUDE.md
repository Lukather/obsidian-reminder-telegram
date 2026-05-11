# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Watch mode (incremental build, inline sourcemaps)
npm run build        # Production build (runs tsc type-check first, then minified bundle)
npm run lint         # ESLint check across src/
```

There are no automated tests. Testing is manual: copy `main.js` + `manifest.json` to `<Vault>/.obsidian/plugins/obsidian-reminder-telegram/` and reload Obsidian.

To bump a release version:
```bash
npm version patch    # updates manifest.json, package.json, versions.json and stages them
```

## Architecture

This is an Obsidian community plugin. TypeScript in `src/` is bundled by esbuild into a single `main.js` at the project root. The `obsidian` package is treated as an external (provided at runtime by the host app).

### Module responsibilities

| File | Responsibility |
|------|---------------|
| `src/main.ts` | Plugin lifecycle (`onload`/`onunload`), command registration, interval management |
| `src/settings.ts` | `ReminderTelegramSettings` interface, `DEFAULT_SETTINGS`, settings tab UI |
| `src/checker.ts` | Orchestration: deadline checking, `NotificationState` persistence, interval creation |
| `src/tasks.ts` | Vault scanning, task line parsing, date extraction, due/overdue filtering |
| `src/telegram.ts` | Telegram Bot API client: single messages, bulk reminders, test notification |

### Data flow

1. `scanVaultForTasks` reads every markdown file and parses lines matching `- [ ]` / `- [x]` that contain a recognized date pattern.
2. `getDueTasks` filters to incomplete tasks whose deadline is today or in the past.
3. `checkAndNotify` (in `checker.ts`) excludes tasks already tracked in `NotificationState`, then calls `sendBulkReminders` or `sendTelegramMessage` for each.
4. Notified task keys are stored in `notificationState.notifiedTasks` (format: `notified:{filePath}:{lineNumber}:{YYYY-MM-DD}`).
5. Settings and notification state are saved together via Obsidian's `saveData` / `loadData` as a single JSON blob.

### Date parsing

`tasks.ts` tries patterns in order:
1. Obsidian Tasks plugin emoji format: `📅 YYYY-MM-DD`
2. Dataview inline fields: `due:: YYYY-MM-DD`, `scheduled:: YYYY-MM-DD`, `starts:: YYYY-MM-DD`
3. Generic date regex: any `YYYY-MM-DD` or `MM/DD/YYYY` found in the task text

### Interval management caveat

`main.ts` uses two parallel mechanisms for the periodic checker: a real `window.setInterval` stored in `this.cleanupInterval` (cleaned up manually in `onunload`) and a dummy `window.setInterval` registered via `this.registerInterval` for Obsidian's automatic cleanup. The real interval is what drives checks; the dummy exists only to satisfy Obsidian's resource tracking.

## Key constraints

- `isDesktopOnly: false` in `manifest.json` — avoid Node/Electron APIs to preserve mobile compatibility.
- Never commit `main.js` or `node_modules/` (they are in `.gitignore`).
- Command IDs (`check-reminders`, `test-telegram-notification`) must never be renamed after release.
- `manifest.json` version and `versions.json` must be kept in sync when releasing; the GitHub release tag must exactly match `manifest.json`'s `version` (no `v` prefix).
