import {App, Notice, PluginSettingTab, Setting} from "obsidian";
import ReminderTelegramPlugin from "./main";
import {sendTestNotification} from "./checker";

export interface ReminderTelegramSettings {
	// Telegram configuration
	telegramBotToken: string;
	telegramChatId: string;

	// Notification settings
	notificationsEnabled: boolean;
	checkIntervalMinutes: number;

	// Scan settings
	scanMode: 'whole-vault' | 'specific-folder';
	targetFolder: string;
}

export const DEFAULT_SETTINGS: ReminderTelegramSettings = {
	telegramBotToken: '',
	telegramChatId: '',
	notificationsEnabled: true,
	checkIntervalMinutes: 30,
	scanMode: 'whole-vault',
	targetFolder: ''
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

		// Telegram Bot Token
		new Setting(containerEl)
			.setName('Telegram Bot Token')
			.setDesc('Your Telegram bot token from @BotFather')
			.addText(text => text
				.setPlaceholder('123456789:ABC-DEF123456789')
				.setValue(this.plugin.settings.telegramBotToken)
				.onChange(async (value) => {
					this.plugin.settings.telegramBotToken = value;
					await this.plugin.saveSettings();
				}));

		// Telegram Chat ID
		new Setting(containerEl)
			.setName('Telegram Chat ID')
			.setDesc('Your chat ID (use /getid command with @userinfobot)')
			.addText(text => text
				.setPlaceholder('123456789')
				.setValue(this.plugin.settings.telegramChatId)
				.onChange(async (value) => {
					this.plugin.settings.telegramChatId = value;
					await this.plugin.saveSettings();
				}));

		// Notifications Enabled
		new Setting(containerEl)
			.setName('Notifications Enabled')
			.setDesc('Enable or disable Telegram notifications')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.notificationsEnabled)
				.onChange(async (value) => {
					this.plugin.settings.notificationsEnabled = value;
					await this.plugin.saveSettings();
				}));

		// Check Interval
		new Setting(containerEl)
			.setName('Check Interval (minutes)')
			.setDesc('How often to check for due tasks')
			.addText(text => text
				.setPlaceholder('30')
				.setValue(this.plugin.settings.checkIntervalMinutes.toString())
				.onChange(async (value) => {
					const numValue = parseInt(value) || 30;
					this.plugin.settings.checkIntervalMinutes = numValue;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('hr');

		// Scan Mode
		new Setting(containerEl)
			.setName('Scan Mode')
			.setDesc('Choose whether to scan the whole vault or a specific folder')
			.addDropdown(dropdown => {
				dropdown.addOption('whole-vault', 'Whole Vault');
				dropdown.addOption('specific-folder', 'Specific Folder');
				dropdown.setValue(this.plugin.settings.scanMode);
				dropdown.onChange(async (value: 'whole-vault' | 'specific-folder') => {
					this.plugin.settings.scanMode = value;
					await this.plugin.saveSettings();
					this.display(); // Refresh to show/hide folder selector
				});
			});

		// Target Folder (only shown if scanMode is specific-folder)
		if (this.plugin.settings.scanMode === 'specific-folder') {
			new Setting(containerEl)
				.setName('Target Folder')
				.setDesc('Select the folder to scan for tasks (e.g., "Tasks" or "Meta/TaskNotes/Tasks")')
				.addText(text => text
					.setPlaceholder('Tasks')
					.setValue(this.plugin.settings.targetFolder)
					.onChange(async (value) => {
						this.plugin.settings.targetFolder = value;
						await this.plugin.saveSettings();
					}));
		}

		containerEl.createEl('hr');

		// Test Notification Button
		new Setting(containerEl)
			.setName('Test Notification')
			.setDesc('Send a test message to verify your settings')
			.addButton(button => button
				.setButtonText('Send Test')
				.onClick(async () => {
					await this.sendTestNotification();
				}));
	}

	private async sendTestNotification() {
		if (!this.plugin.settings.telegramBotToken || !this.plugin.settings.telegramChatId) {
			new Notice('Please configure Telegram Bot Token and Chat ID first');
			return;
		}

		new Notice('Sending test notification...');
		const result = await sendTestNotification(
			this.plugin.app,
			this.plugin.settings.telegramBotToken,
			this.plugin.settings.telegramChatId
		);
		if (result.success) {
			new Notice('Test notification sent successfully!');
		} else {
			new Notice(`Failed to send test: ${result.error}`);
		}
	}
}
