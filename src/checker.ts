import {Notice} from 'obsidian';
import {VaultTask, getDueTasks, getUpcomingTasks, getTaskNotificationKey, filterDueTasksByCheckFlags, deadlineToDateString} from './tasks';
import {sendBulkReminders, sendTaskReminder, sendTestNotification as telegramSendTestNotification, TelegramSendResult, TelegramTaskTemplateFields} from './telegram';
import {sanitizeErrorMessage} from './utils';

export interface NotificationState {
	notifiedTasks: Record<string, number>;
	lastCheck: number;
}

export const DEFAULT_NOTIFICATION_STATE: NotificationState = {
	notifiedTasks: {},
	lastCheck: 0
};

export interface CheckDeadlinesOptions {
	checkToday: boolean;
	checkOverdue: boolean;
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

interface PersistedNotificationState {
	notifiedTasks?: Record<string, number>;
	lastCheck?: number;
}

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

export function saveNotificationState(state: NotificationState): PersistedNotificationState {
	return {
		notifiedTasks: state.notifiedTasks,
		lastCheck: state.lastCheck
	};
}

function isAlreadyNotified(task: VaultTask, state: NotificationState): boolean {
	const key = getTaskNotificationKey(task);
	return state.notifiedTasks[key] !== undefined;
}

function markAsNotified(task: VaultTask, state: NotificationState): void {
	const key = getTaskNotificationKey(task);
	state.notifiedTasks[key] = Date.now();
	state.lastCheck = Date.now();
}

export function clearTaskNotification(task: VaultTask, state: NotificationState): void {
	const key = getTaskNotificationKey(task);
	delete state.notifiedTasks[key];
}

export function pruneNotificationState(state: NotificationState): void {
	// Age-based prune always runs, regardless of count
	const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
	const entries: Array<[string, number]> = Object.entries(state.notifiedTasks);
	const recent = entries.filter(([, timestamp]) => timestamp >= thirtyDaysAgo);

	if (recent.length <= 1000) {
		state.notifiedTasks = Object.fromEntries(recent);
		return;
	}

	// Cap at 1000 most recent entries
	state.notifiedTasks = Object.fromEntries(
		recent.sort((a, b) => b[1] - a[1]).slice(0, 1000)
	);
}

function mergeTasksForNotification(dueTasks: VaultTask[], upcomingTasks: VaultTask[]): VaultTask[] {
	const seen = new Set<string>();
	return [...dueTasks, ...upcomingTasks].filter(task => {
		if (seen.has(task.id)) return false;
		seen.add(task.id);
		return true;
	});
}

function formatTaskForTelegram(task: VaultTask): TelegramTaskTemplateFields {
	return {
		taskName: task.text,
		fileName: task.fileName,
		deadline: task.deadlineString || deadlineToDateString(task.deadline) || 'Unknown',
		filePath: task.filePath,
		taskId: task.id
	};
}

/**
 * Checks for due tasks and sends notifications
 */
export async function checkAndNotify(
	allTasks: VaultTask[],
	botToken: string,
	chatId: string,
	state: NotificationState,
	options: Partial<CheckDeadlinesOptions> = {},
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

	if (limitedTasks.length === 0) {
		state.lastCheck = Date.now();
		pruneNotificationState(state);
		return {
			totalTasks: allTasks.length,
			dueTasks: dueTasks.length,
			notifiedTasks: 0,
			sendResults,
			state
		};
	}

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

	pruneNotificationState(state);

	return {
		totalTasks: allTasks.length,
		dueTasks: dueTasks.length,
		notifiedTasks: notifiedTasksCount,
		sendResults,
		state
	};
}

export async function checkDeadlines(
	allTasks: VaultTask[],
	botToken: string,
	chatId: string,
	state: NotificationState,
	bulkTemplate?: string,
	individualTemplate?: string,
	useMarkdown?: boolean,
	checkOptions?: Partial<CheckDeadlinesOptions>
): Promise<NotificationState> {
	try {
		const result = await checkAndNotify(allTasks, botToken, chatId, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: true,
			...checkOptions
		}, bulkTemplate, individualTemplate, undefined, useMarkdown);

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
