# Obsidian Reminder Telegram

Send Telegram notifications for your Obsidian tasks when they reach their deadline.

## Features

- **YAML Frontmatter Support**: Parses tasks from markdown files with YAML frontmatter
- **Inline Task Support**: Also supports traditional Obsidian task format (`- [ ] Task 📅 2024-01-01`)
- **Flexible Scan Modes**: Scan entire vault or specific folders
- **Telegram Integration**: Sends notifications via Telegram Bot API
- **Configurable Intervals**: Check for due tasks at customizable intervals
- **Bulk Notifications**: Receive multiple task reminders in a single message
- **Duplicate Prevention**: Avoids sending duplicate notifications for the same task

## Installation

### From Obsidian Community Plugins

1. Go to **Settings → Community plugins → Browse**
2. Search for "Reminder Telegram"
3. Install and enable the plugin

### Manual Installation

1. Clone this repository or download the latest release
2. Copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/obsidian-reminder-telegram/` folder
3. Reload Obsidian and enable the plugin in **Settings → Community plugins**

## Usage

### Setting Up Telegram

1. **Create a Telegram Bot**:
   - Open Telegram and search for **@BotFather**
   - Send `/newbot` command
   - Follow instructions to name your bot and get the **Bot Token**

2. **Get Your Chat ID**:
   - Open Telegram and search for **@userinfobot**
   - Send `/start` command
   - It will reply with your **Chat ID**

3. **Configure the Plugin**:
   - Go to **Settings → Reminder Telegram**
   - Enter your **Telegram Bot Token**
   - Enter your **Telegram Chat ID**
   - Enable **Notifications**
   - Set your preferred **Check Interval** (default: 30 minutes)

### Task Formats Supported

#### YAML Frontmatter (Recommended)

Create markdown files with YAML frontmatter:

```markdown
---
status: open
priority: normal
scheduled: 2024-12-25
tags:
  - task
---

# My Task
Complete this task by Christmas
```

**Supported Frontmatter Fields:**
- `status`: `open`, `done`, `in-progress`, `completed`, `cancelled`, `archived`
- `scheduled`: Deadline date (ISO format: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`)
- `due`: Alternative deadline field
- `tags`: Array of tags (must include `task` or `#task` to be recognized)
- `completedDate`: If set, task is considered completed

#### Inline Tasks

Traditional Obsidian task format within any markdown file:

```markdown
- [ ] Complete project by 📅 2024-12-25
- [ ] Review notes due:: 2024-12-20
- [ ] Meeting scheduled:: 2024-12-15
```

**Supported Date Formats:**
- `📅 YYYY-MM-DD`
- `due:: YYYY-MM-DD`
- `scheduled:: YYYY-MM-DD`
- `starts:: YYYY-MM-DD`
- Plain dates: `YYYY-MM-DD`, `MM/DD/YYYY`, `DD-MM-YYYY`

### Scan Configuration

Choose what to scan:

1. **Whole Vault** (default): Scans all markdown files in your entire vault
2. **Specific Folder**: Scans only files in a specified folder

To use a specific folder:
- Set **Scan Mode** to "Specific Folder"
- Enter the folder path (e.g., `Tasks` or `Meta/TaskNotes/Tasks`)

### Commands

- **Check reminders now**: Manually trigger a deadline check
- **Send test Telegram notification**: Verify your Telegram configuration

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Telegram Bot Token | string | `''` | Bot token from @BotFather |
| Telegram Chat ID | string | `''` | Your chat ID for notifications |
| Notifications Enabled | boolean | `true` | Enable/disable notifications |
| Check Interval (minutes) | number | `30` | How often to check for due tasks |
| Scan Mode | dropdown | `whole-vault` | Scan entire vault or specific folder |
| Target Folder | string | `''` | Folder to scan (when Scan Mode is "Specific Folder") |

## Notification Content

### Bulk Notification (Multiple Tasks)
```
⏰ You have X task(s) due:

• Task 1 (2024-01-01) - file1.md
• Task 2 (2024-01-02) - file2.md
```

### Individual Notification
```
⏰ Task Reminder

📝 Task name
📁 File name
📅 Deadline
```

### Test Notification
```
✅ Reminder Telegram plugin is working!

This is a test notification from your Obsidian vault.
```

## When Notifications Are Sent

1. **On startup**: If periodic checking is enabled
2. **On interval**: Every N minutes (configurable)
3. **Manual trigger**: Via command palette or status bar

Notifications are sent for tasks that are:
- Due today
- Overdue (past deadline)

Completed tasks (`status: done` or `[x]`) are skipped.

## Development

### Prerequisites

- Node.js 18+
- npm

### Install Dependencies
```bash
npm install
```

### Development Mode (Watch)
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

## Contributing

Pull requests are welcome! Please open an issue first for significant changes.

## License

This plugin is licensed under the 0-BSD License. See [LICENSE](LICENSE) for details.

## Credits

- Inspired by the Obsidian Tasks plugin
- Built with Obsidian Plugin API
