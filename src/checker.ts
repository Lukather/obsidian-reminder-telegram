import {Notice} from 'obsidian';
import {VaultTask, getDueTasks, getUpcomingTasks, getTaskNotificationKey, filterDueTasksByCheckFlags, filterOverdueByCatchUpWindow, deadlineToDateString} from './tasks';
import {sendBulkReminders, sendTaskReminder, sendTestNotification as telegramSendTestNotification, TelegramSendResult, TelegramTaskTemplateFields} from './telegram';
import {sanitizeErrorMessage} from './utils';

export interface NotificationState {
	notifiedTasks: Record<string, number>;
	/**
	 * Records the scheduled fire time (ms since epoch) for which an at-time
	 * notification has been sent. Keyed by `taskId`. A task can fire multiple
	 * times (e.g. after the user re-schedules it) — the value disambiguates
	 * instances so we only short-circuit when the *same* scheduledFire has
	 * already been notified.
	 */
	notifiedAtTimeInstances: Record<string, number>;
	lastCheck: number;
}

export const DEFAULT_NOTIFICATION_STATE: NotificationState = {
	notifiedTasks: {},
	notifiedAtTimeInstances: {},
	lastCheck: 0
};

export interface CheckDeadlinesOptions {
	checkToday: boolean;
	checkOverdue: boolean;
	daysAhead: number;
	sendBulk: boolean;
	maxTasks: number;
	/**
	 * If true, at-time (datetime) tasks are excluded from the periodic
	 * check — they're owned by the AtTimeScheduler instead. When false
	 * (default) the periodic check still picks up at-time tasks so the
	 * scheduler isn't a single point of failure.
	 */
	strictTimeMode?: boolean;
	/**
	 * Catch-up window in minutes for overdue tasks missed while the app was
	 * closed (issue #99). Reuses the at-time window setting. 0 disables the
	 * gate (all overdue tasks notify, backwards compatible). Tasks whose
	 * deadline is older than `now - window` are silently dropped.
	 */
	catchUpWindowMinutes?: number;
}

const DEFAULT_CHECK_OPTIONS: CheckDeadlinesOptions = {
	checkToday: true,
	checkOverdue: true,
	daysAhead: 0,
	sendBulk: true,
	maxTasks: 10,
	strictTimeMode: false,
	catchUpWindowMinutes: 0
};

interface PersistedNotificationState {
	notifiedTasks?: Record<string, number>;
	notifiedAtTimeInstances?: Record<string, number>;
	lastCheck?: number;
}

export function loadNotificationState(data: unknown): NotificationState {
	if (data && typeof data === 'object') {
		const persisted = data as PersistedNotificationState;
		return {
			notifiedTasks: persisted.notifiedTasks || {},
			notifiedAtTimeInstances: persisted.notifiedAtTimeInstances || {},
			lastCheck: persisted.lastCheck || 0
		};
	}
	// Return a FRESH copy so callers can mutate the maps without
	// poisoning the shared DEFAULT_NOTIFICATION_STATE for subsequent
	// loaders (e.g. between test cases).
	return {
		notifiedTasks: {},
		notifiedAtTimeInstances: {},
		lastCheck: 0
	};
}

export function saveNotificationState(state: NotificationState): PersistedNotificationState {
	return {
		notifiedTasks: state.notifiedTasks,
		notifiedAtTimeInstances: state.notifiedAtTimeInstances,
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
	// Age-based prune always runs, regardless of count.
	// 30-day window is wide enough that catch-up still works after a long
	// weekend away, while keeping the state file from growing unbounded.
	const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

	// --- notifiedTasks (date-only / catch-all keys) ---
	const recentEntries: Array<[string, number]> = [];
	for (const key of Object.keys(state.notifiedTasks)) {
		const timestamp: number | undefined = state.notifiedTasks[key];
		if (timestamp !== undefined && timestamp >= thirtyDaysAgo) {
			recentEntries.push([key, timestamp]);
		}
	}
	if (recentEntries.length > 1000) {
		recentEntries.sort((a, b) => b[1] - a[1]);
		recentEntries.length = 1000;
	}
	const prunedTasks: Record<string, number> = {};
	for (const [key, timestamp] of recentEntries) {
		prunedTasks[key] = timestamp;
	}
	state.notifiedTasks = prunedTasks;

	// --- notifiedAtTimeInstances (one entry per at-time fire) ---
	// Same 30-day window. This map is small (one entry per fired instance) so
	// the 1000-cap doesn't apply — age-pruning alone is enough.
	const prunedAtTime: Record<string, number> = {};
	for (const key of Object.keys(state.notifiedAtTimeInstances)) {
		const timestamp: number | undefined = state.notifiedAtTimeInstances[key];
		if (timestamp !== undefined && timestamp >= thirtyDaysAgo) {
			prunedAtTime[key] = timestamp;
		}
	}
	state.notifiedAtTimeInstances = prunedAtTime;
}

/**
 * Description of an at-time task that should fire right now. `scheduledFire`
 * is the time the notification was meant to fire (deadline minus lead time);
 * `delayedByMinutes` is how late the fire actually is, or 0 if on time.
 */
export interface AtTimeFire {
	task: VaultTask;
	/** Scheduled fire time (ms since epoch). */
	scheduledFire: number;
	/** Minutes late the fire is (0 if on time). */
	delayedByMinutes: number;
}

/**
 * Compute the next absolute time the at-time scheduler should wake up.
 * Returns null when no at-time task warrants a wake-up (no datetime tasks,
 * or all have already fired, or all are beyond the catch-up window).
 *
 * `notifiedInstances` is the same `notifiedAtTimeInstances` map from
 * `NotificationState`. A task is considered "already fired" when its
 * notified entry matches the `scheduledFire` we're considering.
 */
export function computeNextAtTimeFire(
	tasks: VaultTask[],
	now: Date,
	leadTimeMin: number,
	notifiedInstances: Record<string, number> = {}
): Date | null {
	const nowMs = now.getTime();
	const leadMs = leadTimeMin * 60 * 1000;
	let earliest: number | null = null;

	for (const task of tasks) {
		if (task.completed) continue;
		if (!task.deadline || task.deadline.type !== 'datetime') continue;

		const scheduledFire = task.deadline.date.getTime() - leadMs;
		// Skip tasks whose scheduled fire is in the past — those are catch-up
		// candidates handled by `dueAtTimeTasks`, not by the wake-up timer.
		if (scheduledFire < nowMs) continue;
		// Skip if the same instance was already notified.
		if (notifiedInstances[task.id] === scheduledFire) continue;

		if (earliest === null || scheduledFire < earliest) {
			earliest = scheduledFire;
		}
	}

	return earliest === null ? null : new Date(earliest);
}

/**
 * Return the list of at-time tasks that should fire right now, honouring
 * lead time, catch-up window, and the per-instance notified ledger.
 *
 * - `leadTimeMin`: minutes BEFORE the deadline the fire is scheduled. The
 *   actual wake time is `deadline - leadTimeMin`; we accept anything in
 *   `[now - catchUpWindow, now]` to cover both on-time and delayed fires.
 * - `catchUpWindowMin`: maximum minutes of delay we'll still notify for.
 *   Anything older is silently dropped (caller may still log / count it).
 * - `notifiedInstances`: short-circuit map — same shape as
 *   `NotificationState.notifiedAtTimeInstances`.
 */
export function dueAtTimeTasks(
	tasks: VaultTask[],
	now: Date,
	catchUpWindowMin: number,
	leadTimeMin: number,
	notifiedInstances: Record<string, number> = {}
): AtTimeFire[] {
	const nowMs = now.getTime();
	const leadMs = leadTimeMin * 60 * 1000;
	const catchUpMs = catchUpWindowMin * 60 * 1000;
	const fires: AtTimeFire[] = [];

	for (const task of tasks) {
		if (task.completed) continue;
		if (!task.deadline || task.deadline.type !== 'datetime') continue;

		const scheduledFire = task.deadline.date.getTime() - leadMs;
		// Too far in the past → outside catch-up window. Drop silently.
		if (scheduledFire < nowMs - catchUpMs) continue;
		// Already past the catch-up window's leading edge: also drop if
		// it's still in the future beyond our wake window.
		if (scheduledFire > nowMs) continue;
		// Already notified this exact instance.
		if (notifiedInstances[task.id] === scheduledFire) continue;

		const delayedByMs = Math.max(0, nowMs - scheduledFire);
		fires.push({
			task,
			scheduledFire,
			delayedByMinutes: Math.floor(delayedByMs / 60000)
		});
	}

	// Earliest-scheduledFire first so consumers fire in chronological order.
	fires.sort((a, b) => a.scheduledFire - b.scheduledFire);
	return fires;
}

/**
 * Mark a specific at-time instance as notified. Unlike `markAsNotified`
 * (which keys on date), this keys on the precise scheduledFire ms so the
 * same task can fire again after the user re-schedules it.
 */
export function markAtTimeInstanceNotified(
	task: VaultTask,
	scheduledFor: number,
	state: NotificationState
): void {
	state.notifiedAtTimeInstances[task.id] = scheduledFor;
	state.lastCheck = Date.now();
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
 * Convert an at-time fire into the template-field shape used by the
 * Telegram sender. Differs from `formatTaskForTelegram` in that it carries
 * the `delayedByMinutes` value (so the rendered line gets a `(delayed Xm)`
 * suffix) and uses the precise ISO deadline string when available.
 */
export function formatAtTimeFireForTelegram(fire: AtTimeFire): TelegramTaskTemplateFields {
	const task = fire.task;
	const deadline = task.deadline && task.deadline.type === 'datetime'
		? task.deadline.date.toISOString()
		: task.deadlineString || deadlineToDateString(task.deadline) || 'Unknown';
	return {
		taskName: task.text,
		fileName: task.fileName,
		deadline,
		filePath: task.filePath,
		taskId: task.id,
		delayedByMinutes: fire.delayedByMinutes > 0 ? fire.delayedByMinutes : null
	};
}

export interface DispatchAtTimeOptions {
	botToken: string;
	chatId: string;
	state: NotificationState;
	individualTemplate?: string;
	useMarkdown?: boolean;
}

/**
 * Find at-time tasks that should fire right now and send each as an
 * individual Telegram reminder. Returns the per-task results and the
 * updated state.
 *
 * The "fire now" window is `[now - catchUpWindow, now]` (relative to the
 * scheduled fire time `deadline - leadTime`). Already-notified instances
 * are short-circuited via `state.notifiedAtTimeInstances`.
 */
export async function dispatchAtTimeReminders(
	tasks: VaultTask[],
	now: Date,
	catchUpWindowMin: number,
	leadTimeMin: number,
	options: DispatchAtTimeOptions
): Promise<{
	fires: AtTimeFire[];
	sendResults: TelegramSendResult[];
	state: NotificationState;
}> {
	const {botToken, chatId, state, individualTemplate, useMarkdown} = options;
	const fires = dueAtTimeTasks(tasks, now, catchUpWindowMin, leadTimeMin, state.notifiedAtTimeInstances);
	const sendResults: TelegramSendResult[] = [];

	for (const fire of fires) {
		const fields = formatAtTimeFireForTelegram(fire);
		const result = await sendTaskReminder(
			botToken,
			chatId,
			fields.taskName,
			fields.fileName,
			fields.deadline,
			individualTemplate,
			useMarkdown,
			fields.filePath,
			fields.taskId,
			fields.delayedByMinutes
		);
		sendResults.push(result);

		if (result.success) {
			markAtTimeInstanceNotified(fire.task, fire.scheduledFire, state);
		} else {
			console.error(
				`Failed to send at-time notification for task ${fire.task.id}:`,
				sanitizeErrorMessage(String(result.error), botToken, chatId)
			);
		}
	}

	// Prune the at-time ledger alongside the date-only one.
	pruneNotificationState(state);

	return {fires, sendResults, state};
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
	useMarkdown?: boolean,
	upcomingBulkTemplate?: string,
	upcomingIndividualTemplate?: string
): Promise<{
	totalTasks: number;
	dueTasks: number;
	upcomingTasks: number;
	notifiedTasks: number;
	sendResults: TelegramSendResult[];
	state: NotificationState;
}> {
	const merged = {...DEFAULT_CHECK_OPTIONS, ...options};
	const opts: CheckDeadlinesOptions = {...merged, maxTasks: Math.max(1, merged.maxTasks)};
	const sendResults: TelegramSendResult[] = [];
	let notifiedTasksCount = 0;

	const today = new Date();

	const baseDueTasks = getDueTasks(allTasks, today);
	const dueTasks = filterDueTasksByCheckFlags(
		baseDueTasks,
		today,
		opts.checkToday,
		opts.checkOverdue
	);

	// Catch-up for the PC-off gap (issue #99): overdue tasks only notify
	// when they became overdue within the window; older ones are dropped.
	// Dropped tasks stay out of the notified ledger so a widened window or
	// a late recurring reschedule can still notify them later.
	const windowedDueTasks = filterOverdueByCatchUpWindow(
		dueTasks,
		today,
		opts.catchUpWindowMinutes ?? 0
	);

	// In strict mode the at-time scheduler owns datetime tasks; strip
	// them from the periodic check so we don't double-notify.
	const eligibleDueTasks = opts.strictTimeMode
		? windowedDueTasks.filter(task => !task.deadline || task.deadline.type !== 'datetime')
		: windowedDueTasks;

	const tasksToNotify = eligibleDueTasks.filter(task => !isAlreadyNotified(task, state));

	const upcomingToNotify = opts.daysAhead > 0
		? getUpcomingTasks(allTasks, today, opts.daysAhead)
			.filter(task => !isAlreadyNotified(task, state))
			.filter(task => !opts.strictTimeMode || !task.deadline || task.deadline.type !== 'datetime')
		: [];

	if (tasksToNotify.length === 0 && upcomingToNotify.length === 0) {
		state.lastCheck = Date.now();
		pruneNotificationState(state);
		return {
			totalTasks: allTasks.length,
			dueTasks: dueTasks.length,
			upcomingTasks: 0,
			notifiedTasks: 0,
			sendResults,
			state
		};
	}

	// --- Send due/overdue tasks using existing templates ---
	const dueLimitedTasks = tasksToNotify.slice(0, opts.maxTasks);
	const useBulk = opts.sendBulk && dueLimitedTasks.length > 1;

	if (dueLimitedTasks.length > 0) {
		if (useBulk) {
			const formattedTasks = dueLimitedTasks.map(formatTaskForTelegram);
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
				for (const task of dueLimitedTasks) {
					markAsNotified(task, state);
					notifiedTasksCount++;
				}
			}
		} else {
			for (const task of dueLimitedTasks) {
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

	// --- Send upcoming tasks using upcoming-specific templates ---
	const upcomingLimitedTasks = upcomingToNotify.slice(0, Math.max(0, opts.maxTasks - dueLimitedTasks.length));
	const useUpcomingBulk = opts.sendBulk && upcomingLimitedTasks.length > 1;

	if (upcomingLimitedTasks.length > 0) {
		if (useUpcomingBulk) {
			const formattedTasks = upcomingLimitedTasks.map(formatTaskForTelegram);
			const result = await sendBulkReminders(
				botToken,
				chatId,
				formattedTasks,
				upcomingBulkTemplate,
				upcomingIndividualTemplate,
				useMarkdown
			);
			sendResults.push(result);

			if (result.success) {
				for (const task of upcomingLimitedTasks) {
					markAsNotified(task, state);
					notifiedTasksCount++;
				}
			}
		} else {
			for (const task of upcomingLimitedTasks) {
				const formattedTask = formatTaskForTelegram(task);
				const result = await sendTaskReminder(
					botToken,
					chatId,
					formattedTask.taskName,
					formattedTask.fileName,
					formattedTask.deadline,
					upcomingIndividualTemplate,
					useMarkdown,
					formattedTask.filePath,
					formattedTask.taskId
				);
				sendResults.push(result);

				if (result.success) {
					markAsNotified(task, state);
					notifiedTasksCount++;
				} else {
					console.error(`Failed to send upcoming notification for task ${task.id}:`, sanitizeErrorMessage(
						String(result.error),
						botToken,
						chatId
					));
				}
			}
		}
	}

	pruneNotificationState(state);

	return {
		totalTasks: allTasks.length,
		dueTasks: dueTasks.length,
		upcomingTasks: upcomingLimitedTasks.length,
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
	checkOptions?: Partial<CheckDeadlinesOptions>,
	upcomingBulkTemplate?: string,
	upcomingIndividualTemplate?: string
): Promise<NotificationState> {
	try {
		const result = await checkAndNotify(allTasks, botToken, chatId, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: true,
			...checkOptions
		}, bulkTemplate, individualTemplate, undefined, useMarkdown, upcomingBulkTemplate, upcomingIndividualTemplate);

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
