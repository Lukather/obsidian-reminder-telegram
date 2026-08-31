# Reminder Telegram

Obsidian plugin that sends Telegram notifications for due/overdue tasks.

## Tasks

**YAML Frontmatter** (primary):
- Files with `---` delimiters, require `#task` or `task` tag
- `scheduled` or `due` (ISO: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`)
- `status: open|done|in-progress|completed|cancelled|archived`

**Inline Tasks**:
- `- [ ] Task 📅 2024-01-01`
- Prefixes: `due::`, `scheduled::`, `starts::`
- Formats: `YYYY-MM-DD`, `MM/DD/YYYY`, `DD-MM-YYYY`
- Reminder-plugin syntax (issue #96, gated by `reminderSyntaxEnabled`): `@YYYY-MM-DD HH:MM`, `(@YYYY-MM-DD HH:MM)` → datetime; `(@YYYY-MM-DD)` → date-only
- Kanban-plugin syntax (issue #97, gated by `kanbanSyntaxEnabled`): `@YYYY-MM-DD @@HH:MM` → datetime; `@YYYY-MM-DD` → date-only (Reminder syntax stays authoritative for `@YYYY-MM-DD HH:MM`)

## Files

| File | Purpose |
|------|---------|
| `src/main.ts` | Plugin lifecycle, commands, status bar, periodic checking |
| `src/settings.ts` | Settings interface, UI tab (`ReminderTelegramSettingTab`) |
| `src/checker.ts` | `checkDeadlines()`, `checkAndNotify()`, duplicate prevention |
| `src/tasks.ts` | `VaultTask`, `scanVaultForTasks()`, date parsing |
| `src/telegram.ts` | `sendTelegramMessage()`, `sendTaskReminder()`, `sendBulkReminders()` |
| `src/utils.ts` | `sanitizeErrorMessage()`, `maskSensitiveInfo()` |

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
    maxTasksPerCheck: number;           // default: 10
    reminderSyntaxEnabled: boolean;     // default: true
    kanbanSyntaxEnabled: boolean;       // default: true
}
```

## Agent skills

### Issue tracker

Issues live in GitHub Issues. See `.ai/issue-tracker.md`.

### Triage labels

Uses default label names (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `.ai/triage-labels.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` at repo root. See `.ai/domain.md`.

## Commands

| ID | Name |
|----|------|
| `check-reminders` | Check reminders now |
| `test-telegram-notification` | Send test Telegram notification |

## Notification Flow

```
periodic checking → checkDeadlines() → scanVaultForTasks() → getDueTasks()
    ↓
filter by check flags → filter already notified → apply maxTasksPerCheck
    ↓
sendBulkReminders() OR sendTaskReminder() → markAsNotified() → saveSettings()
```

**Notification Key**: `notified:${task.id}:${deadlineDate}`

## Build

```bash
npm install
npm run dev    # watch mode
npm run build  # production
npm run lint
npm version patch  # bump version (triggers version-bump.mjs)
```

**Config**: esbuild (entry: `src/main.ts`, format: CJS, target: ES2018)

## Interfaces

```typescript
interface VaultTask {
    id: string;                 // "filePath:lineNumber" or "filePath:frontmatter"
    text: string;
    filePath: string;
    fileName: string;
    lineNumber: number;         // 0 for frontmatter
    completed: boolean;
    deadline: Date | null;
    deadlineString: string | null;
    originalLine: string;
    source: 'inline' | 'frontmatter';
}

interface TelegramSendResult {
    success: boolean;
    message?: string;
    error?: string;
}
```

## Security

- Token/chat ID masked in logs via `maskSensitiveInfo()`
- `sanitizeErrorMessage()` strips sensitive data from errors
- No telemetry/analytics

## Coding Conventions

- TypeScript strict mode, tabs (4 spaces), camelCase functions, PascalCase types
- Try/catch async ops, `console.error()` for errors, no sensitive data logging
- AI-generated files → `.ai/` folder

## Common Patterns

**Add setting**: Interface → DEFAULT_SETTINGS → SettingTab.display()

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

## Troubleshooting

| Issue | Fix |
|-------|-----|
| No load | Check `main.js` exists, run `npm run build` |
| No notifications | Verify token, chat ID, enabled in settings |
| Duplicates | Clear plugin data, check state persistence |
| Build errors | `npm install`, `tsc --noEmit` |

## Links

- [Obsidian API](https://docs.obsidian.md)
- [Plugin Guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [Telegram Bot API](https://core.telegram.org/bots/api)

---
- **ID**: `reminder-telegram`
- **Version**: 1.0.7
- **Min App**: 1.4.0
- **Repo**: [Lukather/obsidian-reminder-telegram](https://github.com/Lukather/obsidian-reminder-telegram)