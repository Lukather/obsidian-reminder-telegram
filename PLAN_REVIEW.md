# Plan Review: Discrepancies & Clarifications

## Executive Summary

The plan targets three real reliability issues (frontmatter time stripping, task tag validation, and notification key stability). However, **several plan sections describe fixes for code that has already been partially addressed** in the current codebase, while other areas introduce new ambiguities. Below is a phase-by-phase analysis of where the plan aligns with current code, where it diverges, and what needs clarification.

---

## Phase 1: Frontmatter, Tags, and Time-Aware Deadlines

### ✅ Already Implemented
- **`scanVaultForTasks` already uses `metadataCache.getFileCache`** — it calls `parseFrontmatterTasksFromCache(frontmatter, content, file.path)` (line ~297 in `src/tasks.ts`).
- **`parseFrontmatterTasksFromCache` exists** with frontmatter-to-task conversion logic, but it currently lacks the `task` tag check.

### ⚠️ Divergence / Issues

| Plan Item | Current Code Reality |
|-----------|---------------------|
| Remove `parseFrontmatter(content)` entirely | Still used in `scanVaultForTasks` to determine `startLine` for inline task scanning (line ~301). Cannot delete until inline parsing knows where frontmatter ends without re-parsing. |
| Use `metadataCache.getFileCache(file)?.sections` for frontmatter boundary | Obsidian's `CachedMetadata.sections` contains structural sections (headings, code blocks, etc.), but accessing the frontmatter end line through it is not straightforward. The plan assumes `.sections` exposes frontmatter length, which is not guaranteed in the current Obsidian API. A simpler `content.split('\n')` frontmatter-end scan might still be needed. |
| `parseFrontmatterTasks` signature change | The current function is `parseFrontmatterTasksFromCache(frontmatter, content, filePath)`. The plan wants `parseFrontmatterTasks(frontmatter, filePath, content, endLine)`. This is a minor refactor, but the function name and signature need alignment. |
| Check `tags` includes `'task'` or `'#task'` | **Not implemented.** `parseFrontmatterTasksFromCache` currently treats ANY frontmatter note with `scheduled`/`due` as a task. Adding tag validation is a breaking change for users who use frontmatter deadlines without explicit task tags. |

### 🔴 Potential Bugs Not In Plan
- `parseDate` uses `dateString.replace(/[T+].*$/, '')` which **strips time AND timezone info**. The plan says to preserve time, but the current regex also erases `+00:00` offsets, which could cause subtle timezone bugs even after the fix.
- Frontmatter array parsing in `parseFrontmatter()` is fragile: it assumes single-line YAML values and its array continuation logic is custom-built. Since `metadataCache` already parses YAML, the custom `parseFrontmatter()` should ideally be removed entirely.

### ❓ Questions for Phase 1
1. **Tag validation scope:** Should tag validation be case-insensitive? Should `tags: task` (string) also match, or only array form `tags: [task]`?
2. **Breaking change:** Adding mandatory `task` tag filtering will hide previously detected frontmatter tasks for users who don't tag their notes. Should this be opt-in via a setting, or is a hard behavior change acceptable?
3. **Timezone behavior:** When parsing `2024-12-25T14:30`, should the resulting Date be in local time or UTC? The plan mentions midnight local time for date-only inputs but doesn't specify for ISO datetimes.

---

## Phase 2: Stabilize Task Identity & Cap Notification State

### ✅ Already Implemented
- **Inline task IDs already include a content hash** — current format: `${filePath}:${lineNumber}:${taskContentHash}`. Line number changes still alter the ID (which the plan wants to fix), but hash collisions causing false duplicates are already mitigated.
- **`getTaskNotificationKey` already exists** and uses the task ID + deadline date.
- **`pruneNotificationState` already exists** in `src/checker.ts` with a 30-day / 1000-key limit strategy.
- **`calendarDayBounds`, `taskDeadlineOnCalendarDay`, `taskDeadlineOverdueBeforeDay`, and `filterDueTasksByCheckFlags` already exist** — the utilities for splitting today's tasks from overdue are already present.

### ⚠️ Divergence / Issues

| Plan Item | Current Code Reality |
|-----------|---------------------|
| Remove `lineNumber` from inline task `id` | Current ID: `${filePath}:${lineNumber}:${taskContentHash}`. Plan proposes `${filePath}:${hash}` where hash covers text+deadline. This means two identical text+deadline tasks in the **same file** would get the same ID, causing one to be silently dropped from notifications. Is that acceptable? |
| `pruneNotificationState` rewrite | Current implementation prunes by age (>30 days) and count (>1000 keys). Plan proposes pruning by "valid current task IDs + max age." The current approach is arguably safer because it doesn't require knowing valid IDs (in case `scanVaultForTasks` fails). |
| Move `lastCheck` out of `markAsNotified` | Currently `markAsNotified` sets `state.lastCheck = Date.now()`. The plan wants a single update at end of `checkAndNotify`. This means if multiple tasks are notified and then sending fails mid-batch, `lastCheck` would still update. Is that intentional? |
| Replace `getDueTasks` with `getTasksDueOnDay` + `getOverdueTasks` | `getDueTasks` combines "today" and "overdue" into one list. `checkAndNotify` already uses `filterDueTasksByCheckFlags` to further split them. Refactoring into two functions is a code style change. |

### 🔴 Migration Concern
The plan notes:
> "Stable task IDs will invalidate existing `notifiedTasks` keys on the first run, so users may see a one-time batch of duplicate notifications."

But the current inline IDs **already contain a hash**, so existing `notifiedTasks` keys will likely NOT be invalidated for unchanged tasks (line number is part of the key but unchanged). The duplicate-notification risk mainly applies to frontmatter tasks whose ID format changed from something else to the hash-based format. Is there a previous ID format the plan is referencing?

### ❓ Questions for Phase 2
4. **Duplicate task identity:** If a user has two identical task lines in the same file with the same deadline (e.g., copy-paste error), should they share one ID? The current code keeps them distinct via `lineNumber`; the plan removes that.
5. **`lastCheck` semantics:** Should `lastCheck` represent "when we last successfully started a check" or "when we last sent at least one notification"? The plan implies the former, which risks masking sending failures.
6. **Pruning strategy:** Do you want to keep the current "time + count" pruning, or switch to the plan's "valid task ID reference" approach? The current approach is more defensive against scan failures.

---

## Phase 3: Telegram Length Guard, CSS Scope, and Startup Notices

### ✅ Already Implemented
- **`ensureMessageLength` already exists** in `src/telegram.ts` (max 4096, with Markdown-aware truncation). The plan seems unaware of this.
- **CSS is already scoped** — `styles.css` uses `.status-bar-item.reminder-telegram-status-bar:hover` and `main.ts` adds `reminder-telegram-status-bar` class. There is NO unscoped `.status-bar-item:hover` selector.

### ⚠️ Divergence / Issues

| Plan Item | Current Code Reality |
|-----------|---------------------|
| Add `maxLength` parameter to `sendTelegramMessage` | `sendTelegramMessage` delegates to `ensureMessageLength` internally. Bulk-specific truncation logic would need to live in `sendBulkReminders` to include a "... and N more tasks" suffix, which is a valid gap. |
| CSS scope fix | Already done. No change needed unless the plan refers to a different selector. |
| Startup notice suppression | `startPeriodicChecking` calls `void this.manualCheck()` without showing "Checking for due tasks...". That notice only appears from the command palette or status bar click. If zero tasks, `checkDeadlines` shows no notice. **What exact notice is bothering the user at startup?** |

### 🔴 Gaps Not In Plan
- `sendBulkReminders` truncates the full message but doesn't intelligently truncate task lines or report omitted tasks. If 50 tasks with long file paths exceed 4096 characters, `ensureMessageLength` will just cut off mid-task. The plan's truncation logic for adding "... (message truncated)" is a real improvement.
- `startPeriodicChecking` immediately runs a check on load. If the user has 10+ tasks due, they get an immediate burst of Telegram messages + a Notice. The plan's "silent startup check" concept is unclear because `manualCheck` already doesn't show "Checking..." — it only shows "Sent N reminder(s)..." when there are tasks.

### ❓ Questions for Phase 3
7. **Startup notice:** Is the observed startup notice "Checking for due tasks..." or "Sent N reminder(s) to Telegram"? If it's the latter, do you want to suppress it specifically during the startup auto-check while keeping it for manual checks?
8. **Bulk truncation behavior:** When a bulk message is too long, would you prefer (a) truncate with ellipsis and lose some tasks silently, or (b) count how many tasks fit and append "... and 12 more tasks"?

---

## Overall Assessment

### Recommended Plan Adjustments

1. **Phase 1:**
   - Drop the plan to use `metadataCache.sections` for frontmatter boundary detection; instead keep a lightweight `content.startsWith('---')` scan or use Obsidian's `frontmatterPosition` if exposed.
   - Decide whether tag validation should be mandatory or behind a setting.
   - Clarify timezone handling for datetime strings.

2. **Phase 2:**
   - Verify whether current inline task IDs are actually unstable enough to warrant a format change (they already contain content hash).
   - Prefer keeping `lineNumber` in the ID or use a composite of `filePath + heading + hash` to avoid duplicate-task collision.
   - Keep the existing `pruneNotificationState` or blend it with the plan's approach rather than replacing entirely.

3. **Phase 3:**
   - Skip the CSS fix (already scoped).
   - Focus `sendBulkReminders` truncation on intelligently counting task lines instead of simple string truncation.
   - Clarify what "startup notice" means before writing the suppression logic.

### Files Actually Requiring Changes

| File | Changes |
|------|---------|
| `src/tasks.ts` | Fix `parseDate` time stripping, add tag validation to `parseFrontmatterTasksFromCache`, remove/refactor `parseFrontmatter` and `formatFrontmatterForOriginalLine` |
| `src/checker.ts` | Move `lastCheck` update to end of `checkAndNotify`, refine `pruneNotificationState` if desired |
| `src/telegram.ts` | Add smart truncation to `sendBulkReminders` |
| `src/main.ts` | Clarify startup notice suppression (may be no-op) |

---

*Reviewed against codebase at version 1.0.6.*
