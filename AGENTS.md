# Reminder Telegram

Obsidian plugin that sends Telegram notifications for due/overdue tasks.

## Tasks

**YAML Frontmatter** (primary):
- Requires `---` delimiters and a `scheduled` or `due` field (ISO: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`)
- Completion from `status: done|completed|cancelled|archived` (or presence of `completedDate`); `open` / `in-progress` are incomplete
- Task text = note basename, or first heading after frontmatter if present
- Frontmatter `tags` (array or comma string) are extracted for sidebar tag filtering

**Inline Tasks** (lines `- [ ] ...` / `- [x] ...`):
- Obsidian syntax: `📅 YYYY-MM-DD`, `due::`, `scheduled::`, `starts::` (formats: `YYYY-MM-DD`, `MM/DD/YYYY`, `DD-MM-YYYY`)
- Reminder-plugin syntax (issue #96, gated by `reminderSyntaxEnabled`): `@YYYY-MM-DD HH:MM` (bare, requires time) and `(@YYYY-MM-DD HH:MM)` / `(@YYYY-MM-DD)` (parenthesized) → datetime; `(@YYYY-MM-DD)` → date-only
- Kanban-plugin syntax (issue #97, gated by `kanbanSyntaxEnabled`): `@YYYY-MM-DD @@HH:MM` → datetime; `@YYYY-MM-DD` (not followed by `@@`) → date-only
- Recurring tasks (issue #98, gated by `recurringTasksEnabled`): `🔁 every day|week [on <weekday>]|month|year` appended to an inline task; completing the task auto-reschedules it to the next occurrence (checkbox re-opened, text/metadata preserved)
- Lines inside fenced code blocks (``` or ~~~) are skipped

**Deadlines**: date-only (`YYYY-MM-DD`) vs datetime (has a time component). Datetime tasks are "at-time" tasks owned by the `AtTimeScheduler`; date-only tasks go through periodic checks.

## Files

| File | Purpose |
|------|---------|
| `src/main.ts` | Plugin lifecycle, commands, status bar, periodic checking, at-time scheduler wiring, sidebar toggle |
| `src/settings.ts` | Settings interface + defaults, pure validators, UI tab (`ReminderTelegramSettingTab`) with dual renderer: `getSettingDefinitions()` (Obsidian ≥ 1.13) + legacy `display()` fallback (< 1.13, minAppVersion 1.7.2), live template preview |
| `src/checker.ts` | `checkDeadlines()`, `checkAndNotify()`, at-time dispatch (`dispatchAtTimeReminders`, `dueAtTimeTasks`), notification-state load/save/prune |
| `src/tasks.ts` | `VaultTask`, `Deadline`, `Recurrence`, `scanVaultForTasks()`, `parseTaskLine()`, `parseFrontmatterTasksFromCache()`, filtering helpers, notification keys, recurrence computation (`computeNextOccurrence`, `buildNextOccurrenceLine`, `computeCompletionReschedules`, `applyRescheduleEdits`) |
| `src/task-index.ts` | `TaskIndex` — incremental in-memory index (full scan on load, vault-event updates afterward) |
| `src/scheduler.ts` | `AtTimeScheduler` — `setTimeout` wake timer for the next at-time deadline (purely a timer; dispatch is the caller's `onWake` callback) |
| `src/sidebar-filter.ts` | Pure categorization/filtering for the sidebar: `categorizeTasks()`, time-scope + tag filters, `formatRelativeDate()` |
| `src/sidebar-view.ts` | `ReminderTelegramSidebarView` — right-sidebar `ItemView` (Overdue / Due Today / Upcoming) |
| `src/telegram.ts` | `sendTelegramMessage()`, `sendTaskReminder()`, `sendBulkReminders()`, `sendTestNotification()` |
| `src/utils.ts` | `sanitizeErrorMessage()`, `maskSensitiveInfo()`, `getSanitizedSettingsForLogging()` |

## Settings

```typescript
interface ReminderTelegramSettings {
    telegramBotToken: string;           // @BotFather
    telegramChatId: string;             // @userinfobot
    notificationsEnabled: boolean;     // default: true
    checkIntervalMinutes: number;       // default: 30
    scanMode: 'whole-vault' | 'specific-folder';
    targetFolder: string;
    bulkMessageTemplate: string;        // {count}, {tasks}
    individualMessageTemplate: string;  // {taskName}, {fileName}, {deadline}, {filePath}, {taskId}
    testMessageTemplate: string;
    useMarkdownFormatting: boolean;     // default: false
    maxTasksPerCheck: number;           // default: 10 (min 1)
    upcomingRemindersDaysAhead: number; // default: 1 (0 disables)
    upcomingRemindersEnabled: boolean;  // default: true
    upcomingMessageTemplate: string;    // individual upcoming
    upcomingBulkMessageTemplate: string;
    livePreviewEnabled: boolean;        // default: true
    atTimeNotificationsEnabled: boolean;// default: true
    leadTimeMinutes: number;            // default: 0 (sharp); max 1440
    atTimeCatchUpWindowMinutes: number; // default: 60; max 10080
    strictTimeMode: boolean;            // default: false
    reminderSyntaxEnabled: boolean;     // default: true
    kanbanSyntaxEnabled: boolean;       // default: true
  recurringTasksEnabled: boolean;     // default: true (issue #98)
}
```

## Agent skills

### Issue tracker

Issues live in GitHub Issues. See `.ai/issue-tracker.md`.

### Triage labels

Uses default label names (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `.ai/triage-labels.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` at repo root. See `.ai/domain.md`. (No `CONTEXT.md` exists yet — created lazily by `/grill-with-docs`.)

## Commands

| ID | Name |
|----|------|
| `check-reminders` | Check reminders now |
| `test-telegram-notification` | Send test Telegram notification |
| `toggle-sidebar` | Toggle sidebar (also on the bell ribbon icon) |

## Notification Flow

### Periodic / manual checks (`checkAndNotify`)
```
manualCheck() / periodic interval → taskIndex.getAllTasks()
    ↓
getDueTasks() (today + overdue) → filterDueTasksByCheckFlags()
    ↓ strictTimeMode: strip datetime (at-time) tasks — owned by the scheduler
getUpcomingTasks() (tomorrow..daysAhead) if upcomingRemindersEnabled
    ↓
filter already-notified (notifiedTasks) → apply maxTasksPerCheck budget (due first, then upcoming)
    ↓
bulk (if >1 and sendBulk) or individual send → markAsNotified() → saveSettings()
```

### At-time pipeline (issue #89)
```
armAtTimeScheduler() → AtTimeScheduler.arm(tasks, leadTime, catchUpWindow, notifiedAtTimeInstances)
    ↓ fires at next (deadline − leadTime)
handleAtTimeWake() → dispatchAtTimeReminders()
    ↓ dueAtTimeTasks(): fires in [now − catchUpWindow, now], dedup by notifiedAtTimeInstances
sendTaskReminder() each → markAtTimeInstanceNotified() → rearm() in finally
```
- Rearms are debounced (200 ms) on vault create/modify/delete + metadataCache resolve + `window-open` + `visibilitychange` (wake-from-sleep)
- `strictTimeMode` gates at-time tasks out of periodic checks (default off → periodic check is a safety net)
- Catch-up: on next app open, fires whose `scheduledFire` is within `atTimeCatchUpWindowMinutes` still go out
- `leadTimeMinutes` fires *before* the deadline; `delayedByMinutes` is rendered as a `(delayed Xm)` suffix when late

## Notification State

```typescript
interface NotificationState {
    notifiedTasks: Record<string, number>;          // key: notified:${task.id}:${deadlineDate} → timestamp
    notifiedAtTimeInstances: Record<string, number>;// key: taskId → scheduledFire (ms); rescheduling a task allows it to fire again
    lastCheck: number;
}
```
Persisted inside plugin data (alongside settings) via `saveNotificationState()`. Pruned on every check: 30-day age window; `notifiedTasks` capped at 1000 most recent entries.

**Notification Keys**:
- Date-only/periodic: `notified:${task.id}:${deadlineDate}`
- At-time: `notifiedAtTimeInstances[${task.id}] = ${scheduledFire ms}`

## Build

```bash
npm install
npm run dev          # watch mode
npm run build        # tsc -noEmit && esbuild production
npm run lint         # eslint
npm test             # vitest run (jsdom, obsidian mocked via __mocks__)
npm run test:watch
npm run test:coverage
npm run test:ci      # vitest run --reporter=verbose
npm version patch    # bump version (triggers version-bump.mjs)
```

**Config**: esbuild (entry: `src/main.ts`, format: CJS, target: ES2018). Tests: vitest + jsdom with `obsidian` aliased to `__mocks__/obsidian.ts`; `src/__integration__/task-pipeline.test.ts` runs the real pipeline end-to-end with mocked vault I/O and Telegram HTTP.

## Interfaces

```typescript
type Deadline = { type: 'date-only'; year: number; month: number; day: number }
              | { type: 'datetime'; date: Date };

interface VaultTask {
    id: string;                 // stable: inline:${filePath}:${deadlineDate}:${contentHash} | frontmatter:${filePath}:${deadlineDate}
    text: string;               // task text (inline) or basename/first heading (frontmatter)
    filePath: string;
    fileName: string;
    lineNumber: number;         // 1-based, 0 for frontmatter
    completed: boolean;
    deadline: Deadline | null;
    deadlineString: string | null;
    timeString: string | null;  // "HH:MM" for datetime; null otherwise
    isAtTime: boolean;          // deadline.type === 'datetime'
    originalLine: string;
    source: 'inline' | 'frontmatter';
    tags: string[];             // frontmatter tags only
    headingLineNumber?: number; // first heading line (frontmatter, for scroll-to)
}

interface ScanSettings {
    scanMode: 'whole-vault' | 'specific-folder';
    targetFolder: string;
    reminderSyntaxEnabled?: boolean; // default true
    kanbanSyntaxEnabled?: boolean;   // default true
}

interface TelegramSendResult {
    success: boolean;
    message?: string;
    error?: string;
}

interface TelegramTaskTemplateFields {
    taskName: string;
    fileName: string;
    deadline: string;
    filePath: string;
    taskId: string;
    delayedByMinutes?: number | null; // at-time only; renders "(delayed Xm)"
}
```

## Security

- Token/chat ID masked in logs via `maskSensitiveInfo()`
- `sanitizeErrorMessage()` strips sensitive data from errors
- `getSanitizedSettingsForLogging()` for safe settings snapshots
- No telemetry/analytics

## Coding Conventions

- TypeScript strict mode, tabs (4 spaces), camelCase functions, PascalCase types
- Try/catch async ops, `console.error()` for errors, no sensitive data logging
- Pure logic lives in leaf modules (`tasks.ts`, `sidebar-filter.ts`, `scheduler.ts`) so it's testable without the Obsidian API — the mock (`__mocks__/obsidian.ts`) covers the rest
- AI-generated files → `.ai/` folder

## Common Patterns

**Add setting**: Interface → DEFAULT_SETTINGS → `ReminderTelegramSettingTab.buildDefinitions()` — add a key-bound `control` item for simple controls (toggles/dropdown/text) or a `render` definition for custom rows (sidebar: password inputs, numeric coercion via pure validators, template textareas with chips/counter). `setControlValue()` persists and applies side effects; it is shared by the 1.13+ framework binding and the legacy renderer.

**Add command**:
```typescript
this.addCommand({
    id: 'command-id',
    name: 'Command Name',
    callback: () => new Notice('Done')
});
```

**Register cleanup**:
```typescript
this.registerInterval(window.setInterval(fn, ms));
this.registerEvent(this.app.workspace.on('event', handler));
```

**Data flow note**: main.ts sources all tasks from `this.taskIndex.getAllTasks()` (built once on load, updated via vault events) — never call `scanVaultForTasks()` directly from the plugin.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| No load | Check `main.js` exists, run `npm run build` |
| No notifications | Verify token, chat ID, enabled in settings |
| At-time tasks never fire | Check `atTimeNotificationsEnabled`, `leadTimeMinutes`/`catchUpWindow` vs. actual delay |
| Duplicates | Clear plugin data, check state persistence (`notifiedTasks` / `notifiedAtTimeInstances`) |
| Build errors | `npm install`, `npm run build` (runs `tsc --noEmit`) |

## Links

- [Obsidian API](https://docs.obsidian.md)
- [Plugin Guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [Telegram Bot API](https://core.telegram.org/bots/api)

---
- **ID**: `reminder-telegram`
- **Version**: 1.0.8
- **Min App**: 1.7.2
- **Repo**: [Lukather/obsidian-reminder-telegram](https://github.com/Lukather/obsidian-reminder-telegram)