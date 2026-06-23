import {Notice, Plugin, TFile, MarkdownView} from 'obsidian';
import {DEFAULT_SETTINGS, ReminderTelegramSettings, ReminderTelegramSettingTab, SECRET_IDS} from "./settings";
import {NotificationState, loadNotificationState, saveNotificationState, checkDeadlines, sendTestNotification, CheckDeadlinesOptions} from "./checker";
import {ScanSettings, VaultTask} from "./tasks";
import {TaskIndex} from "./task-index";
import {sanitizeErrorMessage} from "./utils";
import {ReminderTelegramSidebarView, SIDEBAR_VIEW_TYPE} from "./sidebar-view";

function isMarkdownFile(file: unknown): file is TFile {
	return file instanceof TFile && file.extension === 'md';
}

/** Returns the Telegram bot token from SecretStorage, or '' if not set. */
export function getTelegramToken(plugin: ReminderTelegramPlugin): string {
	return plugin.app.secretStorage.getSecret(SECRET_IDS.telegramBotToken) ?? '';
}

/** Returns the Telegram chat ID from SecretStorage, or '' if not set. */
export function getTelegramChatId(plugin: ReminderTelegramPlugin): string {
	return plugin.app.secretStorage.getSecret(SECRET_IDS.telegramChatId) ?? '';
}

/**
 * One-time migration: move `telegramBotToken` / `telegramChatId` out of the
 * plain-text data blob and into SecretStorage (1.11.4+). Idempotent.
 *
 * Reads from `data.telegramBotToken` / `data.telegramChatId` (the field names
 * used in plugin versions < 1.1) and stores them via the secret storage API.
 * The fields are dropped from the returned `settings` object so the next
 * `saveData` call won't write them back in plain text.
 */
async function migrateSecretsToSecretStorage(
	plugin: ReminderTelegramPlugin,
	data: Record<string, unknown> | null,
	settings: ReminderTelegramSettings,
): Promise<void> {
	const oldToken = typeof data?.['telegramBotToken'] === 'string' ? data['telegramBotToken'] : '';
	const oldChatId = typeof data?.['telegramChatId'] === 'string' ? data['telegramChatId'] : '';

	if (oldToken) {
		plugin.app.secretStorage.setSecret(SECRET_IDS.telegramBotToken, oldToken);
	}
	if (oldChatId) {
		plugin.app.secretStorage.setSecret(SECRET_IDS.telegramChatId, oldChatId);
	}
	// Nothing to strip from `settings` because the interface no longer has
	// these fields; the obsolete keys will simply be ignored by Object.assign.
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
		statusBarItemEl.createEl('span', {cls: 'reminder-telegram-icon', text: '🔔'});
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
				if (!getTelegramToken(this) || !getTelegramChatId(this)) {
					new Notice('Please configure Telegram bot token and chat ID in settings');
					return;
				}
				new Notice('Sending test notification...');
				const result = await sendTestNotification(
					getTelegramToken(this),
					getTelegramChatId(this),
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

		this.startPeriodicChecking();
	}

	onunload(): void {
		if (this.cleanupInterval) {
			this.cleanupInterval();
			this.cleanupInterval = null;
		}
	}

	async loadSettings(): Promise<void> {
		const rawData = (await this.loadData() as Record<string, unknown> | null) ?? null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, rawData as Partial<ReminderTelegramSettings>);
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
		// Migrate any pre-1.1 plain-text secrets into SecretStorage. Idempotent.
		await migrateSecretsToSecretStorage(this, rawData, this.settings);
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

	/**
	 * Persist the notification state alongside whatever the framework passed.
	 *
	 * The declarative settings API (Obsidian 1.13+) auto-calls
	 * `saveData(this.plugin.settings)` on every `control` change. We override
	 * to merge in the current notification state so both pieces land in the
	 * same file. The base implementation accepts the settings object as the
	 * only argument; we widen the type since we also need to inject extras.
	 */
	async saveData(data: unknown): Promise<void> {
		await super.saveData({
			...(data as Record<string, unknown>),
			...saveNotificationState(this.notificationState),
		});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private getScanSettings(): ScanSettings {
		return {
			scanMode: this.settings.scanMode,
			targetFolder: this.settings.targetFolder
		};
	}

	async manualCheck(): Promise<void> {
		if (!getTelegramToken(this) || !getTelegramChatId(this)) {
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
				getTelegramToken(this),
				getTelegramChatId(this),
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
				getTelegramToken(this),
				getTelegramChatId(this)
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
			!getTelegramToken(this) ||
			!getTelegramChatId(this) ||
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
							getTelegramToken(this),
							getTelegramChatId(this),
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
							getTelegramToken(this),
							getTelegramChatId(this)
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
		} else {
			// Create a new sidebar leaf in the right sidebar
			const rightLeaf = this.app.workspace.getRightLeaf(false);
			if (rightLeaf) {
				await rightLeaf.setViewState({type: SIDEBAR_VIEW_TYPE, active: true});
				void this.app.workspace.revealLeaf(rightLeaf);
			}
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
