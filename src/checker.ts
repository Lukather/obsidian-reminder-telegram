import {App, Notice} from 'obsidian';

import {VaultTask, scanVaultForTasks, getDueTasks, getUpcomingTasks, getTaskNotificationKey, ScanSettings, filterDueTasksByCheckFlags} from './tasks';

import {sendBulkReminders, sendTaskReminder, sendTestNotification as telegramSendTestNotification, TelegramSendResult, TelegramTaskTemplateFields} from './telegram';

import {sanitizeErrorMessage} from './utils';


/**
 * Interface for notification tracking data
 */
export interface NotificationState {
	notifiedTasks: Record<string, number>;
	lastCheck: number;
}

/**
 * Default notification state
 */
export const DEFAULT_NOTIFICATION_STATE: NotificationState = {
	notifiedTasks: {},
	lastCheck: 0
};

/**
 * Options for checking deadlines
 */
export interface CheckDeadlinesOptions {
	checkToday: boolean;
	checkOverdue: boolean;
	/** Number of days ahead to check for upcoming tasks (0 to disable). */
	daysAhead: number;
	sendBulk: boolean;
	maxTasks: number;
}

const DEFAULT_CHECK_OPTIONS: CheckDeadlinesOptions = {
	checkToday: true,
	checkOverdue: true,
	daysAhead: 0,
	sendBulk: true,
	maxTasks: 10
};

/**
 * Interface for persisted notification state data
 */
interface PersistedNotificationState {
	notifiedTasks?: Record<string, number>;
	lastCheck?: number;
}

/**
 * Loads notification state from plugin data
 */
export function loadNotificationState(data: unknown): NotificationState {
	if (data && typeof data === 'object') {
		const persisted = data as PersistedNotificationState;
		return {
			notifiedTasks: persisted.notifiedTasks || {},
			lastCheck: persisted.lastCheck || 0
		};
	}
	return DEFAULT_NOTIFICATION_STATE;
}

/**
 * Saves notification state to plugin data
 */
export function saveNotificationState(state: NotificationState): PersistedNotificationState {
	return {
		notifiedTasks: state.notifiedTasks,
		lastCheck: state.lastCheck
	};
}

/**
 * Checks if a task has already been notified for its deadline
 */
function isAlreadyNotified(task: VaultTask, state: NotificationState): boolean {
	const key = getTaskNotificationKey(task);
	return state.notifiedTasks[key] !== undefined;
}

/**
 * Marks a task as notified
 */
function markAsNotified(task: VaultTask, state: NotificationState): void {
	const key = getTaskNotificationKey(task);
	state.notifiedTasks[key] = Date.now();
	state.lastCheck = Date.now();
}

/**
 * Clears notification state for a task
 */
export function clearTaskNotification(task: VaultTask, state: NotificationState): void {
	const key = getTaskNotificationKey(task);
	delete state.notifiedTasks[key];
}

/**
 * Prunes old notification keys to prevent unbounded growth
 * Keeps notifications from the last 30 days and up to 1000 most recent notifications
 */
export function pruneNotificationState(state: NotificationState): void {
	const now = Date.now();
	const keys = Object.keys(state.notifiedTasks);
	
	if (keys.length <= 1000) {
		// No need to prune if we have less than 1000 keys
		return;
	}
	
	// Keep notifications from the last 30 days
	const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
	
	// Filter out old notifications
	const recentKeys: Record<string, number> = {};
	let keptCount = 0;
	
	for (const key of keys) {
		const timestamp = state.notifiedTasks[key];
		if (timestamp && timestamp >= thirtyDaysAgo) {
			recentKeys[key] = timestamp;
			keptCount++;
		}
	}
	
	// If we still have too many, keep only the most recent 1000
	if (keptCount > 1000) {
		const sortedKeys = keys
			.map(key => ({ key, timestamp: state.notifiedTasks[key] }))
			.filter(item => item.timestamp !== undefined)
			.sort((a, b) => b.timestamp! - a.timestamp!)
			.slice(0, 1000);
		
		const finalKeys: Record<string, number> = {};
		for (const { key, timestamp } of sortedKeys) {
			if (timestamp !== undefined) {
				finalKeys[key] = timestamp;
			}
		}
		state.notifiedTasks = finalKeys;
	} else {
		state.notifiedTasks = recentKeys;
	}
}

/**
 * Formats a task for Telegram notification
 */
/** Merges due and upcoming lists, keeping due tasks first and skipping duplicate task ids. */
function mergeTasksForNotification(dueTasks: VaultTask[], upcomingTasks: VaultTask[]): VaultTask[] {
	const seen = new Set<string>();
	const merged: VaultTask[] = [];
	for (const task of [...dueTasks, ...upcomingTasks]) {
		if (seen.has(task.id)) {
			continue;
		}
		seen.add(task.id);
		merged.push(task);
	}
	return merged;
}

function formatTaskForTelegram(task: VaultTask): TelegramTaskTemplateFields {
	return {
		taskName: task.text,
		fileName: task.fileName,
		deadline: task.deadlineString || task.deadline?.toISOString().split('T')[0] || 'Unknown',
		filePath: task.filePath,
		taskId: task.id
	};
}

/**
 * Checks for due tasks and sends notifications
 */
export async function checkAndNotify(
	app: App,
	botToken: string,
	chatId: string,
	state: NotificationState,
	options: Partial<CheckDeadlinesOptions> = {},
	scanSettings?: ScanSettings,
	bulkTemplate?: string,
	individualTemplate?: string,
	testTemplate?: string,
	useMarkdown?: boolean
): Promise<{
	totalTasks: number;
	dueTasks: number;
	notifiedTasks: number;
	sendResults: TelegramSendResult[];
	state: NotificationState;
}> {
	const merged = {...DEFAULT_CHECK_OPTIONS, ...options};
	const opts: CheckDeadlinesOptions = {...merged, maxTasks: Math.max(1, merged.maxTasks)};
	const sendResults: TelegramSendResult[] = [];
	let notifiedTasksCount = 0;

	const allTasks = await scanVaultForTasks(app, scanSettings);
	const today = new Date();

	const dueTasks = filterDueTasksByCheckFlags(
		getDueTasks(allTasks, today),
		today,
		opts.checkToday,
		opts.checkOverdue
	);

	const tasksToNotify = dueTasks.filter(task => !isAlreadyNotified(task, state));

	const upcomingToNotify = opts.daysAhead > 0
		? getUpcomingTasks(allTasks, today, opts.daysAhead)
			.filter(task => !isAlreadyNotified(task, state))
		: [];

	const allTasksToNotify = mergeTasksForNotification(tasksToNotify, upcomingToNotify);
	const limitedTasks = allTasksToNotify.slice(0, opts.maxTasks);

	if (limitedTasks.length > 0) {
		// Use individual notifications for single tasks, bulk for multiple tasks
		const useBulk = opts.sendBulk && limitedTasks.length > 1;

		if (useBulk) {
			const formattedTasks = limitedTasks.map(formatTaskForTelegram);
			const result = await sendBulkReminders(
				botToken,
				chatId,
				formattedTasks,
				bulkTemplate,
				individualTemplate,
				useMarkdown
			);
			sendResults.push(result);

			if (result.success) {
				for (const task of limitedTasks) {
					markAsNotified(task, state);
					notifiedTasksCount++;
				}
			}
		} else {
			for (const task of limitedTasks) {
				const formattedTask = formatTaskForTelegram(task);
				const result = await sendTaskReminder(
					botToken,
					chatId,
					formattedTask.taskName,
					formattedTask.fileName,
					formattedTask.deadline,
					individualTemplate,
					useMarkdown,
					formattedTask.filePath,
					formattedTask.taskId
				);
				sendResults.push(result);

				if (result.success) {
					markAsNotified(task, state);
					notifiedTasksCount++;
				} else {
					console.error(`Failed to send notification for task ${task.id}:`, sanitizeErrorMessage(
						String(result.error),
						botToken,
						chatId
					));
				}
			}
		}
	}

	// Prune old notification keys to prevent unbounded growth
	pruneNotificationState(state);

	return {
		totalTasks: allTasks.length,
		dueTasks: dueTasks.length,
		notifiedTasks: notifiedTasksCount,
		sendResults,
		state
	};
}

/**
 * Checks for due tasks and sends notifications (simplified version)
 */
export async function checkDeadlines(
	app: App,
	botToken: string,
	chatId: string,
	state: NotificationState,
	scanSettings?: ScanSettings,
	bulkTemplate?: string,
	individualTemplate?: string,
	useMarkdown?: boolean,
	checkOptions?: Partial<CheckDeadlinesOptions>
): Promise<NotificationState> {
	try {
		const result = await checkAndNotify(app, botToken, chatId, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: true,
			...checkOptions
		}, scanSettings, bulkTemplate, individualTemplate, undefined, useMarkdown);

		if (result.notifiedTasks > 0) {
			new Notice(`Sent ${result.notifiedTasks} reminder(s) to Telegram`);
		}

		return result.state;
	} catch (error) {
		console.error('Error checking deadlines:', sanitizeErrorMessage(
			String(error),
			botToken,
			chatId
		));
		new Notice('Error checking deadlines. See console for details.');
		return state;
	}
}

/**
 * Sends a test notification to verify configuration
 */
export async function sendTestNotification(
	botToken: string,
	chatId: string,
	template?: string,
	useMarkdown?: boolean
): Promise<TelegramSendResult> {
	return telegramSendTestNotification(botToken, chatId, template, useMarkdown);
}
