import {Notice, Plugin, TFile, MarkdownView} from 'obsidian';
import {
	DEFAULT_SETTINGS,
	ReminderTelegramSettings,
	ReminderTelegramSettingTab,
	validateAtTimeCatchUpWindowMinutes,
	validateAtTimeNotificationsEnabled,
	validateLeadTimeMinutes,
	validateReminderSyntaxEnabled,
	validateKanbanSyntaxEnabled,
	validateStrictTimeMode
} from "./settings";
import {NotificationState, loadNotificationState, saveNotificationState, checkDeadlines, sendTestNotification, CheckDeadlinesOptions, dispatchAtTimeReminders} from "./checker";
import {ScanSettings, VaultTask} from "./tasks";
import {TaskIndex} from "./task-index";
import {sanitizeErrorMessage} from "./utils";
import {ReminderTelegramSidebarView, SIDEBAR_VIEW_TYPE} from "./sidebar-view";
import {AtTimeScheduler} from "./scheduler";

function isMarkdownFile(file: unknown): file is TFile {
	return file instanceof TFile && file.extension === 'md';
}

const AT_TIME_REARM_DEBOUNCE_MS = 200;

export default class ReminderTelegramPlugin extends Plugin {
	settings: ReminderTelegramSettings;
	notificationState: NotificationState;
	taskIndex: TaskIndex;
	private cleanupInterval: (() => void) | null = null;
	private atTimeScheduler: AtTimeScheduler | null = null;
	private atTimeRearmTimer: number | null = null;
	statusBarItemEl: HTMLElement | null = null;


	async onload(): Promise<void> {
		await this.loadSettings();
		this.notificationState = loadNotificationState(await this.loadData());

		this.taskIndex = new TaskIndex(this.app, this.getScanSettings());
		await this.taskIndex.buildIndex();

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

		this.addCommand({
			id: 'toggle-sidebar',
			name: 'Toggle sidebar',
			callback: (): void => {
				void this.toggleSidebar();
			}
		});

		// --- At-time scheduler (issue #89) -----------------------------
		// Build the scheduler up front so the wake callback is wired
		// before the first arm. The callback is responsible for
		// dispatching notifications AND re-arming for the next task.
		this.atTimeScheduler = new AtTimeScheduler(() => this.handleAtTimeWake());
		this.armAtTimeScheduler();
		// ---------------------------------------------------------------

		// Subscribe to vault + workspace events that may change the at-time
		// candidate set (new deadline, completed, deleted, app resume).
		// Rearms are debounced to coalesce bursts of vault events.
		this.registerEvent(
			this.app.vault.on('create', () => this.scheduleAtTimeRearm())
		);
		this.registerEvent(
			this.app.vault.on('modify', () => this.scheduleAtTimeRearm())
		);
		this.registerEvent(
			this.app.vault.on('delete', () => this.scheduleAtTimeRearm())
		);
		this.registerEvent(
			this.app.metadataCache.on('resolve', () => this.scheduleAtTimeRearm())
		);
		// window-open fires on cold start + every time the workspace
		// layout re-initialises (e.g. after the user reopens the window).
		this.registerEvent(
			this.app.workspace.on('window-open', () => this.scheduleAtTimeRearm())
		);
		// visibilitychange: rearm when the tab becomes visible again so a
		// laptop waking from sleep doesn't fire a stale timer.
		const visibilityHandler = (): void => {
			if (document.visibilityState === 'visible') {
				this.scheduleAtTimeRearm();
			}
		};
		document.addEventListener('visibilitychange', visibilityHandler);
		this.register(() => {
			document.removeEventListener('visibilitychange', visibilityHandler);
		});
		// ---------------------------------------------------------------

		this.startPeriodicChecking();
	}

	onunload(): void {
		if (this.cleanupInterval) {
			this.cleanupInterval();
			this.cleanupInterval = null;
		}
		if (this.atTimeRearmTimer !== null) {
			window.clearTimeout(this.atTimeRearmTimer);
			this.atTimeRearmTimer = null;
		}
		if (this.atTimeScheduler) {
			this.atTimeScheduler.cancel();
			this.atTimeScheduler = null;
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
		// At-time settings (issue #89): reuse the pure validators from settings.ts
		// so the onChange handlers and load-time validation stay in lock-step.
		this.settings.atTimeNotificationsEnabled = validateAtTimeNotificationsEnabled(this.settings.atTimeNotificationsEnabled);
		this.settings.leadTimeMinutes = validateLeadTimeMinutes(this.settings.leadTimeMinutes);
		this.settings.atTimeCatchUpWindowMinutes = validateAtTimeCatchUpWindowMinutes(this.settings.atTimeCatchUpWindowMinutes);
		this.settings.strictTimeMode = validateStrictTimeMode(this.settings.strictTimeMode);
		this.settings.reminderSyntaxEnabled = validateReminderSyntaxEnabled(this.settings.reminderSyntaxEnabled);
		this.settings.kanbanSyntaxEnabled = validateKanbanSyntaxEnabled(this.settings.kanbanSyntaxEnabled);
	}

	private getCheckOptions(): Partial<CheckDeadlinesOptions> {
		const daysAhead = this.settings.upcomingRemindersEnabled && this.settings.upcomingRemindersDaysAhead > 0
			? this.settings.upcomingRemindersDaysAhead
			: 0;
		return {
			maxTasks: this.settings.maxTasksPerCheck,
			daysAhead,
			strictTimeMode: this.settings.strictTimeMode
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
			targetFolder: this.settings.targetFolder,
			reminderSyntaxEnabled: this.settings.reminderSyntaxEnabled,
			kanbanSyntaxEnabled: this.settings.kanbanSyntaxEnabled
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
					this.getCheckOptions(),
					this.settings.upcomingBulkMessageTemplate,
					this.settings.upcomingMessageTemplate
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
								this.getCheckOptions(),
								this.settings.upcomingBulkMessageTemplate,
								this.settings.upcomingMessageTemplate
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
		// ponytail: no auto-check here — onload() calls manualCheck() once at startup.
		// Re-checking on every settings change would spam notifications.
	}

	async updateSettings(newSettings: Partial<ReminderTelegramSettings>): Promise<void> {
		this.settings = { ...this.settings, ...newSettings };
		await this.saveSettings();
		this.taskIndex.updateScanSettings(this.getScanSettings());
		this.startPeriodicChecking();
		// At-time settings affect lead time / catch-up window / enabled
		// flag — rearm so the next wake reflects the new config.
		this.armAtTimeScheduler();
	}

	private updateStatusBarText(message: string = ''): void {
		if (this.statusBarItemEl) {
			const textSpan = this.statusBarItemEl.querySelector('span:not(.reminder-telegram-icon)');
			if (textSpan) {
				textSpan.textContent = message || 'Reminder Telegram';
			}
		}
	}

	/* ───────── At-time scheduler (issue #89) ───────── */

	/**
	 * (Re)arm the at-time scheduler. Cancels any existing timer, then
	 * schedules a wake for the next at-time deadline. If the feature is
	 * disabled or there are no at-time tasks, the scheduler is left
	 * idle (no timer, no nextFire).
	 */
	armAtTimeScheduler(): void {
		if (!this.atTimeScheduler) return;
		if (!this.settings.atTimeNotificationsEnabled) {
			this.atTimeScheduler.cancel();
			return;
		}
		const tasks = this.taskIndex.getAllTasks();
		this.atTimeScheduler.arm(
			tasks,
			this.settings.leadTimeMinutes,
			this.settings.atTimeCatchUpWindowMinutes,
			this.notificationState.notifiedAtTimeInstances
		);
	}

	/**
	 * Debounced rearm — coalesces bursts of vault events into a single
	 * rearm 200ms after the last one. Also cancels any pending rearm
	 * from a previous event so the timer resets cleanly.
	 */
	scheduleAtTimeRearm(): void {
		if (this.atTimeRearmTimer !== null) {
			window.clearTimeout(this.atTimeRearmTimer);
		}
		this.atTimeRearmTimer = window.setTimeout(() => {
			this.atTimeRearmTimer = null;
			this.armAtTimeScheduler();
		}, AT_TIME_REARM_DEBOUNCE_MS);
	}

	/**
	 * Wake callback invoked by the scheduler when the timer fires.
	 * Dispatches at-time reminders, persists state, then rearms for
	 * the next task. Wrapped in a try/catch so a thrown dispatch
	 * doesn't crash the host — the scheduler still rearms so we don't
	 * miss future deadlines.
	 */
	private async handleAtTimeWake(): Promise<void> {
		if (
			!this.settings.telegramBotToken ||
			!this.settings.telegramChatId ||
			!this.settings.notificationsEnabled ||
			!this.settings.atTimeNotificationsEnabled
		) {
			// Configuration went away — clear any scheduled wake and bail.
			this.armAtTimeScheduler();
			return;
		}

		try {
			const tasks = this.taskIndex.getAllTasks();
			const {sendResults, state} = await dispatchAtTimeReminders(
				tasks,
				new Date(),
				this.settings.atTimeCatchUpWindowMinutes,
				this.settings.leadTimeMinutes,
				{
					botToken: this.settings.telegramBotToken,
					chatId: this.settings.telegramChatId,
					state: this.notificationState,
					individualTemplate: this.settings.individualMessageTemplate,
					useMarkdown: this.settings.useMarkdownFormatting
				}
			);
			this.notificationState = state;
			if (sendResults.some(r => r.success)) {
				await this.saveSettings();
				this.updateStatusBarText('Last at-time: ' + new Date().toLocaleTimeString());
			}
		} catch (error) {
			console.error('Error during at-time wake:', sanitizeErrorMessage(
				String(error),
				this.settings.telegramBotToken,
				this.settings.telegramChatId
			));
		} finally {
			// Always rearm so a thrown dispatch doesn't leave the
			// scheduler with no upcoming wake. Rearm is cheap (no
			// notifications sent, just a setTimeout).
			this.armAtTimeScheduler();
		}
	}

	/* ───────── Sidebar integration ───────── */

	async toggleSidebar(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
		if (leaves.length > 0) {
			// Remove existing sidebar leaf
			const leaf = leaves[0]!;
			leaf.detach();
		} else {
			// Create a new sidebar leaf in the right sidebar (Obsidian 1.7.2+)
			const rightLeaf = await this.app.workspace.ensureSideLeaf(SIDEBAR_VIEW_TYPE, 'right');
			void this.app.workspace.revealLeaf(rightLeaf);
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
