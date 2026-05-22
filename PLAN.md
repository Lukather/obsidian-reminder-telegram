# Implementation Plan — 3 Highest-Leverage Improvements

## Goal
Fix three reliability bugs that silently break the user experience: broken frontmatter parsing,
unstable task identity, and unguarded Telegram message length. Each phase is self-contained
and can be verified independently.

---

## Phase 1: Fix Frontmatter Parsing, Tag Validation, and Time-Aware Deadlines

**Goal:** Eliminate silent parsing failures and false-positive task detections.

### 1.1 Refactor `src/tasks.ts` — `scanVaultForTasks`
Replace `parseFrontmatter(content)` calls with `app.metadataCache.getFileCache(file)`.

- Remove the standalone `parseFrontmatter(content)` function and its `FrontmatterData` interface
  (or keep it as a `@deprecated` fallback, but prefer metadataCache).
- In `scanVaultForTasks`, iterate over markdown files as before, but for each file:
  - Read content via `app.vault.read(file)` (still needed for inline tasks).
  - Use `app.metadataCache.getFileCache(file)?.frontmatter` for structured frontmatter data.
  - Pass the `frontmatter` object and `file` object into `parseFrontmatterTasks`.
  - Use `app.metadataCache.getFileCache(file)?.sections` or a simple frontmatter-end
    detection (e.g. split the file content once for the `endLine` needed for inline parsing)
    so we do **not** call a hand-rolled YAML parser.

### 1.2 Rewrite `src/tasks.ts` — `parseFrontmatterTasks`
Signature change:
```ts
function parseFrontmatterTasks(
    frontmatter: Record<string, unknown>,
    filePath: string,
    content: string, // used to extract heading for task text
    endLine: number   // known frontmatter boundary
): VaultTask[]
```

- Check that `tags` includes `'task'` or `'#task'` (case-insensitive). 
  If not, return `[]` immediately.
- Extract `scheduled` or `due` from `frontmatter`.
- Preserve time component in deadlines (see 1.3).
- Derive `taskText` from the first heading after frontmatter (unchanged logic).
- `originalLine` can now be simplified or removed from the frontmatter branch,
  since we no longer reconstruct fake YAML.

### 1.3 Fix `src/tasks.ts` — `parseDate`
```ts
function parseDate(dateString: string): Date | null
```

- If the input contains `T` followed by time digits (e.g. `2024-12-25T14:30` or
  `2024-12-25T14:30:00`), parse it as an ISO datetime with `new Date(dateString)`.
- If it is date-only (`YYYY-MM-DD`), parse it as midnight local time (or `00:00:00 UTC`
  depending on desired behaviour; document the choice).
- Return `null` on unparseable input.

### 1.4 Clean up dead code
- Delete `parseFrontmatter()`, `formatFrontmatterForOriginalLine()`, and the
  `FrontmatterData` interface if no longer used.
- Search for any other references to these and remove them.

### Verification
- [ ] `npm run build` succeeds with zero TS errors.
- [ ] A note with `scheduled: 2024-12-25T14:30`, `tags: [task]` is detected and its
      deadline hour is 14 (not 0).
- [ ] A note with `scheduled: 2024-12-25`, `tags: [idea]` is **not** detected as a task.
- [ ] A note with valid multi-line YAML or colons in values is still parsed correctly
      via `metadataCache`.

---

## Phase 2: Stabilize Task Identity & Cap Notification State

**Goal:** Prevent duplicate notifications from line-number drift and stop `notifiedTasks` from growing forever.

### 2.1 Rewrite `src/tasks.ts` — `parseTaskLine` — stable inline task ID
```ts
function getStableTaskId(filePath: string, text: string, deadline: Date | null): string {
    const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
    const deadlinePart = deadline ? deadline.toISOString() : 'no-date';
    // Simple hash or just a concatenation if vault is small
    const raw = `${filePath}:${normalized}:${deadlinePart}`;
    // Use a short hash for brevity; a simple djb2 or even btoa is fine
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
        const char = raw.charCodeAt(i);
        hash = ((hash << 5) - hash + char) | 0;
    }
    return `${filePath}:${hash.toString(16)}`;
}
```

In `parseTaskLine`, replace:
```ts
id: `${filePath}:${lineNumber}`
```
with:
```ts
id: getStableTaskId(filePath, text, deadlineInfo.date)
```

Keep `lineNumber` in the `VaultTask` record for debugging/UI, but do **not** use it in `id`.

### 2.2 Rewrite `src/tasks.ts` — `getTaskNotificationKey`
Notification key should remain stable as long as the task ID + deadline are stable.
The current implementation is actually fine **after** stable IDs are in place:
```ts
export function getTaskNotificationKey(task: VaultTask): string {
    return `notified:${task.id}:${task.deadline?.toISOString() ?? 'no-date'}`;
}
```
No change needed here, but verify it still works with hashed IDs.

### 2.3 Add `pruneNotificationState` in `src/checker.ts`
```ts
function pruneNotificationState(
    state: NotificationState,
    currentTasks: VaultTask[],
    maxAgeMs: number = 90 * 24 * 60 * 60 * 1000
): NotificationState {
    const validIds = new Set(currentTasks.map(t => getTaskNotificationKey(t)));
    const now = Date.now();
    const pruned: Record<string, number> = {};

    for (const [key, timestamp] of Object.entries(state.notifiedTasks)) {
        if (validIds.has(key) || (now - timestamp) < maxAgeMs) {
            pruned[key] = timestamp;
        }
    }

    return { ...state, notifiedTasks: pruned };
}
```

Call `pruneNotificationState` inside `checkAndNotify` right after `scanVaultForTasks`
returns `allTasks`:
```ts
state = pruneNotificationState(state, allTasks);
```

### 2.4 Fix `lastCheck` semantics
In `src/checker.ts`:
- Remove `state.lastCheck = Date.now()` from `markAsNotified`.
- Add a single update at the **end** of `checkAndNotify` (after all sending logic):
  ```ts
  state.lastCheck = Date.now();
  ```

### 2.5 Refactor `src/tasks.ts` — `getDueTasks`
Replace the overloaded logic with two clear functions:
```ts
export function getTasksDueOnDay(tasks: VaultTask[], date: Date): VaultTask[] {
    const { startOfDay, endOfDay } = calendarDayBounds(date);
    return tasks.filter(task => {
        if (!task.deadline || task.completed) return false;
        return task.deadline >= startOfDay && task.deadline <= endOfDay;
    });
}

export function getOverdueTasks(tasks: VaultTask[], date: Date): VaultTask[] {
    const { startOfDay } = calendarDayBounds(date);
    const now = new Date();
    return tasks.filter(task => {
        if (!task.deadline || task.completed) return false;
        return task.deadline < startOfDay && task.deadline < now;
    });
}
```

Update `checkAndNotify` in `src/checker.ts` to use the new functions or keep the existing
`filterDueTasksByCheckFlags` contract if callers depend on it.

### Verification
- [ ] `npm run build` zero errors.
- [ ] Insert a blank line above an existing inline task, reload Obsidian, trigger a manual check:
      the task is **not** re-notified.
- [ ] Delete an old task from a note, trigger a check, then inspect plugin data:
      the old task's notification key is gone from `notifiedTasks`.
- [ ] `lastCheck` reflects the most recent **check run**, not the last individual task sent.

---

## Phase 3: Telegram Length Guard, CSS Scope Fix, and Startup Notice Suppression

**Goal:** Prevent API failures from long messages and stop polluting the global DOM/CSS.

### 3.1 Fix `src/telegram.ts` — `sendTelegramMessage`
No change to the API itself, but add an optional `maxLength` parameter (default 4096)
to `sendBulkReminders` and `sendTelegramMessage`.

```ts
export async function sendTelegramMessage(
    ...existing args...,
    maxLength: number = 4096
): Promise<TelegramSendResult> {
    // existing validation
    if (text.length > maxLength) {
        text = text.substring(0, maxLength - 3) + '...';
    }
    // ...rest of existing logic
}
```

Better: truncate in `sendBulkReminders` **before** calling `sendTelegramMessage` so we can
append a "... and N more tasks" line.

### 3.2 Fix `src/telegram.ts` — `sendBulkReminders`
After rendering the final message:
```ts
const MAX_LEN = 4096;
let message = renderTemplate(bulkTemplate, { count: tasks.length, tasks: taskLines.join('\n') });

if (message.length > MAX_LEN) {
    // Try to find a clean truncation point (last newline before limit)
    const truncateAt = message.lastIndexOf('\n', MAX_LEN - 20);
    const safeCut = truncateAt > 0 ? truncateAt : MAX_LEN - 20;
    // Recalculate remaining tasks from the truncated portion
    // Simpler: just cut and append ellipsis text
    message = message.substring(0, MAX_LEN - 50) + '\n... (message truncated)';
}
```

Acceptance: ensure the final string is always ≤ 4096. Use a safety margin (e.g. cut at 4040)
and append a short truncation notice.

### 3.3 Fix `styles.css` — scoped hover selector
In `main.ts`, add a specific class when creating the status bar item:
```ts
statusBarItemEl.addClass('reminder-telegram-status');
```

In `styles.css`, replace:
```css
.status-bar-item:hover {
    ...
}
```
with:
```css
.reminder-telegram-status:hover {
    ...
}
```

### 3.4 Fix startup notice spam in `src/main.ts`
In `startPeriodicChecking`, change:
```ts
void this.manualCheck();
```
to a new private method that suppresses zero-result notices:
```ts
private async silentStartupCheck(): Promise<void> {
    // Same logic as manualCheck but only show Notice if notifiedTasks > 0
}
```

Or simpler: add an optional `silent: boolean` parameter to `manualCheck`. When `silent` is true
and no reminders are sent, skip `new Notice(...)`.

### Verification
- [ ] `npm run build` zero errors.
- [ ] A bulk template with 50 tasks and long `{filePath}` values renders a message ≤ 4096 chars
      and sends successfully.
- [ ] Hovering *other* plugins' status bar items does not apply this plugin's hover style.
- [ ] Reloading Obsidian with zero due tasks does **not** show a "Checking for due tasks..." notice.
- [ ] Reloading Obsidian with due tasks still shows the "Sent N reminder(s) to Telegram" notice.

---

## Rollback / Safety Notes

- Each phase only touches a handful of files. If a bug surfaces, the change is isolated.
- Do **not** delete the old `parseFrontmatter` function until Phase 1 is fully verified
  (or keep it behind a feature-flag comment).
- Stable task IDs will invalidate existing `notifiedTasks` keys on the first run, so users
  may see a one-time batch of "duplicate" notifications for tasks they were already notified
  about. This is acceptable because it only happens once, and the old keys were unstable anyway.
  Consider a one-shot migration: delete all old keys whose ID matches the old `${path}:number`
  pattern on first load after upgrade.
