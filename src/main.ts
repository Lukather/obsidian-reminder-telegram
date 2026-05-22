import {Notice, Plugin, TFile} from 'obsidian';
import {DEFAULT_SETTINGS, ReminderTelegramSettings, ReminderTelegramSettingTab} from "./settings";
import {NotificationState, loadNotificationState, saveNotificationState, checkDeadlines, sendTestNotification, CheckDeadlinesOptions} from "./checker";
import {ScanSettings} from "./tasks";
import {TaskIndex} from "./task-index";
import {sanitizeErrorMessage} from "./utils";

function isMarkdownFile(file: unknown): file is TFile {
	return file instanceof TFile && file.extension === 'md';
}

export default class ReminderTelegramPlugin extends Plugin {
	settings: ReminderTelegramSettings;
	notificationState: NotificationState;
	taskIndex: TaskIndex;
	private cleanupInterval: (() => void) | null = null;
	statusBarItemEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.notificationState = loadNotificationState(await this.loadData());

		this.taskIndex = new TaskIndex(this.app, this.getScanSettings());
		await this.taskIndex.buildIndex();

		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (isMarkdownFile(file)) void this.taskIndex.updateFile(file);
			})
		);
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (isMarkdownFile(file)) void this.taskIndex.updateFile(file);
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				this.taskIndex.removeFile(file);
			})
		);
		this.registerEvent(
			this.app.metadataCache.on('resolve', (file) => {
				if (isMarkdownFile(file)) void this.taskIndex.updateFile(file);
			})
		);

		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.addClass('reminder-telegram-status-bar');
		statusBarItemEl.createSpan({text: 'Reminder Telegram'});
		statusBarItemEl.createEl('span', {cls: 'reminder-telegram-icon', text: '🔔'});
		statusBarItemEl.onClickEvent(() => {
			new Notice('Checking for due tasks...');
			void this.manualCheck();
		});
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
					this.settings.telegramChatId,
					this.settings.testMessageTemplate,
					this.settings.useMarkdownFormatting
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
		this.settings.maxTasksPerCheck = typeof this.settings.maxTasksPerCheck === 'number' && this.settings.maxTasksPerCheck >= 1
			? this.settings.maxTasksPerCheck
			: DEFAULT_SETTINGS.maxTasksPerCheck;
		this.settings.upcomingRemindersDaysAhead = typeof this.settings.upcomingRemindersDaysAhead === 'number' && this.settings.upcomingRemindersDaysAhead >= 0
			? this.settings.upcomingRemindersDaysAhead
			: DEFAULT_SETTINGS.upcomingRemindersDaysAhead;
		this.settings.upcomingRemindersEnabled = typeof this.settings.upcomingRemindersEnabled === 'boolean'
			? this.settings.upcomingRemindersEnabled
			: DEFAULT_SETTINGS.upcomingRemindersEnabled;
		this.settings.livePreviewEnabled = typeof this.settings.livePreviewEnabled === 'boolean'
			? this.settings.livePreviewEnabled
			: DEFAULT_SETTINGS.livePreviewEnabled;
	}

	private getCheckOptions(): Partial<CheckDeadlinesOptions> {
		const daysAhead = this.settings.upcomingRemindersEnabled && this.settings.upcomingRemindersDaysAhead > 0
			? this.settings.upcomingRemindersDaysAhead
			: 0;
		return {
			maxTasks: this.settings.maxTasksPerCheck,
			daysAhead
		};
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
				this.taskIndex.getAllTasks(),
				this.settings.telegramBotToken,
				this.settings.telegramChatId,
				this.notificationState,
				this.settings.bulkMessageTemplate,
				this.settings.individualMessageTemplate,
				this.settings.useMarkdownFormatting,
				this.getCheckOptions()
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
			!this.settings.notificationsEnabled ||
			!this.settings.telegramBotToken ||
			!this.settings.telegramChatId ||
			this.settings.checkIntervalMinutes <= 0
		) {
			return;
		}

		const intervalId = window.setInterval(
			(): void => {
				void (async (): Promise<void> => {
					try {
						this.notificationState = await checkDeadlines(
							this.taskIndex.getAllTasks(),
							this.settings.telegramBotToken,
							this.settings.telegramChatId,
							this.notificationState,
							this.settings.bulkMessageTemplate,
							this.settings.individualMessageTemplate,
							this.settings.useMarkdownFormatting,
							this.getCheckOptions()
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

	async updateSettings(newSettings: Partial<ReminderTelegramSettings>): Promise<void> {
		this.settings = { ...this.settings, ...newSettings };
		await this.saveSettings();
		this.taskIndex.updateScanSettings(this.getScanSettings());
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
