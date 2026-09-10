import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type { SettingDefinitionControl, SettingDefinitionItem } from 'obsidian';

import ReminderTelegramPlugin from './main';
import { sendTestNotification } from './checker';
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
	/** Maximum delay (minutes) accepted on next app open for a missed notification (0 = disable). Applies to at-time, overdue, and missed upcoming tasks. */
	atTimeCatchUpWindowMinutes: number;
	/** If true, at-time tasks bypass periodic interval checks. */
	strictTimeMode: boolean;
	/** Recognize Reminder-plugin inline syntax (`@YYYY-MM-DD HH:MM`, `(@YYYY-MM-DD HH:MM)`, `(@YYYY-MM-DD)`). */
	reminderSyntaxEnabled: boolean;
	/** Recognize Kanban-plugin inline syntax (`@YYYY-MM-DD` date-only, `@YYYY-MM-DD @@HH:MM` datetime). */
	kanbanSyntaxEnabled: boolean;
	/** Recognize recurring-task syntax (`🔁 every …`) and auto-reschedule on completion. */
	recurringTasksEnabled: boolean;
}

export const DEFAULT_SETTINGS: ReminderTelegramSettings = {
	telegramBotToken: '',
	telegramChatId: '',
	notificationsEnabled: true,
	checkIntervalMinutes: 30,
	scanMode: 'whole-vault',
	targetFolder: '',
	bulkMessageTemplate: 'You have {count} task(s) due:\n\n{tasks}',
	individualMessageTemplate:
		'Task Reminder\n\nTask: {taskName}\nFile: {fileName}\nDeadline: {deadline}',
	testMessageTemplate: 'Test notification from reminder Telegram plugin',
	useMarkdownFormatting: false,
	maxTasksPerCheck: 10,
	upcomingRemindersDaysAhead: 1,
	upcomingRemindersEnabled: true,
	upcomingMessageTemplate:
		'📋 Upcoming Task\n\nTask: {taskName}\nFile: {fileName}\nDue: {deadline}',
	upcomingBulkMessageTemplate:
		'You have {count} upcoming task(s):\n\n{tasks}',
	livePreviewEnabled: true,
	atTimeNotificationsEnabled: true,
	leadTimeMinutes: 0,
	atTimeCatchUpWindowMinutes: 60,
	strictTimeMode: false,
	reminderSyntaxEnabled: true,
	kanbanSyntaxEnabled: true,
	recurringTasksEnabled: true,
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
	return typeof value === 'boolean'
		? value
		: DEFAULT_SETTINGS.atTimeNotificationsEnabled;
}

/** Coerce a value to a boolean; fall back to the default when non-boolean. */
export function validateStrictTimeMode(value: unknown): boolean {
	return typeof value === 'boolean' ? value : DEFAULT_SETTINGS.strictTimeMode;
}

/** Coerce a value to a boolean; fall back to the default when non-boolean. */
export function validateReminderSyntaxEnabled(value: unknown): boolean {
	return typeof value === 'boolean'
		? value
		: DEFAULT_SETTINGS.reminderSyntaxEnabled;
}

/** Coerce a value to a boolean; fall back to the default when non-boolean. */
export function validateKanbanSyntaxEnabled(value: unknown): boolean {
	return typeof value === 'boolean'
		? value
		: DEFAULT_SETTINGS.kanbanSyntaxEnabled;
}

/** Coerce a value to a boolean; fall back to the default when non-boolean. */
export function validateRecurringTasksEnabled(value: unknown): boolean {
	return typeof value === 'boolean'
		? value
		: DEFAULT_SETTINGS.recurringTasksEnabled;
}

export class ReminderTelegramSettingTab extends PluginSettingTab {
	plugin: ReminderTelegramPlugin;
	private saveTimer: number | null = null;
	private readonly SAVE_DEBOUNCE_MS = 500;
	/** Legacy (<1.13) handle to the target-folder row, toggled by scan-mode changes. */
	private legacyFolderRowEl: HTMLElement | null = null;
	/** Root of the live-preview panel (re-created per render — survives re-renders). */
	private previewRootEl: HTMLElement | null = null;

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

	// -----------------------------------------------------------------------
	// Declarative settings model — the single source of truth for the tab.
	//
	// Renderers:
	//   • getSettingDefinitions()  — Obsidian ≥ 1.13 renders this natively.
	//   • display()                — Obsidian < 1.13 renders the same model
	//                                imperatively (see renderDefinitionLegacy).
	// Keeping both means the plugin still works on Obsidian 1.7.2+ (the
	// declared minAppVersion) while adopting the modern declarative API.
	// -----------------------------------------------------------------------

	override getSettingDefinitions(): SettingDefinitionItem[] {
		return this.buildDefinitions();
	}

	/** Legacy renderer for Obsidian < 1.13 (minAppVersion 1.7.2). */

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.legacyFolderRowEl = null;
		for (const item of this.buildDefinitions()) {
			this.renderDefinitionLegacy(containerEl, item);
		}
	}

	/** Reads a key-bound control's value from plugin settings. */
	override getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[
			key
		];
	}

	/**
	 * Persists a key-bound control's value and applies side effects.
	 * Shared by the 1.13+ framework binding and the legacy renderer.
	 */
	override setControlValue(
		key: string,
		value: unknown,
	): void | Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] =
			value;
		void this.plugin.saveSettings();
		if (key === 'scanMode') {
			// 1.13+: re-render so `visible` conditions (target-folder row) re-evaluate.
			const updateFn = (this as unknown as Record<string, unknown>)[
				'update'
			];
			if (typeof updateFn === 'function') {
				(updateFn as () => void)();
			}
			// <1.13: toggle the already-rendered folder row in place.
			if (this.legacyFolderRowEl) {
				this.legacyFolderRowEl.style.display =
					value === 'specific-folder' ? '' : 'none';
			}
		} else if (
			key === 'livePreviewEnabled' ||
			key === 'useMarkdownFormatting'
		) {
			this.updateTemplatePreviews();
		}
	}

	/**
	 * Build the declarative settings model. Rows that need imperative
	 * control (password inputs, numeric coercion, template textareas with
	 * chips/counters, guide, previews, buttons) use `render` definitions;
	 * everything else uses key-bound controls.
	 */
	private buildDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		return [
			{
				type: 'group',
				heading: 'Telegram',
				items: [
					{
						name: 'Telegram setup guide',
						searchable: false,
						render: (setting) =>
							this.renderTelegramSetupGuide(setting.settingEl),
					},
					{
						name: 'Telegram bot token',
						desc: 'Paste the token you get when your new bot is ready.',
						render: (setting) => {
							setting.addText((text) => {
								text.setPlaceholder(
									'123456789:abc-def123456789',
								)
									.setValue(settings.telegramBotToken)
									.onChange(async (value): Promise<void> => {
										settings.telegramBotToken = value;
										this.debouncedSave();
									});
								text.inputEl.type = 'password';
							});
						},
					},
					{
						name: 'Telegram chat ID',
						desc: 'Paste the numeric chat ID userinfobot replies with.',
						render: (setting) => {
							setting.addText((text) => {
								text.setPlaceholder('123456789')
									.setValue(settings.telegramChatId)
									.onChange(async (value): Promise<void> => {
										settings.telegramChatId = value;
										this.debouncedSave();
									});
								text.inputEl.type = 'password';
							});
						},
					},
					{
						name: 'Notifications enabled',
						desc: 'Enable or disable Telegram notifications',
						control: {
							type: 'toggle',
							key: 'notificationsEnabled',
						},
					},
					{
						name: 'Check interval (minutes)',
						desc: 'How often to check for due tasks',
						render: (setting) => {
							setting.addText((text) =>
								text
									.setPlaceholder('30')
									.setValue(
										settings.checkIntervalMinutes.toString(),
									)
									.onChange(async (value): Promise<void> => {
										const numValue = parseInt(value) || 30;
										settings.checkIntervalMinutes =
											numValue;
										this.debouncedSave();
									}),
							);
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'At-time notifications',
				items: [
					{
						name: 'At-time notifications enabled',
						desc: 'Master switch for the at-time notification pipeline.',
						control: {
							type: 'toggle',
							key: 'atTimeNotificationsEnabled',
						},
					},
					{
						name: 'Reminder syntax',
						desc: 'Recognize plugin syntax for at-time reminders: @2026-07-22 12:30, (@2026-07-22 12:30), (@2026-07-22).',
						control: {
							type: 'toggle',
							key: 'reminderSyntaxEnabled',
						},
					},
					{
						name: 'Kanban syntax',
						desc: 'Recognize plugin syntax for due dates: @2026-07-22 (date), @2026-07-22 @@14:30 (date + time).',
						control: { type: 'toggle', key: 'kanbanSyntaxEnabled' },
					},
					{
						name: 'Lead time (minutes)',
						desc: 'Minutes before the deadline to fire. 0 = sharp. Range: 0–1440 (24h).',
						render: (setting) => {
							setting.addText((text) =>
								text
									.setPlaceholder('0')
									.setValue(
										settings.leadTimeMinutes.toString(),
									)
									.onChange(async (value): Promise<void> => {
										settings.leadTimeMinutes =
											validateLeadTimeMinutes(value);
										this.debouncedSave();
									}),
							);
						},
					},
					{
						name: 'Catch-up window (minutes)',
						desc: 'Max delay (minutes) accepted on the next app open for a missed notification — at-time tasks, overdue tasks, and tasks that were upcoming while the app was closed. Older tasks are silently dropped. 0 disables catch-up. Range: 0–10080 (7 days).',
						render: (setting) => {
							setting.addText((text) =>
								text
									.setPlaceholder('60')
									.setValue(
										settings.atTimeCatchUpWindowMinutes.toString(),
									)
									.onChange(async (value): Promise<void> => {
										settings.atTimeCatchUpWindowMinutes =
											validateAtTimeCatchUpWindowMinutes(
												value,
											);
										this.debouncedSave();
									}),
							);
						},
					},
					{
						name: 'Strict time mode',
						desc: 'If on, at-time tasks bypass the periodic interval check and only fire at their scheduled time.',
						control: { type: 'toggle', key: 'strictTimeMode' },
					},
					// Small notice below the strict-mode toggle (always visible).
					// Renders as a muted paragraph so it doesn't compete visually with the toggle.
					{
						name: 'Strict time notice',
						searchable: false,
						render: (setting) => {
							setting.settingEl.createEl('p', {
								cls: 'setting-item-description',
								text: 'Date-only tasks are unaffected; only at-time tasks are gated by this setting.',
							});
						},
					},
					{
						name: 'Max tasks per check',
						desc: 'Maximum number of due and upcoming tasks to notify per run. Additional tasks stay queued for the next check.',
						render: (setting) => {
							setting.addText((text) =>
								text
									.setPlaceholder('10')
									.setValue(
										settings.maxTasksPerCheck.toString(),
									)
									.onChange(async (value): Promise<void> => {
										const n = parseInt(value, 10);
										settings.maxTasksPerCheck =
											Number.isFinite(n) && n >= 1
												? n
												: DEFAULT_SETTINGS.maxTasksPerCheck;
										this.debouncedSave();
									}),
							);
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Recurring tasks',
				items: [
					{
						name: 'Recurring tasks',
						desc: 'When on, completing a task with 🔁 every … syntax (e.g. "🔁 every day", "🔁 every week on Sunday") reschedules it to its next occurrence and re-opens the checkbox.',
						control: {
							type: 'toggle',
							key: 'recurringTasksEnabled',
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Upcoming reminders',
				items: [
					{
						name: 'Upcoming reminders',
						desc: 'Notify for tasks due after today within the days-ahead range below. Due and overdue tasks are always checked separately.',
						control: {
							type: 'toggle',
							key: 'upcomingRemindersEnabled',
						},
					},
					{
						name: 'Days ahead for upcoming',
						desc: 'How many calendar days ahead to include (1 = tomorrow only; 0 disables upcoming even when the toggle is on).',
						render: (setting) => {
							setting.addText((text) =>
								text
									.setPlaceholder('1')
									.setValue(
										settings.upcomingRemindersDaysAhead.toString(),
									)
									.onChange(async (value): Promise<void> => {
										const n = parseInt(value, 10);
										settings.upcomingRemindersDaysAhead =
											Number.isFinite(n) && n >= 0
												? n
												: DEFAULT_SETTINGS.upcomingRemindersDaysAhead;
										this.debouncedSave();
									}),
							);
						},
					},
					{
						name: 'Upcoming bulk template',
						desc: 'Template for multiple upcoming tasks. Variables: {count}, {tasks}. Each line in {tasks} uses the individual upcoming template below.',
						render: (setting) => {
							setting.settingEl.addClass(
								'reminder-telegram-template-setting',
							);
							setting.addTextArea((text) => {
								text.setPlaceholder(
									'You have {count} upcoming task(s):\n\n{tasks}',
								)
									.setValue(
										settings.upcomingBulkMessageTemplate,
									)
									.onChange(async (value): Promise<void> => {
										settings.upcomingBulkMessageTemplate =
											value;
										this.debouncedSave();
										this.updateTemplatePreviews();
									});
								text.inputEl.addClass(
									'reminder-telegram-template-textarea',
								);
							});
							this.renderVariableChips(setting.settingEl, [
								'count',
								'tasks',
							]);
							this.renderCharacterCounter(
								setting.settingEl,
								settings.upcomingBulkMessageTemplate,
							);
						},
					},
					{
						name: 'Upcoming individual template',
						desc: 'Template for a single upcoming task and for each line in an upcoming bulk message. Variables: {taskName}, {fileName}, {deadline}, {filePath}, {taskId}',
						render: (setting) => {
							setting.settingEl.addClass(
								'reminder-telegram-template-setting',
							);
							setting.addTextArea((text) => {
								text.setPlaceholder(
									'📋 Upcoming Task\n\nTask: {taskName}\nFile: {fileName}\nDue: {deadline}',
								)
									.setValue(settings.upcomingMessageTemplate)
									.onChange(async (value): Promise<void> => {
										settings.upcomingMessageTemplate =
											value;
										this.debouncedSave();
										this.updateTemplatePreviews();
									});
								text.inputEl.addClass(
									'reminder-telegram-template-textarea',
								);
							});
							this.renderVariableChips(setting.settingEl, [
								'taskName',
								'fileName',
								'deadline',
								'filePath',
								'taskId',
							]);
							this.renderCharacterCounter(
								setting.settingEl,
								settings.upcomingMessageTemplate,
							);
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Scanning',
				items: [
					{
						name: 'Scan mode',
						desc: 'Choose whether to scan the whole vault or a specific folder',
						control: {
							type: 'dropdown',
							key: 'scanMode',
							options: {
								'whole-vault': 'Whole vault',
								'specific-folder': 'Specific folder',
							},
						},
					},
					{
						name: 'Target folder',
						desc: 'Path to folder to scan for tasks',
						visible: () =>
							this.plugin.settings.scanMode === 'specific-folder',
						control: {
							type: 'text',
							key: 'targetFolder',
							placeholder: 'Tasks',
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Message templates',
				items: [
					{
						name: 'Multi-task digest',
						desc: 'Template for multiple tasks. Variables: {count}, {tasks}. Each line in {tasks} uses the individual template below.',
						render: (setting) => {
							setting.settingEl.addClass(
								'reminder-telegram-template-setting',
							);
							setting.addTextArea((text) => {
								text.setPlaceholder(
									'You have {count} task(s) due:\n\n{tasks}',
								)
									.setValue(settings.bulkMessageTemplate)
									.onChange(async (value): Promise<void> => {
										settings.bulkMessageTemplate = value;
										this.debouncedSave();
										this.updateTemplatePreviews();
									});
								text.inputEl.addClass(
									'reminder-telegram-template-textarea',
								);
							});
							this.renderVariableChips(setting.settingEl, [
								'count',
								'tasks',
							]);
							this.renderCharacterCounter(
								setting.settingEl,
								settings.bulkMessageTemplate,
							);
						},
					},
					{
						name: 'Individual message template',
						desc: 'Template for a single task and for each line in a bulk message. Variables: {taskName}, {fileName}, {deadline}, {filePath}, {taskId}',
						render: (setting) => {
							setting.settingEl.addClass(
								'reminder-telegram-template-setting',
							);
							setting.addTextArea((text) => {
								text.setPlaceholder(
									'Task Reminder\n\nTask: {taskName}\nFile: {fileName}\nDeadline: {deadline}',
								)
									.setValue(
										settings.individualMessageTemplate,
									)
									.onChange(async (value): Promise<void> => {
										settings.individualMessageTemplate =
											value;
										this.debouncedSave();
										this.updateTemplatePreviews();
									});
								text.inputEl.addClass(
									'reminder-telegram-template-textarea',
								);
							});
							this.renderVariableChips(setting.settingEl, [
								'taskName',
								'fileName',
								'deadline',
								'filePath',
								'taskId',
							]);
							this.renderCharacterCounter(
								setting.settingEl,
								settings.individualMessageTemplate,
							);
						},
					},
					{
						name: 'Test message template',
						desc: 'Template for test notifications. Variables: none (raw text).',
						render: (setting) => {
							setting.settingEl.addClass(
								'reminder-telegram-template-setting',
							);
							setting.addTextArea((text) => {
								text.setPlaceholder(
									'Test notification from reminder Telegram plugin',
								)
									.setValue(settings.testMessageTemplate)
									.onChange(async (value): Promise<void> => {
										settings.testMessageTemplate = value;
										this.debouncedSave();
										this.updateTemplatePreviews();
									});
								text.inputEl.addClass(
									'reminder-telegram-template-textarea',
								);
							});
							this.renderCharacterCounter(
								setting.settingEl,
								settings.testMessageTemplate,
							);
						},
					},
					{
						name: 'Live preview',
						desc: 'Show real-time preview of notification templates',
						control: { type: 'toggle', key: 'livePreviewEnabled' },
					},
					{
						name: 'Use Markdown formatting',
						desc: 'Enable Telegram Markdown formatting for messages. Example: *bold*, _italic_, [links](https://example.com)',
						control: {
							type: 'toggle',
							key: 'useMarkdownFormatting',
						},
					},
				],
			},
			// Live preview panel + test button (rendered after the groups).
			{
				name: 'Message preview',
				searchable: false,
				render: (setting) => this.renderPreviewPanel(setting.settingEl),
			},
			{
				name: 'Test notification',
				desc: 'Send a test message to verify your settings',
				render: (setting) => {
					setting.addButton((button) =>
						button
							.setButtonText('Send test')
							.onClick(async (): Promise<void> => {
								await this.sendTestNotification();
							}),
					);
				},
			},
		];
	}

	/** Imperative interpreter of the declarative model — Obsidian < 1.13. */
	private renderDefinitionLegacy(
		containerEl: HTMLElement,
		item: SettingDefinitionItem,
	): void {
		if ('type' in item) {
			// Containers: group / list / page.
			if (item.type === 'group' || item.type === 'list') {
				if (item.heading) {
					new Setting(containerEl).setName(item.heading).setHeading();
				}
				for (const child of item.items ?? []) {
					this.renderDefinitionLegacy(containerEl, child);
				}
			}
			return; // 'page' is not used by this tab
		}
		// item is a SettingDefinition (render / action / control / empty).
		if (item.render) {
			const setting = new Setting(containerEl);
			if (item.name) setting.setName(item.name);
			if (item.desc) setting.setDesc(item.desc);
			item.render(setting, undefined as never);
			return;
		}
		if (item.action) {
			const setting = new Setting(containerEl);
			if (item.name) setting.setName(item.name);
			if (item.desc) setting.setDesc(item.desc);
			setting.addButton((button) =>
				button
					.setButtonText(item.name)
					.onClick(() => item.action(setting.settingEl, 0)),
			);
			return;
		}
		if (item.control) {
			this.renderControlLegacy(containerEl, item);
			return;
		}
		// Empty definition — a plain name/desc row.
		const setting = new Setting(containerEl);
		if (item.name) setting.setName(item.name);
		if (item.desc) setting.setDesc(item.desc);
	}

	/**
	 * Legacy rendering for a key-bound control. The target-folder row is
	 * always rendered and toggled in place by scan-mode changes (there is no
	 * update() on Obsidian < 1.13).
	 */
	private renderControlLegacy(
		containerEl: HTMLElement,
		def: SettingDefinitionControl,
	): void {
		const isTargetFolder = def.control.key === 'targetFolder';
		const visible =
			isTargetFolder ||
			(typeof def.visible === 'function'
				? def.visible()
				: def.visible !== false);
		if (!visible) return;

		const setting = new Setting(containerEl);
		if (def.name) setting.setName(def.name);
		if (def.desc) setting.setDesc(def.desc);

		const control = def.control;
		const key = control.key;
		switch (control.type) {
			case 'toggle':
				setting.addToggle((toggle) =>
					toggle
						.setValue(Boolean(this.getControlValue(key)))
						.onChange(async (value): Promise<void> => {
							void this.setControlValue(key, value);
						}),
				);
				break;
			case 'dropdown':
				setting.addDropdown((dropdown) => {
					/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- CI uses different TS resolution */
					const options: Record<string, string> =
						control.options as Record<string, string>;
					/* eslint-enable @typescript-eslint/no-unnecessary-type-assertion */
					for (const value of Object.keys(options)) {
						const label: string | undefined = options[value];
						if (label !== undefined) {
							dropdown.addOption(value, label);
						}
					}
					dropdown.setValue(String(this.getControlValue(key)));
					dropdown.onChange(async (value): Promise<void> => {
						void this.setControlValue(key, value);
					});
				});
				break;
			case 'text': {
				const current = this.getControlValue(key);
				setting.addText((text) =>
					text
						.setPlaceholder(control.placeholder ?? '')
						.setValue(typeof current === 'string' ? current : '')
						.onChange(async (value): Promise<void> => {
							void this.setControlValue(key, value);
						}),
				);
				if (isTargetFolder) {
					this.legacyFolderRowEl = setting.settingEl;
					setting.settingEl.style.display =
						this.plugin.settings.scanMode === 'specific-folder'
							? ''
							: 'none';
				}
				break;
			}
			default:
				// number/file/folder/slider/color controls are not used by this tab.
				break;
		}
	}

	private renderTelegramSetupGuide(container: HTMLElement): void {
		const wrap = container.createDiv({
			cls: 'reminder-telegram-setup-guide',
		});
		wrap.createDiv({
			cls: 'reminder-telegram-setup-guide-intro',
			text: 'Follow these steps once to obtain the values below.',
		});

		const botSection = wrap.createDiv({
			cls: 'reminder-telegram-setup-guide-section',
		});
		botSection.createDiv({
			cls: 'reminder-telegram-setup-guide-heading',
			text: 'Create a Telegram bot',
		});
		const botSteps = botSection.createEl('ol', {
			cls: 'reminder-telegram-setup-guide-list',
		});
		const botLi1 = botSteps.createEl('li');
		botLi1.append(
			container.ownerDocument.createTextNode(
				'Open Telegram and search for ',
			),
		);
		const botFatherLink = botLi1.createEl('a', {
			text: '@botfather',
			href: 'https://t.me/botfather',
		});
		botFatherLink.setAttr('target', '_blank');
		botFatherLink.setAttr('rel', 'noopener noreferrer');
		const botLi2 = botSteps.createEl('li');
		botLi2.append(container.ownerDocument.createTextNode('Send the '));
		botLi2.createEl('code', { text: '/newbot' });
		botLi2.append(container.ownerDocument.createTextNode(' command.'));
		botSteps.createEl('li', {
			text: 'Follow the prompts to name your bot, then copy the bot token.',
		});

		const chatSection = wrap.createDiv({
			cls: 'reminder-telegram-setup-guide-section',
		});
		chatSection.createDiv({
			cls: 'reminder-telegram-setup-guide-heading',
			text: 'Get your chat ID',
		});
		const chatSteps = chatSection.createEl('ol', {
			cls: 'reminder-telegram-setup-guide-list',
		});
		const chatLi1 = chatSteps.createEl('li');
		chatLi1.append(
			container.ownerDocument.createTextNode(
				'Open Telegram and search for ',
			),
		);
		const userInfoLink = chatLi1.createEl('a', {
			text: '@userinfobot',
			href: 'https://t.me/userinfobot',
		});
		userInfoLink.setAttr('target', '_blank');
		userInfoLink.setAttr('rel', 'noopener noreferrer');
		const chatLi2 = chatSteps.createEl('li');
		chatLi2.append(container.ownerDocument.createTextNode('Send the '));
		chatLi2.createEl('code', { text: '/start' });
		chatLi2.append(container.ownerDocument.createTextNode(' command.'));
		chatSteps.createEl('li', {
			text: 'The bot replies with your chat ID.',
		});
	}

	private async sendTestNotification(): Promise<void> {
		if (
			!this.plugin.settings.telegramBotToken ||
			!this.plugin.settings.telegramChatId
		) {
			new Notice('Please configure Telegram bot token and chat ID first');
			return;
		}
		new Notice('Sending test notification...');
		const result = await sendTestNotification(
			this.plugin.settings.telegramBotToken,
			this.plugin.settings.telegramChatId,
			this.plugin.settings.testMessageTemplate,
			this.plugin.settings.useMarkdownFormatting,
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
	private renderVariableChips(
		container: HTMLElement,
		variables: string[],
	): void {
		const chipsContainer = container.createDiv({
			cls: 'reminder-telegram-variable-chips',
		});
		variables.forEach((variable) => {
			const chip = chipsContainer.createEl('button', {
				cls: 'reminder-telegram-variable-chip',
				text: `{${variable}}`,
			});
			chip.onclick = () => {
				const textarea = container.querySelector(
					'textarea.reminder-telegram-template-textarea',
				);
				if (textarea instanceof HTMLTextAreaElement) {
					const start = textarea.selectionStart;
					const end = textarea.selectionEnd;
					const value = textarea.value;
					textarea.value =
						value.substring(0, start) +
						`{${variable}}` +
						value.substring(end);
					textarea.selectionStart = textarea.selectionEnd =
						start + `{${variable}}`.length;
					textarea.focus();

					// Trigger change event
					const event = new Event('change', { bubbles: true });
					textarea.dispatchEvent(event);
				}
			};
		});
	}

	/**
	 * Renders character counter for template fields
	 */
	private renderCharacterCounter(
		container: HTMLElement,
		template: string,
	): void {
		const counterContainer = container.createDiv({
			cls: 'reminder-telegram-character-counter',
		});
		const counter = counterContainer.createSpan({
			cls: 'reminder-telegram-character-count',
		});
		const textarea = container.querySelector(
			'textarea.reminder-telegram-template-textarea',
		);

		const updateCounter = () => {
			if (textarea instanceof HTMLTextAreaElement) {
				const length = textarea.value.length;
				const maxLength = 4096; // Telegram message limit
				const percentage = Math.min(
					100,
					Math.round((length / maxLength) * 100),
				);

				counter.textContent = `${length}/${maxLength} characters (${percentage}%)`;

				// Add warning class if approaching limit
				if (percentage >= 80) {
					counterContainer.addClass(
						'reminder-telegram-character-warning',
					);
				} else {
					counterContainer.removeClass(
						'reminder-telegram-character-warning',
					);
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
	 * Renders template preview panel. Stores the panel root so preview
	 * updates can re-query the section nodes — which survive re-renders
	 * (e.g. scan-mode `update()` on Obsidian 1.13+).
	 */
	private renderPreviewPanel(container: HTMLElement): void {
		const previewContainer = container.createDiv({
			cls: 'reminder-telegram-preview-container',
		});
		this.previewRootEl = previewContainer;

		// Preview header
		const header = previewContainer.createDiv({
			cls: 'reminder-telegram-preview-header',
		});
		header.createSpan({
			cls: 'reminder-telegram-preview-title',
			text: 'Preview',
		});

		// Individual template preview
		const individualPreview = previewContainer.createDiv({
			cls: 'reminder-telegram-preview-section',
		});
		individualPreview.createSpan({
			cls: 'reminder-telegram-preview-label',
			text: 'Individual task:',
		});
		const individualPreviewContent = individualPreview.createDiv({
			cls: 'reminder-telegram-preview-content reminder-telegram-preview-content-individual',
		});
		individualPreviewContent.createSpan({
			cls: 'reminder-telegram-preview-placeholder',
			text: 'Preview will appear here when enabled',
		});

		// Bulk template preview
		const bulkPreview = previewContainer.createDiv({
			cls: 'reminder-telegram-preview-section',
		});
		bulkPreview.createSpan({
			cls: 'reminder-telegram-preview-label',
			text: 'Multi-task digest:',
		});
		const bulkPreviewContent = bulkPreview.createDiv({
			cls: 'reminder-telegram-preview-content reminder-telegram-preview-content-bulk',
		});
		bulkPreviewContent.createSpan({
			cls: 'reminder-telegram-preview-placeholder',
			text: 'Preview will appear here when enabled',
		});

		// Test template preview
		const testPreview = previewContainer.createDiv({
			cls: 'reminder-telegram-preview-section',
		});
		testPreview.createSpan({
			cls: 'reminder-telegram-preview-label',
			text: 'Test notification:',
		});
		const testPreviewContent = testPreview.createDiv({
			cls: 'reminder-telegram-preview-content reminder-telegram-preview-content-test',
		});
		testPreviewContent.createSpan({
			cls: 'reminder-telegram-preview-placeholder',
			text: 'Preview will appear here when enabled',
		});

		// Upcoming individual template preview
		const upcomingIndividualPreview = previewContainer.createDiv({
			cls: 'reminder-telegram-preview-section',
		});
		upcomingIndividualPreview.createSpan({
			cls: 'reminder-telegram-preview-label',
			text: 'Upcoming individual:',
		});
		const upcomingIndividualPreviewContent =
			upcomingIndividualPreview.createDiv({
				cls: 'reminder-telegram-preview-content reminder-telegram-preview-content-upcoming-individual',
			});
		upcomingIndividualPreviewContent.createSpan({
			cls: 'reminder-telegram-preview-placeholder',
			text: 'Preview will appear here when enabled',
		});

		// Upcoming bulk template preview
		const upcomingBulkPreview = previewContainer.createDiv({
			cls: 'reminder-telegram-preview-section',
		});
		upcomingBulkPreview.createSpan({
			cls: 'reminder-telegram-preview-label',
			text: 'Upcoming bulk:',
		});
		const upcomingBulkPreviewContent = upcomingBulkPreview.createDiv({
			cls: 'reminder-telegram-preview-content reminder-telegram-preview-content-upcoming-bulk',
		});
		upcomingBulkPreviewContent.createSpan({
			cls: 'reminder-telegram-preview-placeholder',
			text: 'Preview will appear here when enabled',
		});

		// Initial update
		this.updateTemplatePreviews();
	}

	/**
	 * Locate the preview section nodes inside the current panel root. Uses
	 * class-based lookup so the refs stay valid across re-renders.
	 */
	private getPreviewElements(): {
		individual: HTMLElement;
		bulk: HTMLElement;
		test: HTMLElement;
		upcomingIndividual: HTMLElement;
		upcomingBulk: HTMLElement;
	} | null {
		if (!this.previewRootEl) return null;
		const q = (cls: string): HTMLElement | null =>
			this.previewRootEl!.querySelector(cls);
		const individual = q('.reminder-telegram-preview-content-individual');
		const bulk = q('.reminder-telegram-preview-content-bulk');
		const test = q('.reminder-telegram-preview-content-test');
		const upcomingIndividual = q(
			'.reminder-telegram-preview-content-upcoming-individual',
		);
		const upcomingBulk = q(
			'.reminder-telegram-preview-content-upcoming-bulk',
		);
		if (
			!individual ||
			!bulk ||
			!test ||
			!upcomingIndividual ||
			!upcomingBulk
		)
			return null;
		return { individual, bulk, test, upcomingIndividual, upcomingBulk };
	}

	/**
	 * Updates all template previews
	 */
	private updateTemplatePreviews(): void {
		if (!this.plugin.settings.livePreviewEnabled) {
			return;
		}
		const elements = this.getPreviewElements();
		if (!elements) return;

		// Individual template preview
		try {
			const individualPreview = this.renderTemplatePreview(
				this.plugin.settings.individualMessageTemplate,
				{
					taskName: 'Finish project report',
					fileName: 'Project.md',
					deadline: '2024-12-31',
					filePath: 'Work/Project.md',
					taskId: 'Work/Project.md:42',
				},
			);
			elements.individual.empty();
			elements.individual.createDiv({ text: individualPreview });
		} catch (error) {
			console.error('Error rendering individual preview:', error);
			elements.individual.empty();
			elements.individual.createSpan({
				cls: 'reminder-telegram-preview-error',
				text: 'Error rendering preview',
			});
		}

		// Bulk template preview
		try {
			const taskLines = [
				'Task: Finish project report (2024-12-31) - Project.md',
				'Task: Review code changes (2024-12-28) - Code.md',
			];
			const bulkPreview = this.renderTemplatePreview(
				this.plugin.settings.bulkMessageTemplate,
				{
					count: 2,
					tasks: taskLines.join('\n'),
				},
			);
			elements.bulk.empty();
			elements.bulk.createDiv({ text: bulkPreview });
		} catch (error) {
			console.error('Error rendering bulk preview:', error);
			elements.bulk.empty();
			elements.bulk.createSpan({
				cls: 'reminder-telegram-preview-error',
				text: 'Error rendering preview',
			});
		}

		// Test template preview
		try {
			elements.test.empty();
			elements.test.createDiv({
				text: this.plugin.settings.testMessageTemplate,
			});
		} catch (error) {
			console.error('Error rendering test preview:', error);
			elements.test.empty();
			elements.test.createSpan({
				cls: 'reminder-telegram-preview-error',
				text: 'Error rendering preview',
			});
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
					taskId: 'Lists/Shopping.md:10',
				},
			);
			elements.upcomingIndividual.empty();
			elements.upcomingIndividual.createDiv({
				text: upcomingIndividualPreview,
			});
		} catch (error) {
			console.error(
				'Error rendering upcoming individual preview:',
				error,
			);
			elements.upcomingIndividual.empty();
			elements.upcomingIndividual.createSpan({
				cls: 'reminder-telegram-preview-error',
				text: 'Error rendering preview',
			});
		}

		// Upcoming bulk template preview
		try {
			const upcomingTaskLines = [
				'Task: Buy groceries (2024-12-25) - Shopping.md',
				'Task: Prepare slides (2024-12-26) - Presentation.md',
			];
			const upcomingBulkPreview = this.renderTemplatePreview(
				this.plugin.settings.upcomingBulkMessageTemplate,
				{
					count: 2,
					tasks: upcomingTaskLines.join('\n'),
				},
			);
			elements.upcomingBulk.empty();
			elements.upcomingBulk.createDiv({ text: upcomingBulkPreview });
		} catch (error) {
			console.error('Error rendering upcoming bulk preview:', error);
			elements.upcomingBulk.empty();
			elements.upcomingBulk.createSpan({
				cls: 'reminder-telegram-preview-error',
				text: 'Error rendering preview',
			});
		}
	}

	/**
	 * Simple template rendering for preview
	 */
	private renderTemplatePreview(
		template: string,
		variables: Record<string, string | number>,
	): string {
		return template.replace(/\{(\w+)\}/g, (match, varName) => {
			const value = variables[varName as keyof typeof variables];
			return value !== undefined ? String(value) : match;
		});
	}
}
