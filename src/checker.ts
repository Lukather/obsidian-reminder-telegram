import {App, Notice} from 'obsidian';
import {VaultTask, scanVaultForTasks, getDueTasks, getTaskNotificationKey, ScanSettings} from './tasks';
import {sendTelegramMessage, sendBulkReminders, sendTestNotification as telegramSendTestNotification, TelegramSendResult} from './telegram';
import {ReminderTelegramSettings} from './settings';

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
	daysAhead: number | null;
	sendBulk: boolean;
	maxTasks: number;
}

const DEFAULT_CHECK_OPTIONS: CheckDeadlinesOptions = {
	checkToday: true,
	checkOverdue: true,
	daysAhead: null,
	sendBulk: true,
	maxTasks: 10
};

/**
 * Loads notification state from plugin data
 */
export function loadNotificationState(data: any): NotificationState {
	if (data && typeof data === 'object') {
		return {
			notifiedTasks: data.notifiedTasks || {},
			lastCheck: data.lastCheck || 0
		};
	}
	return DEFAULT_NOTIFICATION_STATE;
}

/**
 * Saves notification state to plugin data
 */
export function saveNotificationState(state: NotificationState): any {
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
 * Formats a task for Telegram notification
 */
function formatTaskForTelegram(task: VaultTask): {taskName: string; fileName: string; deadline: string} {
	return {
		taskName: task.text,
		fileName: task.fileName,
		deadline: task.deadlineString || task.deadline?.toISOString().split('T')[0] || 'Unknown'
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
	scanSettings?: ScanSettings
): Promise<{
	totalTasks: number;
	dueTasks: number;
	notifiedTasks: number;
	sendResults: TelegramSendResult[];
	state: NotificationState;
}> {
	const opts: CheckDeadlinesOptions = { ...DEFAULT_CHECK_OPTIONS, ...options };
	const sendResults: TelegramSendResult[] = [];
	let notifiedTasks = 0;
	
	// Scan vault for tasks with scan settings
	const allTasks = await scanVaultForTasks(app, scanSettings);
	const today = new Date();
	
	// Get due tasks
	const dueTasks = getDueTasks(allTasks, today);
	
	// Filter out already notified tasks
	const tasksToNotify = dueTasks.filter(task => !isAlreadyNotified(task, state));
	
	// Apply max tasks limit
	const limitedTasks = tasksToNotify.slice(0, opts.maxTasks);
	
	// Send notifications
	if (limitedTasks.length > 0) {
		if (opts.sendBulk) {
			const formattedTasks = limitedTasks.map(formatTaskForTelegram);
			const result = await sendBulkReminders(botToken, chatId, formattedTasks);
			sendResults.push(result);
			
			if (result.success) {
				for (const task of limitedTasks) {
					markAsNotified(task, state);
					notifiedTasks++;
				}
			}
		} else {
			for (const task of limitedTasks) {
				const formattedTask = formatTaskForTelegram(task);
				const result = await sendTelegramMessage(
					botToken,
					chatId,
					`⏰ Task Reminder\n\n📝 ${formattedTask.taskName}\n📁 ${formattedTask.fileName}\n📅 ${formattedTask.deadline}`
				);
				sendResults.push(result);
				
				if (result.success) {
					markAsNotified(task, state);
					notifiedTasks++;
				} else {
					console.error(`Failed to send notification for task ${task.id}:`, result.error);
				}
			}
		}
	}
	
	return {
		totalTasks: allTasks.length,
		dueTasks: dueTasks.length,
		notifiedTasks,
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
	scanSettings?: ScanSettings
): Promise<NotificationState> {
	try {
		const result = await checkAndNotify(app, botToken, chatId, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: true
		}, scanSettings);
		
		if (result.notifiedTasks > 0) {
			new Notice(`Sent ${result.notifiedTasks} reminder(s) to Telegram`);
		}
		
		return result.state;
	} catch (error) {
		console.error('Error checking deadlines:', error);
		new Notice('Error checking deadlines. See console for details.');
		return state;
	}
}

/**
 * Sends a test notification to verify configuration
 */
export async function sendTestNotification(
	app: App,
	botToken: string,
	chatId: string
): Promise<TelegramSendResult> {
	return telegramSendTestNotification(botToken, chatId);
}
