import {Notice, Plugin, TFile, MarkdownView} from 'obsidian';
import {DEFAULT_SETTINGS, ReminderTelegramSettings, ReminderTelegramSettingTab} from "./settings";
import {NotificationState, loadNotificationState, saveNotificationState, checkDeadlines, sendTestNotification, CheckDeadlinesOptions} from "./checker";
import {ScanSettings, VaultTask} from "./tasks";
import {TaskIndex} from "./task-index";
import {sanitizeErrorMessage, logInfo, logError} from "./utils";
import {ReminderTelegramSidebarView, SIDEBAR_VIEW_TYPE} from "./sidebar-view";

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

		logInfo(
			`Loaded v${this.manifest.version} · ` +
			`notifications=${this.settings.notificationsEnabled ? 'on' : 'off'} · ` +
			`scan=${this.settings.scanMode}${this.settings.scanMode === 'specific-folder' ? ` (${this.settings.targetFolder || '/'})` : ''} · ` +
			`checkEvery=${this.settings.checkIntervalMinutes}min · ` +
			`upcoming=${this.settings.upcomingRemindersEnabled ? `${this.settings.upcomingRemindersDaysAhead}d` : 'off'} · ` +
			`markdown=${this.settings.useMarkdownFormatting ? 'on' : 'off'}`
		);

		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (isMarkdownFile(file)) {
					void this.taskIndex.updateFile(file).then(() => this.notifySidebarViews());
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (isMarkdownFile(file)) {
					void this.taskIndex.updateFile(file).then(() => this.notifySidebarViews());
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				this.taskIndex.removeFile(file);
				this.notifySidebarViews();
			})
		);
		this.registerEvent(
			this.app.metadataCache.on('resolve', (file) => {
				if (isMarkdownFile(file)) {
					void this.taskIndex.updateFile(file).then(() => this.notifySidebarViews());
				}
			})
		);

		this.registerView(SIDEBAR_VIEW_TYPE, (leaf) => {
			return new ReminderTelegramSidebarView(leaf, this);
		});

		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.addClass('reminder-telegram-status-bar');
		statusBarItemEl.createSpan({text: 'Reminder Telegram'});
		statusBarItemEl.createSpan({cls: 'reminder-telegram-icon', text: '🔔'});
		statusBarItemEl.onClickEvent(() => {
			new Notice('Checking for due tasks...');
			void this.manualCheck();
		});
		this.statusBarItemEl = statusBarItemEl;

		this.addRibbonIcon('bell', 'Toggle sidebar', () => {
			void this.toggleSidebar();
		});

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
				logInfo('Test notification triggered');
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
					logError(`Test notification failed: ${sanitizeErrorMessage(
						String(result.error),
						this.settings.telegramBotToken,
						this.settings.telegramChatId
					)}`);
				}
			}
		});

		this.addCommand({
			id: 'toggle-sidebar',
			name: 'Toggle sidebar',
			callback: (): void => {
				void this.toggleSidebar();
			}
		});

		this.startPeriodicChecking();
	}

	onunload(): void {
		if (this.cleanupInterval) {
			this.cleanupInterval();
			this.cleanupInterval = null;
		}
		logInfo('Unloaded');
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

		logInfo('Manual check triggered');
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
			logError('Manual check failed: ' + sanitizeErrorMessage(
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
			logInfo('Periodic checking disabled');
			return;
		}

		logInfo(`Periodic checking started (every ${this.settings.checkIntervalMinutes}min)`);

		const intervalId = window.setInterval(
			(): void => {
				void (async (): Promise<void> => {
					logInfo('Periodic check triggered');
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
						logError('Periodic check failed: ' + sanitizeErrorMessage(
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
		// ponytail: no auto-check here — onload() calls manualCheck() once at startup.
		// Re-checking on every settings change would spam notifications.
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

	/* ───────── Sidebar integration ───────── */

	async toggleSidebar(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
		if (leaves.length > 0) {
			// Remove existing sidebar leaf
			const leaf = leaves[0]!;
			leaf.detach();
			logInfo('Sidebar closed');
		} else {
			// Create a new sidebar leaf in the right sidebar (Obsidian 1.7.2+)
			const rightLeaf = await this.app.workspace.ensureSideLeaf(SIDEBAR_VIEW_TYPE, 'right');
			void this.app.workspace.revealLeaf(rightLeaf);
			logInfo('Sidebar opened');
		}
	}

	getTasksForSidebar(): VaultTask[] {
		return this.taskIndex.getAllTasks().filter(t => !t.completed && t.deadline);
	}

	getUpcomingDaysAhead(): number {
		return this.settings.upcomingRemindersEnabled
			? Math.max(0, this.settings.upcomingRemindersDaysAhead)
			: 0;
	}

	async openTask(task: VaultTask): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(task.filePath);
		if (!(file instanceof TFile)) return;

		const leaf = this.app.workspace.getMostRecentLeaf();
		if (!leaf) return;

		await leaf.openFile(file);

		// Scroll to the relevant line
		const view = leaf.view;
		if (view instanceof MarkdownView && view.editor) {
			const targetLine = task.source === 'frontmatter'
				? (task.headingLineNumber ? task.headingLineNumber - 1 : 0)
				: (task.lineNumber ? task.lineNumber - 1 : 0);
			view.editor.setCursor({line: targetLine, ch: 0});
			view.editor.scrollIntoView({from: {line: targetLine, ch: 0}, to: {line: targetLine, ch: 0}}, true);
		}
	}

	/** Called by vault event handlers to notify all registered sidebar views. */
	private notifySidebarViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof ReminderTelegramSidebarView) {
				view.refresh();
			}
		}
	}
}
