# Reminder Telegram - Obsidian Community Plugin

## Project Overview

**Reminder Telegram** is an Obsidian community plugin that sends Telegram notifications when your tasks reach their deadline. It scans your vault for tasks with deadlines (from YAML frontmatter or inline task format) and sends configurable notifications via Telegram Bot API.

- **Plugin ID**: `reminder-telegram`
- **Current Version**: 1.0.3
- **Author**: Lorenzo Strambi
- **Min App Version**: 1.4.0
- **Desktop Only**: No (mobile compatible)
- **Repository**: [Lukather/obsidian-reminder-telegram](https://github.com/Lukather/obsidian-reminder-telegram)

## Core Functionality

The plugin scans markdown files for tasks and sends Telegram notifications for tasks that are due today or overdue.

### Supported Task Formats

1. **YAML Frontmatter** (primary):
   - Files with `---` delimiters
   - Deadline fields: `scheduled` or `due` (ISO format: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`)
   - Status field: `status: open|done|in-progress|completed|cancelled|archived`
   - Tag requirement: files must have `task` or `#task` tag to be recognized

2. **Inline Tasks**:
   - Format: `- [ ] Task description 📅 2024-01-01`
   - Also supports: `due::`, `scheduled::`, `starts::` prefixes
   - Date formats: `YYYY-MM-DD`, `MM/DD/YYYY`, `DD-MM-YYYY`

### Notification Features

- **Bulk Notifications**: Multiple due tasks combined into a single message
- **Individual Notifications**: Single task gets individual message (when only one due)
- **Duplicate Prevention**: Tracks notified tasks to avoid repeated notifications
- **Status Bar Integration**: Click to manually trigger check, shows last check time
- **Customizable Templates**: Three template types with variable substitution
- **Markdown Formatting**: Optional Telegram Markdown support

## File & Folder Structure

```
.
├── src/
│   ├── main.ts              # Plugin entry point, lifecycle, commands, status bar
│   ├── settings.ts          # Settings interface, defaults, settings tab UI
│   ├── checker.ts           # Deadline checking logic, notification state
│   ├── tasks.ts             # Task parsing, scanning, deadline filtering
│   ├── telegram.ts          # Telegram API client, message sending
│   └── utils.ts             # Security utilities, sensitive data masking
├── main.js                  # Compiled bundle (generated)
├── manifest.json            # Plugin metadata
├── styles.css               # Status bar icon styling
├── package.json             # Dependencies, scripts, project config
├── tsconfig.json            # TypeScript configuration
├── esbuild.config.mjs       # Bundler configuration
├── eslint.config.mts        # Linting configuration
├── version-bump.mjs         # Version bump automation script
├── versions.json            # Version to minAppVersion mapping
└── .editorconfig             # Editor settings (tabs, 4 spaces)
```

## Module Responsibilities

| File | Purpose |
|------|---------|
| `src/main.ts` | Plugin class (`ReminderTelegramPlugin`), onload/onunload, commands, status bar, periodic checking |
| `src/settings.ts` | Settings interface (`ReminderTelegramSettings`), defaults, `ReminderTelegramSettingTab` UI |
| `src/checker.ts` | `checkDeadlines()`, `checkAndNotify()`, notification state management, duplicate prevention |
| `src/tasks.ts` | `VaultTask` interface, `scanVaultForTasks()`, date parsing, deadline filtering |
| `src/telegram.ts` | `sendTelegramMessage()`, `sendTaskReminder()`, `sendBulkReminders()`, template rendering |
| `src/utils.ts` | `sanitizeErrorMessage()`, `maskSensitiveInfo()`, security helpers |

## Environment & Tooling

- **Runtime**: Obsidian plugin API (browser/ESM)
- **Language**: TypeScript (strict mode)
- **Module System**: ESNext
- **Target**: ES6
- **Bundler**: esbuild (v0.28.0)
- **Package Manager**: npm
- **Type Definitions**: `obsidian` from npm

### Install Dependencies
```bash
npm install
```

### Development (Watch Mode)
```bash
npm run dev
```

### Production Build
```bash
npm run build
```

### Lint
```bash
npm run lint
```

### Bump Version
```bash
npm version patch  # or minor/major, triggers version-bump.mjs
npm run version    # Alternative: manually bump via version-bump.mjs
```

## Settings

The plugin uses a single settings interface defined in `src/settings.ts`:

```typescript
interface ReminderTelegramSettings {
    telegramBotToken: string;           // Bot token from @BotFather
    telegramChatId: string;             // User chat ID from @userinfobot
    notificationsEnabled: boolean;     // Master switch (default: true)
    checkIntervalMinutes: number;       // Periodic check frequency (default: 30)
    scanMode: 'whole-vault' | 'specific-folder';  // Scan scope
    targetFolder: string;               // Folder path when scanMode = 'specific-folder'
    bulkMessageTemplate: string;       // Template for multiple tasks
    individualMessageTemplate: string; // Template for single task
    testMessageTemplate: string;       // Template for test notifications
    useMarkdownFormatting: boolean;    // Enable Telegram Markdown (default: false)
    maxTasksPerCheck: number;           // Limit notifications per run (default: 10)
}
```

### Template Variables

| Template Type | Available Variables |
|---------------|---------------------|
| Bulk | `{count}`, `{tasks}` |
| Individual/Task Line | `{taskName}`, `{fileName}`, `{deadline}`, `{filePath}`, `{taskId}` |
| Test | (uses raw template string) |

## Commands

| ID | Name | Description |
|----|------|-------------|
| `check-reminders` | Check reminders now | Manually trigger deadline check |
| `test-telegram-notification` | Send test Telegram notification | Verify Telegram configuration |

## Notification Flow

```
User enables notifications → startPeriodicChecking() → window.setInterval
    ↓
checkDeadlines() called:
    1. scanVaultForTasks() - scans markdown files
    2. getDueTasks() - filters for today/overdue
    3. filterDueTasksByCheckFlags() - applies today/overdue flags
    4. filter already notified tasks (via notificationState.notifiedTasks)
    5. apply maxTasksPerCheck limit
    6. sendBulkReminders() OR sendTaskReminder() via Telegram API
    7. markAsNotified() - update notificationState
    8. saveSettings() - persist state
```

## State Management

- **Plugin Settings**: Persisted via `this.loadData()` / `this.saveData()`
- **Notification State**: Tracked separately, merged with settings on save
  - `notifiedTasks: Record<string, number>` - task ID → timestamp
  - `lastCheck: number` - last check timestamp
- **Notification Key**: `notified:${task.id}:${deadlineDate}`

## Build Configuration

### esbuild.config.mjs
- Entry point: `src/main.ts`
- Bundle: true
- Format: CJS (CommonJS)
- Target: ES2018
- External: `obsidian`, `electron`, CodeMirror packages, Node builtins
- Sourcemap: inline (dev) or none (production)
- Minify: production only
- Banner: Generated file notice

### tsconfig.json
- Module: ESNext
- Target: ES6
- Strict mode: Multiple strict flags enabled
- Module Resolution: Node
- Base URL: `src`
- Lib: DOM, ES5, ES6, ES7

## Security Considerations

- **Sensitive Data**: Telegram bot token and chat ID are masked in logs
- **Sanitization**: `sanitizeErrorMessage()` strips sensitive values from error output
- **Storage**: Tokens stored in plugin data (vault-local), not transmitted anywhere
- **No Telemetry**: No analytics or tracking
- **Network**: Only makes POST requests to `https://api.telegram.org`

## Key Interfaces

```typescript
// Task representation
interface VaultTask {
    id: string;              // "filePath:lineNumber" or "filePath:frontmatter"
    text: string;            // Task description/title
    filePath: string;        // Full vault path
    fileName: string;        // Basename only
    lineNumber: number;      // 0 for frontmatter tasks
    completed: boolean;      // [x] or status: done/completed
    deadline: Date | null;   // Parsed deadline date
    deadlineString: string | null;  // Original date string from source
    originalLine: string;    // Raw source line
    source: 'inline' | 'frontmatter';
}

// Scan configuration
interface ScanSettings {
    scanMode: 'whole-vault' | 'specific-folder';
    targetFolder: string;
}

// Notification tracking
interface NotificationState {
    notifiedTasks: Record<string, number>;  // task key → timestamp
    lastCheck: number;
}

// Telegram response
interface TelegramSendResult {
    success: boolean;
    message?: string;
    error?: string;
}
```

## Event Handling

- **Status Bar Click**: Triggers `manualCheck()` with Notice feedback
- **Settings Changes**: Auto-saves and restarts periodic checking
- **Periodic Check**: Runs on interval, auto-starts on load if configured
- **Manual Check**: Available via command palette and status bar

## Performance Considerations

- **Vault Scanning**: Full scan on each check (not incremental)
- **Task Limit**: `maxTasksPerCheck` prevents notification flooding
- **Duplicate Filtering**: Hash-based tracking prevents repeat notifications
- **Interval Cleanup**: `registerInterval()` ensures proper cleanup on unload

## Testing Workflow

1. **Manual Install**: Copy `main.js`, `manifest.json`, `styles.css` to `<Vault>/.obsidian/plugins/reminder-telegram/`
2. **Configure**: Set Telegram bot token and chat ID in settings
3. **Test**: Use "Send test Telegram notification" command
4. **Verify**: Check Telegram for test message

## Version Management

- `manifest.json`: Contains `version` (plugin version) and `minAppVersion`
- `versions.json`: Maps plugin versions to min Obsidian app versions
- `version-bump.mjs`: Automates version bumping in manifest.json and versions.json
- GitHub releases: Tag must match manifest.json version (no `v` prefix)

## File Organization

### AI-Generated Files
All files that are not strictly useful to the plugin but just AI-generated (like plans, summaries, reviews, etc.) must be in the `.ai/` folder. This keeps the repository clean and focused on actual plugin code.

## Coding Conventions

- **TypeScript**: Strict mode, explicit types
- **Indentation**: Tabs, 4 spaces (per .editorconfig)
- **Naming**: camelCase for variables/functions, PascalCase for types/classes
- **Error Handling**: Try/catch around async operations, sanitized error messages
- **Logging**: Use `console.error()` for errors, avoid logging sensitive data
- **Imports**: Prefer named imports, group by source
- **File Organization**: Single responsibility per file, keep `main.ts` focused on lifecycle

## Common Patterns

### Adding a New Setting

1. Add to `ReminderTelegramSettings` interface
2. Add default in `DEFAULT_SETTINGS`
3. Add UI control in `ReminderTelegramSettingTab.display()`
4. Use setting in appropriate module

### Adding a New Command

```typescript
// In main.ts onload():
this.addCommand({
    id: 'new-command',
    name: 'New Command',
    callback: () => {
        new Notice('Command executed');
        // Your logic here
    }
});
```

### Registering Event Listeners

```typescript
// Safe registration with cleanup
this.registerEvent(
    this.app.workspace.on('file-open', (file) => {
        // Handle file open
    })
);

// For intervals
this.registerInterval(
    window.setInterval(() => { /* ... */ }, 1000)
);
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Plugin doesn't load | Ensure `main.js` exists at plugin root, run `npm run build` |
| No notifications | Verify bot token, chat ID, and notifications enabled in settings |
| Duplicate notifications | Check notification state persistence, clear plugin data |
| Build errors | Run `npm install`, check TypeScript compilation with `tsc -noEmit` |
| Lint errors | Run `npm run lint`, fix ESLint issues |
| Status bar missing | Check `addStatusBarItem()` call in onload |
| Commands not appearing | Verify `addCommand()` runs after onload, check for unique IDs |

## References

- **Obsidian API Docs**: https://docs.obsidian.md
- **Plugin Guidelines**: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- **Developer Policies**: https://docs.obsidian.md/Developer+policies
- **Telegram Bot API**: https://core.telegram.org/bots/api
- **TypeScript Config**: https://www.typescriptlang.org/tsconfig
- **esbuild**: https://esbuild.github.io
