import {App, Editor, MarkdownView, Notice, Plugin} from 'obsidian';
import {DEFAULT_SETTINGS, ReminderTelegramSettings, ReminderTelegramSettingTab} from "./settings";
import {NotificationState, DEFAULT_NOTIFICATION_STATE, loadNotificationState, saveNotificationState, checkDeadlines, sendTestNotification} from "./checker";
import {ScanSettings} from "./tasks";

export default class ReminderTelegramPlugin extends Plugin {
	settings: ReminderTelegramSettings;
	notificationState: NotificationState;
	private cleanupInterval: (() => void) | null = null;

	async onload() {
		await this.loadSettings();
		this.notificationState = loadNotificationState(await this.loadData());

		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Reminder Telegram');

		this.addSettingTab(new ReminderTelegramSettingTab(this.app, this));

		this.addCommand({
			id: 'check-reminders',
			name: 'Check reminders now',
			callback: () => {
				new Notice('Checking for due tasks...');
				this.manualCheck();
			}
		});

		this.addCommand({
			id: 'test-telegram-notification',
			name: 'Send test Telegram notification',
			callback: async () => {
				if (!this.settings.telegramBotToken || !this.settings.telegramChatId) {
					new Notice('Please configure Telegram Bot Token and Chat ID in settings');
					return;
				}
				new Notice('Sending test notification...');
				const result = await sendTestNotification(
					this.app,
					this.settings.telegramBotToken,
					this.settings.telegramChatId
				);
				if (result.success) {
					new Notice('Test notification sent successfully!');
				} else {
					new Notice(`Failed to send test: ${result.error}`);
				}
			}
		});

		this.startPeriodicChecking();
	}

	onunload() {
		if (this.cleanupInterval) {
			this.cleanupInterval();
			this.cleanupInterval = null;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<ReminderTelegramSettings>);
	}

	async saveSettings() {
		const dataToSave = {
			...this.settings,
			...saveNotificationState(this.notificationState)
		};
		await this.saveData(dataToSave);
	}

	/**
	 * Get scan settings from plugin settings
	 */
	private getScanSettings(): ScanSettings {
		return {
			scanMode: this.settings.scanMode,
			targetFolder: this.settings.targetFolder
		};
	}

	/**
	 * Manually check for due tasks
	 */
	async manualCheck() {
		if (!this.settings.telegramBotToken || !this.settings.telegramChatId) {
			new Notice('Please configure Telegram Bot Token and Chat ID in settings');
			return;
		}

		if (!this.settings.notificationsEnabled) {
			new Notice('Notifications are disabled in settings');
			return;
		}

		try {
			this.notificationState = await checkDeadlines(
				this.app,
				this.settings.telegramBotToken,
				this.settings.telegramChatId,
				this.notificationState,
				this.getScanSettings()
			);
			await this.saveSettings();
		} catch (error) {
			console.error('Error during manual check:', error);
			new Notice('Error checking reminders. See console for details.');
		}
	}

	/**
	 * Start periodic deadline checking
	 */
	startPeriodicChecking() {
		if (this.cleanupInterval) {
			this.cleanupInterval();
			this.cleanupInterval = null;
		}

		if (
			this.settings.notificationsEnabled &&
			this.settings.telegramBotToken &&
			this.settings.telegramChatId &&
			this.settings.checkIntervalMinutes > 0
		) {
			const intervalId = window.setInterval(async () => {
				try {
					this.notificationState = await checkDeadlines(
						this.app,
						this.settings.telegramBotToken,
						this.settings.telegramChatId,
						this.notificationState,
						this.getScanSettings()
					);
					await this.saveSettings();
				} catch (error) {
					console.error('Error during periodic check:', error);
				}
			}, this.settings.checkIntervalMinutes * 60 * 1000);

			this.registerInterval(intervalId);
			
			this.cleanupInterval = () => {
				window.clearInterval(intervalId);
			};
			
			this.manualCheck();
		}
	}

	/**
	 * Update settings and restart periodic checking if needed
	 */
	async updateSettings(newSettings: Partial<ReminderTelegramSettings>) {
		this.settings = { ...this.settings, ...newSettings };
		await this.saveSettings();
		this.startPeriodicChecking();
	}
}
