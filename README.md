<img width="1432" height="736" alt="Obsidian_plugin" src="https://github.com/user-attachments/assets/62045f5e-c6b7-4d82-b9d6-3d254ae64e03" />

# Reminder Telegram

Obsidian plugin that sends Telegram notifications when your tasks reach their deadline. Supports date-only deadlines (checked on an interval), exact-time deadlines (precise scheduler), upcoming reminders, and recurring tasks.

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Lukather/obsidian-reminder-telegram/badge)](https://scorecard.dev/viewer/?uri=github.com/Lukather/obsidian-reminder-telegram)

## Features

- **Frontmatter + inline tasks** — YAML `scheduled`/`due` fields, `- [ ]` lines with `📅`, `due::`, `scheduled::`, `starts::`, and plain dates
- **Exact-time reminders** — Reminder-plugin `@` syntax and Kanban `@@` syntax fire at the precise minute, with configurable lead time
- **At-time scheduler** — a timer wakes up at each deadline instead of waiting for the next interval check
- **PC-off catch-up** — missed notifications (at-time, overdue, upcoming) fire when the app re-opens, within a configurable window
- **Upcoming reminders** — heads-up for tasks due in the next N days, with its own templates
- **Recurring tasks** — `🔁 every …` syntax auto-advances a completed task to its next occurrence and re-opens the checkbox
- **Telegram integration** — bulk digests or individual messages, markdown formatting, 4096-char truncation
- **Duplicate prevention** — per-task notified state persisted across sessions
- **Task sidebar** — overdue / due-today / upcoming views with time-scope and tag filters
- **Template editor UX** — clickable variable chips, character counters, live preview
- **Status bar** — click to check immediately; shows the last check time

## Installation

### From Obsidian Community Plugins

1. **Settings → Community plugins → Browse**
2. Search for "Reminder Telegram"
3. Install and enable

### Manual

1. Clone the repo or download the latest release
2. Copy `main.js`, `manifest.json`, `styles.css` into your vault's `.obsidian/plugins/obsidian-reminder-telegram/`
3. Reload Obsidian and enable the plugin

Requires Obsidian 1.7.2+ (`minAppVersion`).

## Setup

1. **Create a bot**: in Telegram, message **@BotFather**, send `/newbot`, follow the prompts, copy the token.
2. **Get your chat ID**: message **@userinfobot**, send `/start`; it replies with your numeric chat ID.
3. **Configure the plugin**: paste the token and chat ID under **Settings → Reminder Telegram**. The settings tab walks through these steps too.
4. Send a test notification via the **"Send test"** button to verify.

## Task syntax

### YAML frontmatter

A note with a `scheduled` or `due` field and `---` delimiters becomes a task. The task text is the note's base name, or the first heading after the frontmatter if one exists.

```markdown
---
status: open
scheduled: 2024-12-25
tags:
  - task
---

# My Task
Complete this task by Christmas
```

- **`status`**: `open` / `in-progress` = incomplete; `done` / `completed` / `cancelled` / `archived` = completed (a `completedDate` field also marks it done)
- **`scheduled` / `due`**: `YYYY-MM-DD` (date-only) or `YYYY-MM-DDTHH:MM` (exact time)
- **`tags`**: used for sidebar tag filtering (not required for recognition)

### Inline tasks

```markdown
- [ ] Complete project by 📅 2024-12-25
- [ ] Review notes due:: 2024-12-20
- [ ] Meeting scheduled:: 2024-12-15
```

Accepted date formats: `YYYY-MM-DD`, `MM/DD/YYYY`, `DD-MM-YYYY`, with optional times (`YYYY-MM-DDTHH:MM` or `YYYY-MM-DD HH:MM`). Lines inside fenced code blocks are ignored; `[x]`/`[X]` tasks are skipped.

### Exact-time syntax

**Reminder-plugin `@` syntax** (toggle: *Reminder syntax*):

```markdown
- [ ] Call Grandma @2026-07-22 12:30
- [ ] Call Grandma (@2026-07-22 12:30)
- [ ] Buy milk (@2026-07-22)        # no time → date-only
```

**Kanban-plugin syntax** (toggle: *Kanban syntax*):

```markdown
- [ ] Call Grandma @2026-07-22 @@14:30   # date + time
- [ ] Buy milk @2026-07-22                # no time → date-only
```

Reminder syntax owns `@YYYY-MM-DD HH:MM`; Kanban owns `@YYYY-MM-DD @@HH:MM` and bare `@YYYY-MM-DD`.

### Recurring tasks

Append `🔁 every …` to an inline task (works with any date syntax, including the full reminder form):

```markdown
- [ ] Water plants 📅 2026-07-22 🔁 every day
- [ ] Call Grandma (@2026-07-31 09:00 🔁 every week on Sunday)
- [ ] Pay rent 📅 2026-08-01 🔁 every month
- [ ] Renew license 📅 2026-07-22 🔁 every year
```

<details>
<summary>Supported patterns</summary>

| Pattern | Next occurrence |
|---|---|
| `🔁 every day` | +1 calendar day |
| `🔁 every week` | +7 days |
| `🔁 every week on Sunday` (any weekday, full or 3-letter name) | next matching weekday |
| `🔁 every month` | same day next month (e.g. Jan 31 → Feb 28 → Mar 31) |
| `🔁 every year` | same month/day next year (Feb 29 → Feb 28) |

</details>

When you complete a recurring task (`- [x]`), the plugin rewrites the line: the checkbox re-opens and the date advances to the next occurrence — task text and metadata are preserved. Overdue recurring tasks advance until the next occurrence is in the future. Toggle: *Recurring tasks* (default on).

## Notification behavior

When do notifications go out:

1. **Interval checks** — every *Check interval* minutes (default 30) and on manual triggers. Handles date-only tasks: due today, overdue, and upcoming.
2. **At-time scheduler** — datetime tasks fire at `deadline − lead time` via a precise timer, re-armed on vault changes, workspace changes, and app resume.
3. **PC-off catch-up** — on the next check after the app re-opens, missed notifications fire *if* they fall within the catch-up window; anything older is silently dropped.

**Catch-up window** (*Catch-up window (minutes)*, default 60) applies to:

- at-time tasks: fires whose scheduled time is within the window
- overdue tasks: deadline within the window (datetime tasks by exact timestamp; date-only tasks from the end of their day)
- tasks that were upcoming while the app was closed and became overdue within the window

Tasks due today are never gated. A window of `0` disables the gate and past behavior applies (all overdue tasks are always notified).

**Upcoming reminders** (*Upcoming reminders* + *Days ahead for upcoming*, default 1): tasks due in the next N days (tomorrow onward) get a heads-up with their own templates. Due/overdue notifications share the per-check budget (*Max tasks per check*).

**Strict time mode**: when enabled, datetime tasks are handled *only* by the at-time scheduler — interval checks skip them entirely (default off, so the interval stays as a safety net).

## Sidebar

Open via the **🔔 ribbon icon** or the **"Toggle sidebar"** command.

- **Overdue** — past deadline
- **Due Today**
- **Upcoming** — next N days (same *Days ahead* setting)

Filters: **today** (hide upcoming), **week** (cap upcoming at 7 days), **tag** (intersect by frontmatter tag), **clear**. Relative dates are shown (Today / Yesterday / Tue / in 3 days). Clicking a task opens the file and scrolls to the task line (or heading).

## Commands

| Command | Action |
|---|---|
| Check reminders now | Run an interval check immediately |
| Send test Telegram notification | Verify config |
| Toggle sidebar | Open/close the task sidebar |

## Message templates

Variables:

- **Digest templates** (multi-task): `{count}`, `{tasks}`
- **Individual templates**: `{taskName}`, `{fileName}`, `{deadline}`, `{filePath}`, `{taskId}`
- **Upcoming** uses its own digest + individual templates with the same variables

Bulk messages send when more than one task is due; otherwise an individual message is sent. Messages are truncated at Telegram's 4096-character limit (markdown-safe cutoff when formatting is on).

The template editor provides clickable variable chips, per-field character counters (warn at 80% of 4096), and a live preview panel with sample data (toggle: *Live preview*).

**Markdown formatting**: enable in settings for `*bold*`, `_italic_`, `` `code` ``, `[links](https://example.com)`. Literal characters the parser rejects cause Telegram to return an error — keep unescaped `*`/`_` usage minimal.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Telegram Bot Token | `''` | @BotFather |
| Telegram Chat ID | `''` | @userinfobot |
| Notifications Enabled | `true` | master switch (also gates at-time) |
| Check Interval (minutes) | `30` | interval check cadence |
| Max Tasks Per Check | `10` | due + upcoming budget per run |
| Scan Mode | `whole-vault` | or specific folder |
| Target Folder | `''` | when Scan Mode = specific folder |
| At-time Notifications | `true` | master switch for the precise scheduler |
| Reminder Syntax | `true` | recognize `@…` / `(@…)` dates |
| Kanban Syntax | `true` | recognize `@… @@HH:MM` dates |
| Recurring Tasks | `true` | recognize `🔁 every …` and auto-reschedule |
| Lead Time (minutes) | `0` | fire N minutes before the deadline (max 1440) |
| Catch-up Window (minutes) | `60` | PC-off catch-up for at-time/overdue/upcoming (max 10080) |
| Strict Time Mode | `false` | datetime tasks fire only via the scheduler |
| Upcoming Reminders | `true` | enable upcoming heads-up |
| Days Ahead for Upcoming | `1` | 0 disables |
| Upcoming Bulk Template | … | `{count}`, `{tasks}` |
| Upcoming Individual Template | … | per-task variables |
| Multi-task Digest Template | … | `{count}`, `{tasks}` |
| Individual Message Template | … | per-task variables |
| Test Message Template | … | no variables |
| Live Preview | `true` | render template previews |
| Use Markdown Formatting | `false` | Telegram markdown |

## Development

```bash
npm install
npm run dev       # watch mode
npm run build     # type-check + esbuild
npm run lint
npm test          # vitest (mocked obsidian + Telegram HTTP)
npm run test:coverage
```

## Planned

Ideas that are not implemented yet:

- **Advanced scan filters** — exclude specific folders or patterns from the scan
- **Explicit timezone handling** — per-task or per-vault timezone management for exact-time deadlines (currently local time)
- **Snooze / postpone** — inline Telegram interaction to push a task's deadline

## Contributing

Pull requests welcome — open an issue first for significant changes.

## License

BSD-0-Clause. See [LICENSE](LICENSE).