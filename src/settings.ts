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

		new Setting(containerEl)
			.setName('Telegram bot token')
			.setDesc('Your Telegram bot token from @botfather')
			.addText(text => text
				.setPlaceholder('123456789:abc-def123456789')
				.setValue(this.plugin.settings.telegramBotToken)
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.telegramBotToken = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Telegram chat ID')
			.setDesc('Your chat ID from @userinfobot')
			.addText(text => text
				.setPlaceholder('123456789')
				.setValue(this.plugin.settings.telegramChatId)
				.onChange(async (value): Promise<void> => {
					this.plugin.settings.telegramChatId = value;
					await this.plugin.saveSettings();
				}));

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

		new Setting(containerEl)
			.setName('Test notification')
			.setDesc('Send a test message to verify your settings')
			.addButton(button => button
				.setButtonText('Send test')
				.onClick(async (): Promise<void> => {
					await this.sendTestNotification();
				}));
	}

	private async sendTestNotification(): Promise<void> {
		if (!this.plugin.settings.telegramBotToken || !this.plugin.settings.telegramChatId) {
			new Notice('Please configure Telegram bot token and chat ID first');
			return;
		}

		new Notice('Sending test notification...');
		const result = await sendTestNotification(
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
