import {Notice, Plugin} from 'obsidian';

import {DEFAULT_SETTINGS, ReminderTelegramSettings, ReminderTelegramSettingTab} from "./settings";

import {NotificationState, loadNotificationState, saveNotificationState, checkDeadlines, sendTestNotification} from "./checker";

import {ScanSettings} from "./tasks";

import {sanitizeErrorMessage} from "./utils";


export default class ReminderTelegramPlugin extends Plugin {

	settings: ReminderTelegramSettings;

	notificationState: NotificationState;

	private cleanupInterval: (() => void) | null = null;
	statusBarItemEl: HTMLElement | null = null;


	async onload(): Promise<void> {

		await this.loadSettings();
		this.notificationState = loadNotificationState(await this.loadData());


		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.createSpan({text: 'Reminder Telegram'});
		
		// Add icon
		statusBarItemEl.createEl('span', {cls: 'reminder-telegram-icon', text: '🔔'});
		
		// Add click handler
		statusBarItemEl.onClickEvent(() => {
			new Notice('Checking for due tasks...');
			void this.manualCheck();
		});
		
		// Store reference to status bar for updates
		this.statusBarItemEl = statusBarItemEl;



		this.addSettingTab(new ReminderTelegramSettingTab(this.app, this));



		this.addCommand({

			id: 'check-reminders',

			name: 'Check reminders now',

			callback: (): void => {

				new Notice('Checking for due tasks...');

				void this.manualCheck();

			}

		});



		this.addCommand({

			id: 'test-telegram-notification',

			name: 'Send test Telegram notification',

			callback: async (): Promise<void> => {

				if (!this.settings.telegramBotToken || !this.settings.telegramChatId) {

					new Notice('Please configure Telegram bot token and chat ID in settings');

					return;

				}

				new Notice('Sending test notification...');

				const result = await sendTestNotification(

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



	onunload(): void {

		if (this.cleanupInterval) {

			this.cleanupInterval();

			this.cleanupInterval = null;

		}

	}



	async loadSettings(): Promise<void> {

		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<ReminderTelegramSettings>);

	}



	async saveSettings(): Promise<void> {

		const dataToSave = {

			...this.settings,

			...saveNotificationState(this.notificationState)

		};

		await this.saveData(dataToSave);

	}



	private getScanSettings(): ScanSettings {

		return {

			scanMode: this.settings.scanMode,

			targetFolder: this.settings.targetFolder

		};

	}



	async manualCheck(): Promise<void> {

		if (!this.settings.telegramBotToken || !this.settings.telegramChatId) {

			new Notice('Please configure Telegram bot token and chat ID in settings');

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

			this.updateStatusBarText('Last check: ' + new Date().toLocaleTimeString());

		} catch (error) {

			console.error('Error during manual check:', sanitizeErrorMessage(

				String(error),

				this.settings.telegramBotToken,

				this.settings.telegramChatId

			));

			new Notice('Error checking reminders. See console for details.');

		}

	}



	startPeriodicChecking(): void {

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

			const intervalId = window.setInterval(

				(): void => {

					void (async (): Promise<void> => {

						try {

							this.notificationState = await checkDeadlines(

								this.app,

								this.settings.telegramBotToken,

								this.settings.telegramChatId,

								this.notificationState,

								this.getScanSettings()

							);

							await this.saveSettings();

							this.updateStatusBarText('Last check: ' + new Date().toLocaleTimeString());

						} catch (error) {

							console.error('Error during periodic check:', sanitizeErrorMessage(

							String(error),

							this.settings.telegramBotToken,

							this.settings.telegramChatId

						));

						}

					})();

				},

				this.settings.checkIntervalMinutes * 60 * 1000

			);



			this.registerInterval(intervalId);



			this.cleanupInterval = (): void => {

				window.clearInterval(intervalId);

			};



			void this.manualCheck();

		}

	}



	async updateSettings(newSettings: Partial<ReminderTelegramSettings>): Promise<void> {

		this.settings = { ...this.settings, ...newSettings };

		await this.saveSettings();

		this.startPeriodicChecking();

	}
	
	private updateStatusBarText(message: string = ''): void {
		if (this.statusBarItemEl) {
			const textSpan = this.statusBarItemEl.querySelector('span:not(.reminder-telegram-icon)');
			if (textSpan) {
				textSpan.textContent = message || 'Reminder Telegram';
			}
		}
	}

}