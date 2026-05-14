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
	maxTasksPerCheck: 10
};

export class ReminderTelegramSettingTab extends PluginSettingTab {
	plugin: ReminderTelegramPlugin;
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
			.setDesc('Maximum number of due tasks to include in each run. Additional due tasks stay queued for the next check.')
			.addText(text => text
				.setPlaceholder('10')
				.setValue(this.plugin.settings.maxTasksPerCheck.toString())
				.onChange(async (value): Promise<void> => {
					const n = parseInt(value, 10);
					this.plugin.settings.maxTasksPerCheck = Number.isFinite(n) && n >= 1 ? n : DEFAULT_SETTINGS.maxTasksPerCheck;
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
		const bulkTemplateSetting = new Setting(containerEl)
			.setName('Bulk message template')
			.setDesc('Template for multiple tasks. Variables: {count}, {tasks}. Each line in {tasks} uses the individual template below.');
		bulkTemplateSetting.settingEl.addClass('reminder-telegram-template-setting');
		bulkTemplateSetting.addTextArea(text => {
			text
				.setPlaceholder('You have {count} task(s) due:\n\n{tasks}')
				.setValue(this.plugin.settings.bulkMessageTemplate)
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.bulkMessageTemplate = value;
					await this.plugin.saveSettings();
				});
			text.inputEl.addClass('reminder-telegram-template-textarea');
		});
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
				});
			text.inputEl.addClass('reminder-telegram-template-textarea');
		});
		new Setting(containerEl)
			.setName('Test message template')
			.setDesc('Template for test notifications.')
			.addText(text => text
				.setPlaceholder('Test notification from reminder Telegram plugin.')
				.setValue(this.plugin.settings.testMessageTemplate)
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.testMessageTemplate = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Use Markdown formatting')
			.setDesc('Enable Telegram Markdown formatting for messages.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useMarkdownFormatting)
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.useMarkdownFormatting = value;
					await this.plugin.saveSettings();
				}));
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
}
