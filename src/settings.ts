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
	/** Enable live preview of templates */
	livePreviewEnabled: boolean;
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
	livePreviewEnabled: true
};

export class ReminderTelegramSettingTab extends PluginSettingTab {
	plugin: ReminderTelegramPlugin;
	private previewElements?: {
		individual: HTMLElement;
		bulk: HTMLElement;
		test: HTMLElement;
	};
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
						await this.plugin.saveSettings();
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
						await this.plugin.saveSettings();
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
					await this.plugin.saveSettings();
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
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Max tasks per check')
			.setDesc('Maximum number of due and upcoming tasks to notify per run. Additional tasks stay queued for the next check.')
			.addText(text => text
				.setPlaceholder('10')
				.setValue(this.plugin.settings.maxTasksPerCheck.toString())
				.onChange(async (value): Promise<void> => {
					const n = parseInt(value, 10);
					this.plugin.settings.maxTasksPerCheck = Number.isFinite(n) && n >= 1 ? n : DEFAULT_SETTINGS.maxTasksPerCheck;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Upcoming reminders')
			.setDesc('Notify for tasks due after today within the days-ahead range below. Due and overdue tasks are always checked separately.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.upcomingRemindersEnabled)
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.upcomingRemindersEnabled = value;
					await this.plugin.saveSettings();
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
					await this.plugin.saveSettings();
				}));
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
					await this.plugin.saveSettings();
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
						await this.plugin.saveSettings();
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
					await this.plugin.saveSettings();
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
					await this.plugin.saveSettings();
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
					await this.plugin.saveSettings();
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
					await this.plugin.saveSettings();
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
					await this.plugin.saveSettings();
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
		
		const updateCounter = () => {
			const textarea = container.querySelector('textarea.reminder-telegram-template-textarea');
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
		const textarea = container.querySelector('textarea.reminder-telegram-template-textarea');
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
		
		// Store references for updates
		this.previewElements = {
			individual: individualPreviewContent,
			bulk: bulkPreviewContent,
			test: testPreviewContent
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
