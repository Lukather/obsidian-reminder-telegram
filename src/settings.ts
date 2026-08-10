import {App, Notice, PluginSettingTab, Setting} from "obsidian";

import ReminderTelegramPlugin from "./main";
import {sendTestNotification} from "./checker";
export interface ReminderTelegramSettings {
	telegramBotToken: string;
	telegramChatId: string;
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
	/** Message template for individual upcoming tasks. */
	upcomingMessageTemplate: string;
	/** Message template for bulk upcoming tasks. */
	upcomingBulkMessageTemplate: string;
	/** Enable live preview of templates */
	livePreviewEnabled: boolean;
	/** Master switch for the at-time notification pipeline. */
	atTimeNotificationsEnabled: boolean;
	/** Minutes before a deadline to fire an at-time notification (0 = sharp). */
	leadTimeMinutes: number;
	/** Maximum delay (minutes) accepted on next app open for at-time catch-up (0 = disable). */
	atTimeCatchUpWindowMinutes: number;
	/** If true, at-time tasks bypass periodic interval checks. */
	strictTimeMode: boolean;
}

export const DEFAULT_SETTINGS: ReminderTelegramSettings = {
	telegramBotToken: '',
	telegramChatId: '',
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
	upcomingMessageTemplate: "📋 Upcoming Task\n\nTask: {taskName}\nFile: {fileName}\nDue: {deadline}",
	upcomingBulkMessageTemplate: "You have {count} upcoming task(s):\n\n{tasks}",
	livePreviewEnabled: true,
	atTimeNotificationsEnabled: true,
	leadTimeMinutes: 0,
	atTimeCatchUpWindowMinutes: 60,
	strictTimeMode: false
};

// ---------------------------------------------------------------------------
// Pure validators (issue #89 — at-time settings)
// ---------------------------------------------------------------------------
//
// These helpers keep the input/load-time validation in one place so both the
// SettingTab `onChange` handlers and `main.ts` `loadSettings()` can share
// them. Each falls back to the matching `DEFAULT_SETTINGS` value when the
// input is out of range or otherwise invalid.

/** Inclusive upper bound for `leadTimeMinutes` (24h). */
export const LEAD_TIME_MINUTES_MAX = 1440;
/** Inclusive upper bound for `atTimeCatchUpWindowMinutes` (7 days). */
export const AT_TIME_CATCH_UP_WINDOW_MAX = 10080;

/**
 * Coerce an arbitrary input (string, number, null, undefined) to a valid
 * `leadTimeMinutes` value. Returns the parsed integer when in range
 * [0, 1440], otherwise `DEFAULT_SETTINGS.leadTimeMinutes`.
 */
export function validateLeadTimeMinutes(value: unknown): number {
	const n = typeof value === 'number' ? value : parseInt(String(value), 10);
	return Number.isFinite(n) && n >= 0 && n <= LEAD_TIME_MINUTES_MAX
		? n
		: DEFAULT_SETTINGS.leadTimeMinutes;
}

/**
 * Coerce an arbitrary input to a valid `atTimeCatchUpWindowMinutes` value.
 * Returns the parsed integer when in range [0, 10080], otherwise
 * `DEFAULT_SETTINGS.atTimeCatchUpWindowMinutes`.
 */
export function validateAtTimeCatchUpWindowMinutes(value: unknown): number {
	const n = typeof value === 'number' ? value : parseInt(String(value), 10);
	return Number.isFinite(n) && n >= 0 && n <= AT_TIME_CATCH_UP_WINDOW_MAX
		? n
		: DEFAULT_SETTINGS.atTimeCatchUpWindowMinutes;
}

/** Coerce a value to a boolean; fall back to the default when non-boolean. */
export function validateAtTimeNotificationsEnabled(value: unknown): boolean {
	return typeof value === 'boolean' ? value : DEFAULT_SETTINGS.atTimeNotificationsEnabled;
}

/** Coerce a value to a boolean; fall back to the default when non-boolean. */
export function validateStrictTimeMode(value: unknown): boolean {
	return typeof value === 'boolean' ? value : DEFAULT_SETTINGS.strictTimeMode;
}

export class ReminderTelegramSettingTab extends PluginSettingTab {
	plugin: ReminderTelegramPlugin;
	private previewElements?: {
		individual: HTMLElement;
		bulk: HTMLElement;
		test: HTMLElement;
		upcomingIndividual: HTMLElement;
		upcomingBulk: HTMLElement;
	};
	private saveTimer: number | null = null;
	private readonly SAVE_DEBOUNCE_MS = 500;

	/** Debounced save for text/textarea inputs that fire onChange on every keystroke. */
	private debouncedSave(): void {
		if (this.saveTimer) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.plugin.saveSettings();
		}, this.SAVE_DEBOUNCE_MS);
	}
	constructor(app: App, plugin: ReminderTelegramPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName('Telegram')
			.setDesc('Connect this plugin to your bot and your chat.')
			.setHeading();
		this.renderTelegramSetupGuide(containerEl);
		new Setting(containerEl)
			.setName('Telegram bot token')
			.setDesc('Paste the token you get when your new bot is ready.')
			.addText(text => {
				text
					.setPlaceholder('123456789:abc-def123456789')
					.setValue(this.plugin.settings.telegramBotToken)
					.onChange(async (value): Promise<void> => {
						this.plugin.settings.telegramBotToken = value;
						this.debouncedSave();
					});
				text.inputEl.type = 'password';
			});
		new Setting(containerEl)
			.setName('Telegram chat ID')
			.setDesc('Paste the numeric chat ID userinfobot replies with.')
			.addText(text => {
				text
					.setPlaceholder('123456789')
					.setValue(this.plugin.settings.telegramChatId)
					.onChange(async (value): Promise<void> => {
						this.plugin.settings.telegramChatId = value;
						this.debouncedSave();
					});
				text.inputEl.type = 'password';
			});
		new Setting(containerEl)
			.setName('Notifications enabled')
			.setDesc('Enable or disable Telegram notifications')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.notificationsEnabled)
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.notificationsEnabled = value;
					this.debouncedSave();
				}));
		new Setting(containerEl)
			.setName('Check interval (minutes)')
			.setDesc('How often to check for due tasks')
			.addText(text => text
				.setPlaceholder('30')
				.setValue(this.plugin.settings.checkIntervalMinutes.toString())
				.onChange(async (value): Promise<void> => {
					const numValue = parseInt(value) || 30;
					this.plugin.settings.checkIntervalMinutes = numValue;
					this.debouncedSave();
				}));

		// --- At-time notifications (issue #89) -----------------------------
		new Setting(containerEl)
			.setName('At-time notifications')
			.setDesc('Fire reminders at the precise deadline of a task. Date-only tasks are unaffected; only tasks with a time component are gated by this section.')
			.setHeading();
		new Setting(containerEl)
			.setName('At-time notifications enabled')
			.setDesc('Master switch for the at-time notification pipeline.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.atTimeNotificationsEnabled)
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.atTimeNotificationsEnabled = value;
					this.debouncedSave();
				}));
		new Setting(containerEl)
			.setName('Lead time (minutes)')
			.setDesc('Minutes before the deadline to fire. 0 = sharp. Range: 0–1440 (24h).')
			.addText(text => text
				.setPlaceholder('0')
				.setValue(this.plugin.settings.leadTimeMinutes.toString())
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.leadTimeMinutes = validateLeadTimeMinutes(value);
					this.debouncedSave();
				}));
		new Setting(containerEl)
			.setName('Catch-up window (minutes)')
			.setDesc('Max delay (minutes) accepted on the next app open for an overdue at-time notification. 0 disables catch-up. Range: 0–10080 (7 days).')
			.addText(text => text
				.setPlaceholder('60')
				.setValue(this.plugin.settings.atTimeCatchUpWindowMinutes.toString())
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.atTimeCatchUpWindowMinutes = validateAtTimeCatchUpWindowMinutes(value);
					this.debouncedSave();
				}));
		new Setting(containerEl)
			.setName('Strict time mode')
			.setDesc('If on, at-time tasks bypass the periodic interval check and only fire at their scheduled time.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.strictTimeMode)
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.strictTimeMode = value;
					this.debouncedSave();
				}));
		// Small notice below the strict-mode toggle (always visible).
		// Renders as a muted paragraph so it doesn't compete visually with the toggle.
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Date-only tasks are unaffected; only at-time tasks are gated by this setting.'
		});
		// -------------------------------------------------------------------

		new Setting(containerEl)
			.setName('Max tasks per check')
			.setDesc('Maximum number of due and upcoming tasks to notify per run. Additional tasks stay queued for the next check.')
			.addText(text => text
				.setPlaceholder('10')
				.setValue(this.plugin.settings.maxTasksPerCheck.toString())
				.onChange(async (value): Promise<void> => {
					const n = parseInt(value, 10);
					this.plugin.settings.maxTasksPerCheck = Number.isFinite(n) && n >= 1 ? n : DEFAULT_SETTINGS.maxTasksPerCheck;
					this.debouncedSave();
				}));

		new Setting(containerEl)
			.setName('Upcoming reminders')
			.setDesc('Notify for tasks due after today within the days-ahead range below. Due and overdue tasks are always checked separately.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.upcomingRemindersEnabled)
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.upcomingRemindersEnabled = value;
					this.debouncedSave();
				}));

		new Setting(containerEl)
			.setName('Days ahead for upcoming')
			.setDesc('How many calendar days ahead to include (1 = tomorrow only; 0 disables upcoming even when the toggle is on).')
			.addText(text => text
				.setPlaceholder('1')
				.setValue(this.plugin.settings.upcomingRemindersDaysAhead.toString())
				.onChange(async (value): Promise<void> => {
					const n = parseInt(value, 10);
					this.plugin.settings.upcomingRemindersDaysAhead = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.upcomingRemindersDaysAhead;
					this.debouncedSave();
				}));

		// Upcoming message templates
		const upcomingBulkTemplateSetting = new Setting(containerEl)
			.setName('Upcoming bulk template')
			.setDesc('Template for multiple upcoming tasks. Variables: {count}, {tasks}. Each line in {tasks} uses the individual upcoming template below.');
		upcomingBulkTemplateSetting.settingEl.addClass('reminder-telegram-template-setting');
		upcomingBulkTemplateSetting.addTextArea(text => {
			text
				.setPlaceholder('You have {count} upcoming task(s):\n\n{tasks}')
				.setValue(this.plugin.settings.upcomingBulkMessageTemplate)
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.upcomingBulkMessageTemplate = value;
					this.debouncedSave();
					this.updateTemplatePreviews();
				});
			text.inputEl.addClass('reminder-telegram-template-textarea');
		});
		this.renderVariableChips(upcomingBulkTemplateSetting.settingEl, ['count', 'tasks']);
		this.renderCharacterCounter(upcomingBulkTemplateSetting.settingEl, this.plugin.settings.upcomingBulkMessageTemplate);

		const upcomingIndividualTemplateSetting = new Setting(containerEl)
			.setName('Upcoming individual template')
			.setDesc('Template for a single upcoming task and for each line in an upcoming bulk message. Variables: {taskName}, {fileName}, {deadline}, {filePath}, {taskId}');
		upcomingIndividualTemplateSetting.settingEl.addClass('reminder-telegram-template-setting');
		upcomingIndividualTemplateSetting.addTextArea(text => {
			text
				.setPlaceholder('📋 Upcoming Task\n\nTask: {taskName}\nFile: {fileName}\nDue: {deadline}')
				.setValue(this.plugin.settings.upcomingMessageTemplate)
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.upcomingMessageTemplate = value;
					this.debouncedSave();
					this.updateTemplatePreviews();
				});
			text.inputEl.addClass('reminder-telegram-template-textarea');
		});
		this.renderVariableChips(upcomingIndividualTemplateSetting.settingEl, ['taskName', 'fileName', 'deadline', 'filePath', 'taskId']);
		this.renderCharacterCounter(upcomingIndividualTemplateSetting.settingEl, this.plugin.settings.upcomingMessageTemplate);

		containerEl.createEl('hr');
		new Setting(containerEl)
			.setName('Scan mode')
			.setDesc('Choose whether to scan the whole vault or a specific folder')
			.addDropdown(dropdown => {
				dropdown.addOption('whole-vault', 'Whole vault');
				dropdown.addOption('specific-folder', 'Specific folder');
				dropdown.setValue(this.plugin.settings.scanMode);
				dropdown.onChange(async (value: 'whole-vault' | 'specific-folder'): Promise<void> => {
					this.plugin.settings.scanMode = value;
					this.debouncedSave();
					// `display()` is deprecated in 1.13+ in favor of `getSettingDefinitions()`,
					// but we keep the imperative form so the plugin still works on Obsidian < 1.13
					// (minAppVersion: 1.4.0).
					this.display();
				});
			});
		if (this.plugin.settings.scanMode === 'specific-folder') {
			new Setting(containerEl)
				.setName('Target folder')
				.setDesc('Path to folder to scan for tasks')
				.addText(text => text
					.setPlaceholder('Tasks')
					.setValue(this.plugin.settings.targetFolder)
					.onChange(async (value): Promise<void> => {
						this.plugin.settings.targetFolder = value;
						this.debouncedSave();
					}));
		}
		containerEl.createEl('hr');
		// Message templates
		new Setting(containerEl)
			.setName('Message templates')
			.setDesc('Customize Telegram notification messages')
			.setHeading();

		// Multi-task digest template (formerly "Bulk message template")
		const bulkTemplateSetting = new Setting(containerEl)
			.setName('Multi-task digest')
			.setDesc('Template for multiple tasks. Variables: {count}, {tasks}. Each line in {tasks} uses the individual template below.');
		bulkTemplateSetting.settingEl.addClass('reminder-telegram-template-setting');
		bulkTemplateSetting.addTextArea(text => {
			text
				.setPlaceholder('You have {count} task(s) due:\n\n{tasks}')
				.setValue(this.plugin.settings.bulkMessageTemplate)
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.bulkMessageTemplate = value;
					this.debouncedSave();
					this.updateTemplatePreviews();
				});
			text.inputEl.addClass('reminder-telegram-template-textarea');
		});
		this.renderVariableChips(bulkTemplateSetting.settingEl, ['count', 'tasks']);
		this.renderCharacterCounter(bulkTemplateSetting.settingEl, this.plugin.settings.bulkMessageTemplate);

		// Individual message template
		const individualTemplateSetting = new Setting(containerEl)
			.setName('Individual message template')
			.setDesc('Template for a single task and for each line in a bulk message. Variables: {taskName}, {fileName}, {deadline}, {filePath}, {taskId}');
		individualTemplateSetting.settingEl.addClass('reminder-telegram-template-setting');
		individualTemplateSetting.addTextArea(text => {
			text
				.setPlaceholder('Task Reminder\n\nTask: {taskName}\nFile: {fileName}\nDeadline: {deadline}')
				.setValue(this.plugin.settings.individualMessageTemplate)
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.individualMessageTemplate = value;
					this.debouncedSave();
					this.updateTemplatePreviews();
				});
			text.inputEl.addClass('reminder-telegram-template-textarea');
		});
		this.renderVariableChips(individualTemplateSetting.settingEl, ['taskName', 'fileName', 'deadline', 'filePath', 'taskId']);
		this.renderCharacterCounter(individualTemplateSetting.settingEl, this.plugin.settings.individualMessageTemplate);

		// Test message template with textarea and preview
		const testTemplateSetting = new Setting(containerEl)
			.setName('Test message template')
			.setDesc('Template for test notifications. Variables: none (raw text).');
		testTemplateSetting.settingEl.addClass('reminder-telegram-template-setting');
		testTemplateSetting.addTextArea(text => {
			text
				.setPlaceholder('Test notification from reminder Telegram plugin')
				.setValue(this.plugin.settings.testMessageTemplate)
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.testMessageTemplate = value;
					this.debouncedSave();
					this.updateTemplatePreviews();
				});
			text.inputEl.addClass('reminder-telegram-template-textarea');
		});
		this.renderCharacterCounter(testTemplateSetting.settingEl, this.plugin.settings.testMessageTemplate);

		// Live preview toggle
		new Setting(containerEl)
			.setName('Live preview')
			.setDesc('Show real-time preview of notification templates')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.livePreviewEnabled)
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.livePreviewEnabled = value;
					this.debouncedSave();
					this.updateTemplatePreviews();
				}));

		// Markdown formatting with example
		const markdownSetting = new Setting(containerEl)
			.setName('Use Markdown formatting')
			.setDesc('Enable Telegram Markdown formatting for messages. Example: *bold*, _italic_, [links](https://example.com)');
		markdownSetting.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useMarkdownFormatting)
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.useMarkdownFormatting = value;
					this.debouncedSave();
					this.updateTemplatePreviews();
				}));

		// Preview panel
		this.renderPreviewPanel(containerEl);
		containerEl.createEl('hr');
		new Setting(containerEl)
			.setName('Test notification')
			.setDesc('Send a test message to verify your settings')
			.addButton(button => button
				.setButtonText('Send test')
				.onClick(async (): Promise<void> => {
					await this.sendTestNotification();
				}));
	}

	private renderTelegramSetupGuide(container: HTMLElement): void {
		const wrap = container.createDiv({ cls: 'reminder-telegram-setup-guide' });
		wrap.createDiv({
			cls: 'reminder-telegram-setup-guide-intro',
			text: 'Follow these steps once to obtain the values below.'
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
			text: 'Follow the prompts to name your bot, then copy the bot token.'
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

	private async sendTestNotification(): Promise<void> {
		if (!this.plugin.settings.telegramBotToken || !this.plugin.settings.telegramChatId) {
			new Notice('Please configure Telegram bot token and chat ID first');
			return;
		}
		new Notice('Sending test notification...');
		const result = await sendTestNotification(
			this.plugin.settings.telegramBotToken,
			this.plugin.settings.telegramChatId,
			this.plugin.settings.testMessageTemplate,
			this.plugin.settings.useMarkdownFormatting
		);
		if (result.success) {
			new Notice('Test notification sent successfully!');
		} else {
			new Notice(`Failed to send test: ${result.error}`);
		}
	}

	/**
	 * Renders clickable variable chips that insert variables into the textarea
	 */
	private renderVariableChips(container: HTMLElement, variables: string[]): void {
		const chipsContainer = container.createDiv({cls: 'reminder-telegram-variable-chips'});
		variables.forEach(variable => {
			const chip = chipsContainer.createEl('button', {
				cls: 'reminder-telegram-variable-chip',
				text: `{${variable}}`
			});
			chip.onclick = () => {
				const textarea = container.querySelector('textarea.reminder-telegram-template-textarea');
				if (textarea instanceof HTMLTextAreaElement) {
					const start = textarea.selectionStart;
					const end = textarea.selectionEnd;
					const value = textarea.value;
					textarea.value = value.substring(0, start) + `{${variable}}` + value.substring(end);
					textarea.selectionStart = textarea.selectionEnd = start + `{${variable}}`.length;
					textarea.focus();
					
					// Trigger change event
					const event = new Event('change', {bubbles: true});
					textarea.dispatchEvent(event);
				}
			};
		});
	}

	/**
	 * Renders character counter for template fields
	 */
	private renderCharacterCounter(container: HTMLElement, template: string): void {
		const counterContainer = container.createDiv({cls: 'reminder-telegram-character-counter'});
		const counter = counterContainer.createSpan({cls: 'reminder-telegram-character-count'});
		const textarea = container.querySelector('textarea.reminder-telegram-template-textarea');

		const updateCounter = () => {
			if (textarea instanceof HTMLTextAreaElement) {
				const length = textarea.value.length;
				const maxLength = 4096; // Telegram message limit
				const percentage = Math.min(100, Math.round((length / maxLength) * 100));

				counter.textContent = `${length}/${maxLength} characters (${percentage}%)`;

				// Add warning class if approaching limit
				if (percentage >= 80) {
					counterContainer.addClass('reminder-telegram-character-warning');
				} else {
					counterContainer.removeClass('reminder-telegram-character-warning');
				}
			}
		};

		// Initial update
		updateCounter();

		// Update on input
		if (textarea) {
			textarea.addEventListener('input', updateCounter);
			textarea.addEventListener('change', updateCounter);
		}
	}

	/**
	 * Renders template preview panel
	 */
	private renderPreviewPanel(container: HTMLElement): void {
		const previewContainer = container.createDiv({cls: 'reminder-telegram-preview-container'});
		
		// Preview header
		const header = previewContainer.createDiv({cls: 'reminder-telegram-preview-header'});
		header.createSpan({cls: 'reminder-telegram-preview-title', text: 'Preview'});
		
		// Individual template preview
		const individualPreview = previewContainer.createDiv({cls: 'reminder-telegram-preview-section'});
		individualPreview.createSpan({cls: 'reminder-telegram-preview-label', text: 'Individual task:'});
		const individualPreviewContent = individualPreview.createDiv({cls: 'reminder-telegram-preview-content'});
		individualPreviewContent.createSpan({cls: 'reminder-telegram-preview-placeholder', text: 'Preview will appear here when enabled'});
		
		// Bulk template preview
		const bulkPreview = previewContainer.createDiv({cls: 'reminder-telegram-preview-section'});
		bulkPreview.createSpan({cls: 'reminder-telegram-preview-label', text: 'Multi-task digest:'});
		const bulkPreviewContent = bulkPreview.createDiv({cls: 'reminder-telegram-preview-content'});
		bulkPreviewContent.createSpan({cls: 'reminder-telegram-preview-placeholder', text: 'Preview will appear here when enabled'});
		
		// Test template preview
		const testPreview = previewContainer.createDiv({cls: 'reminder-telegram-preview-section'});
		testPreview.createSpan({cls: 'reminder-telegram-preview-label', text: 'Test notification:'});
		const testPreviewContent = testPreview.createDiv({cls: 'reminder-telegram-preview-content'});
		testPreviewContent.createSpan({cls: 'reminder-telegram-preview-placeholder', text: 'Preview will appear here when enabled'});

		// Upcoming individual template preview
		const upcomingIndividualPreview = previewContainer.createDiv({cls: 'reminder-telegram-preview-section'});
		upcomingIndividualPreview.createSpan({cls: 'reminder-telegram-preview-label', text: 'Upcoming individual:'});
		const upcomingIndividualPreviewContent = upcomingIndividualPreview.createDiv({cls: 'reminder-telegram-preview-content'});
		upcomingIndividualPreviewContent.createSpan({cls: 'reminder-telegram-preview-placeholder', text: 'Preview will appear here when enabled'});

		// Upcoming bulk template preview
		const upcomingBulkPreview = previewContainer.createDiv({cls: 'reminder-telegram-preview-section'});
		upcomingBulkPreview.createSpan({cls: 'reminder-telegram-preview-label', text: 'Upcoming bulk:'});
		const upcomingBulkPreviewContent = upcomingBulkPreview.createDiv({cls: 'reminder-telegram-preview-content'});
		upcomingBulkPreviewContent.createSpan({cls: 'reminder-telegram-preview-placeholder', text: 'Preview will appear here when enabled'});

		// Store references for updates
		this.previewElements = {
			individual: individualPreviewContent,
			bulk: bulkPreviewContent,
			test: testPreviewContent,
			upcomingIndividual: upcomingIndividualPreviewContent,
			upcomingBulk: upcomingBulkPreviewContent
		};
		
		// Initial update
		this.updateTemplatePreviews();
	}

	/**
	 * Updates all template previews
	 */
	private updateTemplatePreviews(): void {
		if (!this.plugin.settings.livePreviewEnabled || !this.previewElements) {
			return;
		}
		
		const elements = this.previewElements;
		
		// Individual template preview
		try {
			const individualPreview = this.renderTemplatePreview(
				this.plugin.settings.individualMessageTemplate,
				{
					taskName: 'Finish project report',
					fileName: 'Project.md',
					deadline: '2024-12-31',
					filePath: 'Work/Project.md',
					taskId: 'Work/Project.md:42'
				}
			);
			elements.individual.empty();
			elements.individual.createDiv({text: individualPreview});
		} catch (error) {
			console.error('Error rendering individual preview:', error);
			elements.individual.empty();
			elements.individual.createSpan({cls: 'reminder-telegram-preview-error', text: 'Error rendering preview'});
		}
		
		// Bulk template preview
		try {
			const taskLines = [
				'Task: Finish project report (2024-12-31) - Project.md',
				'Task: Review code changes (2024-12-28) - Code.md'
			];
			const bulkPreview = this.renderTemplatePreview(
				this.plugin.settings.bulkMessageTemplate,
				{
					count: 2,
					tasks: taskLines.join('\n')
				}
			);
			elements.bulk.empty();
			elements.bulk.createDiv({text: bulkPreview});
		} catch (error) {
			console.error('Error rendering bulk preview:', error);
			elements.bulk.empty();
			elements.bulk.createSpan({cls: 'reminder-telegram-preview-error', text: 'Error rendering preview'});
		}
		
		// Test template preview
		try {
			elements.test.empty();
			elements.test.createDiv({text: this.plugin.settings.testMessageTemplate});
		} catch (error) {
			console.error('Error rendering test preview:', error);
			elements.test.empty();
			elements.test.createSpan({cls: 'reminder-telegram-preview-error', text: 'Error rendering preview'});
		}

		// Upcoming individual template preview
		try {
			const upcomingIndividualPreview = this.renderTemplatePreview(
				this.plugin.settings.upcomingMessageTemplate,
				{
					taskName: 'Buy groceries',
					fileName: 'Shopping.md',
					deadline: '2024-12-25',
					filePath: 'Lists/Shopping.md',
					taskId: 'Lists/Shopping.md:10'
				}
			);
			elements.upcomingIndividual.empty();
			elements.upcomingIndividual.createDiv({text: upcomingIndividualPreview});
		} catch (error) {
			console.error('Error rendering upcoming individual preview:', error);
			elements.upcomingIndividual.empty();
			elements.upcomingIndividual.createSpan({cls: 'reminder-telegram-preview-error', text: 'Error rendering preview'});
		}

		// Upcoming bulk template preview
		try {
			const upcomingTaskLines = [
				'Task: Buy groceries (2024-12-25) - Shopping.md',
				'Task: Prepare slides (2024-12-26) - Presentation.md'
			];
			const upcomingBulkPreview = this.renderTemplatePreview(
				this.plugin.settings.upcomingBulkMessageTemplate,
				{
					count: 2,
					tasks: upcomingTaskLines.join('\n')
				}
			);
			elements.upcomingBulk.empty();
			elements.upcomingBulk.createDiv({text: upcomingBulkPreview});
		} catch (error) {
			console.error('Error rendering upcoming bulk preview:', error);
			elements.upcomingBulk.empty();
			elements.upcomingBulk.createSpan({cls: 'reminder-telegram-preview-error', text: 'Error rendering preview'});
		}
	}

	/**
	 * Simple template rendering for preview
	 */
	private renderTemplatePreview(template: string, variables: Record<string, string | number>): string {
		return template.replace(/\{(\w+)\}/g, (match, varName) => {
			const value = variables[varName as keyof typeof variables];
			return value !== undefined ? String(value) : match;
		});
	}
}
