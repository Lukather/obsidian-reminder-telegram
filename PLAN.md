# Plan: 3 Highest-Leverage Improvements for Reminder Telegram

This plugin sends Telegram notifications when tasks reach deadlines. Three fundamental correctness and performance issues undermine its core value proposition.

---

## 1. Stabilize Task Identity to Eliminate Duplicate Notifications

**Problem**: Task IDs included `lineNumber` and `taskContentHash`. Any edit above a task shifted the line number; any edit to task text changed the hash. Since notification keys are `notified:${taskId}:${deadlineDate}`, these innocent edits created unseen keys and triggered re-notifications.

**Fix**: Remove `lineNumber` from the ID. Frontmatter tasks use `frontmatter:${filePath}:${deadlineDate}` (one per file). Inline tasks use `inline:${filePath}:${deadlineDate}:${contentHash}`. Editing nearby text or task wording no longer restarts the notification clock.

---

## 2. Fix Timezone-Aware Date Parsing

**Problem**: Date-only strings like `2024-12-25` were parsed as `new Date('2024-12-25')` → UTC midnight, then compared against local-time day boundaries. For non-UTC users, a task due tomorrow could appear "due today."

**Fix**: Parse `YYYY-MM-DD` into a calendar-day struct (`{year, month, day}`) with no timezone, and compare using pure calendar-day logic. Only strings with an explicit time component (`THH:MM`) become real `Date` objects. This guarantees `2024-12-25` means December 25 everywhere on Earth.

---

## 3. Replace Full-Vault Scans with Incremental Task Indexing

**Problem**: Every check interval performed a full filesystem read of every `.md` file in the vault. For large vaults this caused UI jank and battery drain.

**Fix**: Build an in-memory `Map<string, VaultTask[]>` keyed by file path. Populate it with one initial scan, then keep it current via Obsidian vault events (`create`, `modify`, `delete`, `resolve`). Periodic checks read from the Map — O(tasks) with zero disk I/O.

---

## Honorable Mentions

- **Automated test suite**: Currently zero tests. Unit tests for date parsing, task identification, and template rendering would prevent regressions.
- **Retry/backoff for Telegram failures**: A failed send leaves the task unmarked but does not distinguish retryable (network) from non-retryable (bad token) errors.
