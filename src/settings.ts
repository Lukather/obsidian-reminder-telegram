import {App, Notice, PluginSettingTab, Setting, SettingDefinitionItem} from "obsidian";

import ReminderTelegramPlugin, {getTelegramToken, getTelegramChatId} from "./main";
import {sendTestNotification as sendTelegramTest} from "./checker";

/**
 * IDs used to store secrets via Obsidian's SecretStorage (1.11.4+).
 * Storing these here keeps a single literal-typed source of truth so the
 * plugin, settings tab, and any migration code all agree.
 */
export const SECRET_IDS = {
	telegramBotToken: 'telegramBotToken',
	telegramChatId: 'telegramChatId',
} as const;

export type SecretId = typeof SECRET_IDS[keyof typeof SECRET_IDS];

export interface ReminderTelegramSettings {
	notificationsEnabled: boolean;
	checkIntervalMinutes: number;
	scanMode: 'whole-vault' | 'specific-folder';
	targetFolder: string;
	bulkMessageTemplate: string;
	individualMessageTemplate: string;
	testMessageTemplate: string;
	useMarkdownFormatting: boolean;
	/** Maximum due tasks to notify per check run (minimum 1). */
	maxTasksPerCheck: number;
	/** Number of days ahead to check for upcoming tasks (0 to disable). */
	upcomingRemindersDaysAhead: number;
	/** Enable notifications for upcoming tasks. */
	upcomingRemindersEnabled: boolean;
	/** Enable live preview of templates */
	livePreviewEnabled: boolean;
}

export const DEFAULT_SETTINGS: ReminderTelegramSettings = {
	notificationsEnabled: true,
	checkIntervalMinutes: 30,
	scanMode: 'whole-vault',
	targetFolder: '',
	bulkMessageTemplate: "You have {count} task(s) due:\n\n{tasks}",
	individualMessageTemplate: "Task Reminder\n\nTask: {taskName}\nFile: {fileName}\nDeadline: {deadline}",
	testMessageTemplate: "Test notification from reminder Telegram plugin",
	useMarkdownFormatting: false,
	maxTasksPerCheck: 10,
	upcomingRemindersDaysAhead: 1,
	upcomingRemindersEnabled: true,
	livePreviewEnabled: true
};

/** Type alias for the settings keys; used as the generic for SettingDefinitionItem. */
type SettingKey = keyof ReminderTelegramSettings;

const TELEGRAM_MAX_LENGTH = 4096; // Telegram message size cap

export class ReminderTelegramSettingTab extends PluginSettingTab {
	plugin: ReminderTelegramPlugin;

	constructor(app: App, plugin: ReminderTelegramPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Returns the declarative definition list rendered by Obsidian (1.13+).
	 *
	 * - `control` entries auto-save to `this.plugin.settings` on change.
	 * - `render` entries get a fully-built `Setting` row plus the parent
	 *   `SettingGroup`; they MUST save manually when they mutate state.
	 * - `action` rows are clickable buttons; they too must save manually.
	 */
	getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
		return [
			// ─── Telegram section ───────────────────────────────────────
			{
				type: 'group',
				heading: 'Telegram',
				items: [
					{
						name: 'Setup guide',
						desc: 'How to obtain a bot token and chat ID.',
						render: (s) => this.renderTelegramSetupGuide(s.settingEl),
					},
					{
						name: 'Telegram bot token',
						desc: 'Paste the token you get when your new bot is ready.',
						render: (s) => this.renderSecretField(s, SECRET_IDS.telegramBotToken, '123456789:abc-def123456789'),
					},
					{
						name: 'Telegram chat ID',
						desc: 'Paste the numeric chat ID userinfobot replies with.',
						render: (s) => this.renderSecretField(s, SECRET_IDS.telegramChatId, '123456789'),
					},
					{
						name: 'Notifications enabled',
						desc: 'Enable or disable Telegram notifications',
						control: { type: 'toggle', key: 'notificationsEnabled' },
					},
				],
			},

			// ─── Schedule section ───────────────────────────────────────
			{
				type: 'group',
				heading: 'Schedule',
				items: [
					{
						name: 'Check interval (minutes)',
						desc: 'How often to check for due tasks',
						control: {
							type: 'number',
							key: 'checkIntervalMinutes',
							min: 1,
							step: 1,
							defaultValue: DEFAULT_SETTINGS.checkIntervalMinutes,
							validate: validatePositiveInt,
						},
					},
					{
						name: 'Max tasks per check',
						desc: 'Maximum number of due and upcoming tasks to notify per run. Additional tasks stay queued for the next check.',
						control: {
							type: 'number',
							key: 'maxTasksPerCheck',
							min: 1,
							step: 1,
							defaultValue: DEFAULT_SETTINGS.maxTasksPerCheck,
							validate: validatePositiveInt,
						},
					},
					{
						name: 'Upcoming reminders',
						desc: 'Notify for tasks due after today within the days-ahead range below. Due and overdue tasks are always checked separately.',
						control: { type: 'toggle', key: 'upcomingRemindersEnabled' },
					},
					{
						name: 'Days ahead for upcoming',
						desc: 'How many calendar days ahead to include (1 = tomorrow only; 0 disables upcoming even when the toggle is on).',
						control: {
							type: 'number',
							key: 'upcomingRemindersDaysAhead',
							min: 0,
							step: 1,
							defaultValue: DEFAULT_SETTINGS.upcomingRemindersDaysAhead,
							validate: validateNonNegativeInt,
						},
					},
				],
			},

			// ─── Scan section ───────────────────────────────────────────
			{
				type: 'group',
				heading: 'Scan',
				items: [
					{
						name: 'Scan mode',
						desc: 'Choose whether to scan the whole vault or a specific folder',
						control: {
							type: 'dropdown',
							key: 'scanMode',
							options: { 'whole-vault': 'Whole vault', 'specific-folder': 'Specific folder' },
							defaultValue: DEFAULT_SETTINGS.scanMode,
						},
					},
					{
						name: 'Target folder',
						desc: 'Path to folder to scan for tasks',
						control: { type: 'text', key: 'targetFolder', placeholder: 'Tasks' },
						visible: () => this.plugin.settings.scanMode === 'specific-folder',
					},
				],
			},

			// ─── Templates section ──────────────────────────────────────
			{
				type: 'group',
				heading: 'Message templates',
				items: [
					{
						name: 'Multi-task digest',
						desc: 'Template for multiple tasks. Variables: {count}, {tasks}. Each line in {tasks} uses the individual template below.',
						control: {
							type: 'textarea',
							key: 'bulkMessageTemplate',
							placeholder: DEFAULT_SETTINGS.bulkMessageTemplate,
							defaultValue: DEFAULT_SETTINGS.bulkMessageTemplate,
						},
					},
					{
						name: 'Variables',
						desc: 'Click a chip to insert it at the cursor.',
						render: (s, g) => this.renderVariableChips(s.settingEl, g.listEl, ['count', 'tasks']),
					},
					{
						name: 'Character count',
						desc: 'Telegram message length limit (4096).',
						render: (s, g) => this.renderCharacterCounter(s.settingEl, g.listEl),
					},
					{
						name: 'Individual message template',
						desc: 'Template for a single task and for each line in a bulk message. Variables: {taskName}, {fileName}, {deadline}, {filePath}, {taskId}',
						control: {
							type: 'textarea',
							key: 'individualMessageTemplate',
							placeholder: DEFAULT_SETTINGS.individualMessageTemplate,
							defaultValue: DEFAULT_SETTINGS.individualMessageTemplate,
						},
					},
					{
						name: 'Variables',
						desc: 'Click a chip to insert it at the cursor.',
						render: (s, g) => this.renderVariableChips(s.settingEl, g.listEl, ['taskName', 'fileName', 'deadline', 'filePath', 'taskId']),
					},
					{
						name: 'Character count',
						desc: 'Telegram message length limit (4096).',
						render: (s, g) => this.renderCharacterCounter(s.settingEl, g.listEl),
					},
					{
						name: 'Test message template',
						desc: 'Template for test notifications. Variables: none (raw text).',
						control: {
							type: 'textarea',
							key: 'testMessageTemplate',
							placeholder: DEFAULT_SETTINGS.testMessageTemplate,
							defaultValue: DEFAULT_SETTINGS.testMessageTemplate,
						},
					},
					{
						name: 'Character count',
						desc: 'Telegram message length limit (4096).',
						render: (s, g) => this.renderCharacterCounter(s.settingEl, g.listEl),
					},
					{
						name: 'Live preview',
						desc: 'Show real-time preview of notification templates',
						control: { type: 'toggle', key: 'livePreviewEnabled' },
					},
					{
						name: 'Use Markdown formatting',
						desc: 'Enable Telegram Markdown formatting for messages. Example: *bold*, _italic_, [links](https://example.com)',
						control: { type: 'toggle', key: 'useMarkdownFormatting' },
					},
					{
						name: 'Preview',
						desc: 'Live rendering of each template with sample data.',
						render: (s, g) => this.renderPreviewPanel(s.settingEl, g.listEl),
						visible: () => this.plugin.settings.livePreviewEnabled,
					},
				],
			},

			// ─── Test section ───────────────────────────────────────────
			{
				name: 'Test notification',
				desc: 'Send a test message to verify your settings',
				action: () => void this.sendTestNotification(),
			},
		];
	}

	// ─── Render helpers (called by `render` definitions above) ────────────

	/**
	 * Renders a password-masked text input bound to a SecretStorage id.
	 * We do NOT use a `control` because the framework's auto-save targets
	 * `this.plugin.settings`, not the secret storage.
	 */
	private renderSecretField(setting: Setting, secretId: string, placeholder: string): void {
		const initial = this.plugin.app.secretStorage.getSecret(secretId) ?? '';
		setting.addText(text => {
			text.setPlaceholder(placeholder).setValue(initial);
			text.inputEl.type = 'password';
			text.onChange((value) => {
				if (value) {
					this.plugin.app.secretStorage.setSecret(secretId, value);
				}
			});
		});
	}

	private renderTelegramSetupGuide(container: HTMLElement): void {
		const wrap = container.createDiv({ cls: 'reminder-telegram-setup-guide' });
		wrap.createDiv({
			cls: 'reminder-telegram-setup-guide-intro',
			text: 'Follow these steps once to obtain the values below.',
		});

		const botSection = wrap.createDiv({ cls: 'reminder-telegram-setup-guide-section' });
		botSection.createDiv({ cls: 'reminder-telegram-setup-guide-heading', text: 'Create a Telegram bot' });
		const botSteps = botSection.createEl('ol', { cls: 'reminder-telegram-setup-guide-list' });
		const botLi1 = botSteps.createEl('li');
		botLi1.append(container.ownerDocument.createTextNode('Open Telegram and search for '));
		const botFatherLink = botLi1.createEl('a', { text: '@botfather', href: 'https://t.me/botfather' });
		botFatherLink.setAttr('target', '_blank');
		botFatherLink.setAttr('rel', 'noopener noreferrer');
		const botLi2 = botSteps.createEl('li');
		botLi2.append(container.ownerDocument.createTextNode('Send the '));
		botLi2.createEl('code', { text: '/newbot' });
		botLi2.append(container.ownerDocument.createTextNode(' command.'));
		botSteps.createEl('li', {
			text: 'Follow the prompts to name your bot, then copy the bot token.',
		});

		const chatSection = wrap.createDiv({ cls: 'reminder-telegram-setup-guide-section' });
		chatSection.createDiv({ cls: 'reminder-telegram-setup-guide-heading', text: 'Get your chat ID' });
		const chatSteps = chatSection.createEl('ol', { cls: 'reminder-telegram-setup-guide-list' });
		const chatLi1 = chatSteps.createEl('li');
		chatLi1.append(container.ownerDocument.createTextNode('Open Telegram and search for '));
		const userInfoLink = chatLi1.createEl('a', { text: '@userinfobot', href: 'https://t.me/userinfobot' });
		userInfoLink.setAttr('target', '_blank');
		userInfoLink.setAttr('rel', 'noopener noreferrer');
		const chatLi2 = chatSteps.createEl('li');
		chatLi2.append(container.ownerDocument.createTextNode('Send the '));
		chatLi2.createEl('code', { text: '/start' });
		chatLi2.append(container.ownerDocument.createTextNode(' command.'));
		chatSteps.createEl('li', { text: 'The bot replies with your chat ID.' });
	}

	/**
	 * Renders clickable variable chips that insert a `{varname}` token at the
	 * cursor of the nearest preceding `reminder-telegram-template-textarea`
	 * within the same group. Dispatches a `change` event so the framework
	 * auto-saves the mutated value.
	 */
	private renderVariableChips(container: HTMLElement, groupEl: HTMLElement, variables: string[]): void {
		const chipsContainer = container.createDiv({ cls: 'reminder-telegram-variable-chips' });
		variables.forEach(variable => {
			const chip = chipsContainer.createEl('button', {
				cls: 'reminder-telegram-variable-chip',
				text: `{${variable}}`,
			});
			chip.onclick = () => {
				const textarea = groupEl.querySelector('textarea.reminder-telegram-template-textarea');
				if (!(textarea instanceof HTMLTextAreaElement)) return;
				const start = textarea.selectionStart;
				const end = textarea.selectionEnd;
				const value = textarea.value;
				textarea.value = value.substring(0, start) + `{${variable}}` + value.substring(end);
				textarea.selectionStart = textarea.selectionEnd = start + `{${variable}}`.length;
				textarea.focus();
				textarea.dispatchEvent(new Event('change', { bubbles: true }));
			};
		});
	}

	/**
	 * Renders a character counter that observes the nearest preceding
	 * `reminder-telegram-template-textarea` within the same group.
	 */
	private renderCharacterCounter(container: HTMLElement, groupEl: HTMLElement): void {
		const counterContainer = container.createDiv({ cls: 'reminder-telegram-character-counter' });
		const counter = counterContainer.createSpan({ cls: 'reminder-telegram-character-count' });
		const textarea = groupEl.querySelector('textarea.reminder-telegram-template-textarea');

		const updateCounter = (): void => {
			if (!(textarea instanceof HTMLTextAreaElement)) return;
			const length = textarea.value.length;
			const percentage = Math.min(100, Math.round((length / TELEGRAM_MAX_LENGTH) * 100));
			counter.textContent = `${length}/${TELEGRAM_MAX_LENGTH} characters (${percentage}%)`;
			if (percentage >= 80) {
				counterContainer.addClass('reminder-telegram-character-warning');
			} else {
				counterContainer.removeClass('reminder-telegram-character-warning');
			}
		};

		updateCounter();
		if (textarea) {
			textarea.addEventListener('input', updateCounter);
			textarea.addEventListener('change', updateCounter);
		}
	}

	/**
	 * Renders a three-section preview panel (individual / bulk / test).
	 * Observes the three `reminder-telegram-template-textarea` instances
	 * within the group; updates on input. Reads initial state from
	 * `this.plugin.settings` for the first render.
	 */
	private renderPreviewPanel(container: HTMLElement, groupEl: HTMLElement): void {
		const previewContainer = container.createDiv({ cls: 'reminder-telegram-preview-container' });

		const header = previewContainer.createDiv({ cls: 'reminder-telegram-preview-header' });
		header.createSpan({ cls: 'reminder-telegram-preview-title', text: 'Preview' });

		const sections = [
			{ label: 'Individual task:', key: 'individualMessageTemplate' as const },
			{ label: 'Multi-task digest:', key: 'bulkMessageTemplate' as const },
			{ label: 'Test notification:', key: 'testMessageTemplate' as const },
		];
		const contentEls: HTMLElement[] = [];
		sections.forEach(({ label }) => {
			const section = previewContainer.createDiv({ cls: 'reminder-telegram-preview-section' });
			section.createSpan({ cls: 'reminder-telegram-preview-label', text: label });
			contentEls.push(section.createDiv({ cls: 'reminder-telegram-preview-content' }));
		});

		// Cache of last-rendered preview to avoid spurious DOM thrash
		const sampleVars: Record<string, string | number> = {
			taskName: 'Finish project report',
			fileName: 'Project.md',
			deadline: '2024-12-31',
			filePath: 'Work/Project.md',
			taskId: 'Work/Project.md:42',
			count: 2,
			tasks: 'Task: Finish project report (2024-12-31) - Project.md\nTask: Review code changes (2024-12-28) - Code.md',
		};

		const updateAll = (): void => {
			sections.forEach((section, idx) => {
				const el = contentEls[idx];
				if (!el) return;
				el.empty();
				try {
					const value = this.plugin.settings[section.key];
					const rendered = section.key === 'testMessageTemplate'
						? value
						: this.renderTemplatePreview(value, sampleVars);
					el.createDiv({ text: rendered });
				} catch (error) {
					console.error('Error rendering preview:', error);
					el.createSpan({ cls: 'reminder-telegram-preview-error', text: 'Error rendering preview' });
				}
			});
		};

		updateAll();
		// Re-render on any textarea input within the group
		groupEl.addEventListener('input', updateAll);
	}

	/**
	 * Simple template rendering for preview. Mirrors the previous implementation.
	 */
	private renderTemplatePreview(template: string, variables: Record<string, string | number>): string {
		return template.replace(/\{(\w+)\}/g, (match, varName: string) => {
			const value = variables[varName];
			return value !== undefined ? String(value) : match;
		});
	}

	private async sendTestNotification(): Promise<void> {
		const token = getTelegramToken(this.plugin);
		const chatId = getTelegramChatId(this.plugin);
		if (!token || !chatId) {
			new Notice('Please configure Telegram bot token and chat ID first');
			return;
		}
		new Notice('Sending test notification...');
		const result = await sendTelegramTest(
			token,
			chatId,
			this.plugin.settings.testMessageTemplate,
			this.plugin.settings.useMarkdownFormatting,
		);
		if (result.success) {
			new Notice('Test notification sent successfully!');
		} else {
			new Notice(`Failed to send test: ${result.error}`);
		}
	}
}

// ─── Module-level validation helpers ──────────────────────────────────────

/** Accept integers ≥ 1. Returns an error message string or undefined for valid. */
function validatePositiveInt(value: number): string | undefined {
	if (!Number.isFinite(value) || !Number.isInteger(value)) return 'Enter a whole number.';
	if (value < 1) return 'Must be at least 1.';
	return undefined;
}

/** Accept integers ≥ 0. Returns an error message string or undefined for valid. */
function validateNonNegativeInt(value: number): string | undefined {
	if (!Number.isFinite(value) || !Number.isInteger(value)) return 'Enter a whole number.';
	if (value < 0) return 'Must be 0 or greater.';
	return undefined;
}

