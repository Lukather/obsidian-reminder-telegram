# PRD: Dedicated Sidebar View for Reminder Telegram

## Problem Statement

Reminder Telegram is currently an "out of sight, out of mind" plugin. Users configure it once and rely on passive Telegram notifications, but they have no way to see *which tasks are being tracked*, *what's coming up*, or *what's overdue* without manually scanning their vault. There is no centralized view of task status — users cannot glance at their workspace and understand their deadline landscape. This limits the plugin's utility as a daily task-management companion and forces users to maintain parallel task views (e.g., a dedicated "Tasks" query or daily note) to stay aware.

## Solution

Add a custom Obsidian sidebar panel (an `ItemView`) that provides a live, always-visible dashboard of tracked tasks. The sidebar shows three fixed sections — **Overdue**, **Due Today**, and **Upcoming** — with quick filters (Today / Week / Tag) to scope the view. Clicking any task opens its source file and scrolls to the relevant line or heading. The sidebar content stays synchronized with vault changes via the existing incremental `TaskIndex`.

## User Stories

1. As an Obsidian user, I want a persistent sidebar showing my due and upcoming tasks, so that I can stay aware of deadlines without actively searching my vault.
2. As a user with many tracked tasks, I want tasks grouped by urgency (Overdue / Today / Upcoming), so that I can prioritize my attention.
3. As a user who uses frontmatter tags, I want to filter the sidebar by tag, so that I can focus on tasks belonging to a specific project or context.
4. As a user planning my week, I want to switch the sidebar to "Week" view, so that I can see everything due in the next 7 days at a glance.
5. As a user who keeps long notes, I want clicking a task in the sidebar to open the file and jump directly to where that task lives, so that I don't waste time scrolling.
6. As a user editing files, I want the sidebar to update automatically when I add, modify, or delete tasks, so that it always reflects reality.
7. As a mobile Obsidian user, I want the sidebar to work on mobile, so that I can check my tasks on the go.
8. As a user who disabled upcoming Telegram notifications, I want the sidebar to still respect my `upcomingRemindersDaysAhead` setting, so that the dashboard matches my notification preferences.
9. As a user with the sidebar open, I want the view to not freeze or stutter while I type in the editor, so that Obsidian remains responsive.
10. As a user who just installed the plugin, I want to be able to open the sidebar via a ribbon icon, so that I can discover the feature without memorizing a command.
11. As a keyboard-oriented user, I want a command palette entry to toggle the sidebar, so that I can open and close it without using the mouse.
12. As a user with overdue tasks, I want them to be visually emphasized (e.g., with a warning indicator), so that they don't get buried.
13. As a user with upcoming tasks, I want to see how many days remain until each deadline, so that I can plan accordingly.
14. As a user who works across multiple vaults, I want the sidebar to be empty or hidden when no tasks are tracked, so that I'm not confused by blank or irrelevant content.
15. As a user who completed a task, I want it to disappear from the sidebar immediately, so that I don't accidentally click on a done task.
16. As a plugin developer, I want the sidebar to be decoupled from the `TaskIndex` internals, so that future index changes don't break the view.
17. As a user who toggles the "Show completed tasks" setting (if added later), I want the sidebar to respond, so that it reflects the same scope as other plugin features.
18. As a user with hundreds of tasks, I want the sidebar to remain performant, so that it doesn't slow down Obsidian startup or switching.
19. As a user, I want the sidebar to match Obsidian's native look and feel, so that it doesn't feel like an alien UI element.
20. As a user who uses the"Week" filter and also has the "Today" filter, I want these to be mutually exclusive scope selectors, so that I don't accidentally filter to nothing.

## Implementation Decisions

### Module: Sidebar View (`ReminderTelegramSidebarView`)

- A new Obsidian `ItemView` subclass registered under a custom view type (e.g., `reminder-telegram-sidebar`).
- The view requests task data from the plugin via a well-defined interface — it never accesses `TaskIndex` directly.
- The plugin maintains a registry of active sidebar views and notifies them when the task index changes.
- Debounced refresh: vault events trigger a 400ms debounce before re-querying tasks and re-rendering. This prevents UI thrashing during active editing.

### Module: View-to-Plugin Interface

- The main plugin class exposes:
  - `getTasksForSidebar(): VaultTask[]` — returns all indexed tasks.
  - `registerSidebarView(view: ReminderTelegramSidebarView): void` — called by the view on mount.
  - `unregisterSidebarView(view: ReminderTelegramSidebarView): void` — called on unmount.
- When `TaskIndex` updates via vault events, the plugin iterates registered views and calls their `refresh()` method.
- This decouples the view from `TaskIndex` internals and from hardcoded plugin IDs.

### Task Struct Extension

- `VaultTask` gains two optional fields:
  - `tags: string[]` — populated from frontmatter `tags` only (inline hashtag parsing is out of scope).
  - `headingLineNumber?: number` — for frontmatter tasks, the line of the first heading found after frontmatter (used for scroll-to-heading).
- `VaultTask.lineNumber` already exists for inline tasks and is used for scroll-to-line.
- `parseFrontmatterTasksFromCache` is updated to extract and store `headingLineNumber`.

### Sidebar Layout

- Three fixed sections rendered in priority order: **Overdue** → **Due Today** → **Upcoming**.
- Each section is a scrollable list of task rows.
- Sections that have zero tasks are collapsed or show a minimal "No tasks" placeholder.
- **Quick filters** (Today / Week / Tag) are rendered as toggle buttons in the sidebar header.
  - "Today" = hide Upcoming section; show Overdue and Due Today.
  - "Week" = limit Upcoming section to tasks within the next 7 days; Overdue and Due Today remain unchanged.
  - "Tag" = show a dropdown of all frontmatter tags found across tasks; intersects the current scope.
  - Filters are additive constraints, not view replacements.
  - A "Clear filters" button resets to default (all sections, all tags).
- The "Upcoming" section uses the existing `upcomingRemindersDaysAhead` setting (shared with Telegram notifications).

### Task Row Display (V1)

- Each row shows:
  - **Primary text**: `task.text` (truncated if very long).
  - **Secondary text**: `fileName` (basename only), displayed in muted color.
  - **Right edge**: relative date indicator (e.g., "Today", "Yesterday", "Tue", "in 3 days").
- Overdue rows get a subtle visual emphasis (e.g., orange/red tint or ⚠️ indicator).
- Rows are clickable; click opens the file via `app.workspace.openLinkText()` and scrolls to:
  - Inline tasks: `lineNumber`.
  - Frontmatter tasks: `headingLineNumber` (falls back to line 1).
- Rows are **read-only** in V1 — no inline checkboxes, no context menu actions.

### Filtering Pipeline

```
allTasks (from TaskIndex)
  → timeScopeFilter (Today / Week / none)
  → tagFilter (tag dropdown / none)
  → categorize: Overdue / Due Today / Upcoming
  → render grouped sections
```

### Ribbon and Commands

- A left-ribbon icon (e.g., 🔔 or 📋) toggles the sidebar open/closed.
- A command palette entry "Toggle Reminder Telegram sidebar" is registered for keyboard access.
- No auto-open on startup for V1. Obsidian natively remembers leaf positions per workspace.

### Styling

- All sidebar CSS uses a plugin-specific prefix (e.g., `.reminder-telegram-sidebar-`) to avoid conflicts.
- Styling aims to match Obsidian's native `FileExplorer` and `Backlinks` panel aesthetic (muted text, clear hierarchy, native list spacing).
- No external CSS libraries; all styles are in `styles.css`.

### Data Flow

```
Vault events (create/modify/delete/resolve)
  → TaskIndex.updateFile() / removeFile()
  → Plugin.notifySidebarViews()
  → SidebarView.refresh() (debounced 400ms)
  → Plugin.getTasksForSidebar()
  → Sidebar filters & renders
```

## Testing Decisions

- **What makes a good test**: Tests assert external behavior — given a set of tasks, the sidebar categorizes and filters them correctly. Tests do not assert DOM structure or implementation details like debounce timing.
- **Modules to test**:
  - `task-index.ts` (already implicitly tested via integration, but add unit tests for `headingLineNumber` extraction).
  - New filtering/categorization utility (extracted as a pure function): given `VaultTask[]`, settings, and active filters, return `{overdue: VaultTask[], dueToday: VaultTask[], upcoming: VaultTask[]}`.
  - New relative-date formatting utility.
- **Prior art**: No existing tests in the codebase. This PRD establishes the first testable utility modules.

## Out of Scope

- **Snooze feature**: No user action to postpone a task. Tasks appear in their natural deadline category.
- **Inline completion**: No checkbox toggle or "Mark done" button in the sidebar. Users must edit the source file.
- **Inline hashtag parsing**: Tag filter uses frontmatter `tags` only.
- **Auto-open sidebar on startup**: Workspace persistence is handled by Obsidian natively.
- **Customizable sidebar upcoming window**: Uses the shared `upcomingRemindersDaysAhead` setting.
- **Search / text filtering**: No free-text search within the sidebar.
- **Sorting options**: Tasks render in natural order (by deadline, then by file path).
- **Bulk actions**: No "select all" or multi-select in V1.

## Further Notes

- The existing `TaskIndex` is the critical enabler of this feature — it already provides O(1) access to all tasks without disk I/O. The sidebar is essentially a reactive UI layer on top of this index.
- Future iterations could add: inline task completion, sort controls, free-text search, pinned tasks, or a "focus mode" that hides completed sections.
- Consider adding a small task counter badge on the ribbon icon (overdue count) in a future iteration.
- The view ID should be prefixed with the plugin ID to avoid collisions: `reminder-telegram-sidebar`.
