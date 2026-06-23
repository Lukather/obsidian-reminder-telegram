/**
 * Unit tests for src/checker.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestUrl } from 'obsidian';

import {
	loadNotificationState,
	saveNotificationState,
	pruneNotificationState,
	checkAndNotify,
	clearTaskNotification,
	DEFAULT_NOTIFICATION_STATE,
	type NotificationState,
} from './checker';
import {
	makeInlineTask,
	makeFrontmatterTask,
	makeDeadlineDateOnly,
	allSampleTasks,
	dueTodayTasks,
} from './__fixtures__/tasks';
import {
	recentNotificationState,
	mixedAgeNotificationState,
	nearThresholdNotificationState,
	atThresholdNotificationState,
} from './__fixtures__/notification-state';

const BOT_TOKEN = 'test:bot-token-1234567890abcdef';
const CHAT_ID = 'test:chat-id-9876543210abcdef';
const REFERENCE_DATE = new Date('2026-06-11T12:00:00Z');

/** Fresh state for each test (fixtures are shared by reference). */
function freshState(): NotificationState {
	return { notifiedTasks: {}, lastCheck: 0 };
}

function mockTelegramSuccess(): void {
	(requestUrl as ReturnType<typeof vi.fn>).mockResolvedValue({
		text: JSON.stringify({ ok: true }),
		json: { ok: true },
		status: 200,
	});
}

function mockTelegramError(errorCode: number, description: string): void {
	(requestUrl as ReturnType<typeof vi.fn>).mockResolvedValue({
		text: JSON.stringify({ ok: false, error_code: errorCode, description }),
		json: { ok: false, error_code: errorCode, description },
		status: errorCode,
	});
}

// ===========================================================================
// loadNotificationState / saveNotificationState
// ===========================================================================

describe('loadNotificationState()', () => {
	it('returns default state for null/undefined', () => {
		expect(loadNotificationState(null)).toEqual(DEFAULT_NOTIFICATION_STATE);
		expect(loadNotificationState(undefined)).toEqual(DEFAULT_NOTIFICATION_STATE);
	});

	it('loads persisted state correctly', () => {
		const data = {
			notifiedTasks: { 'key1': 1000 },
			lastCheck: 999,
		};
		const state = loadNotificationState(data);
		expect(state.notifiedTasks).toEqual({ key1: 1000 });
		expect(state.lastCheck).toBe(999);
	});

	it('handles partial persisted state', () => {
		const state = loadNotificationState({ lastCheck: 42 });
		expect(state.notifiedTasks).toEqual({});
		expect(state.lastCheck).toBe(42);
	});

	it('handles non-object data', () => {
		expect(loadNotificationState('not an object')).toEqual(DEFAULT_NOTIFICATION_STATE);
		expect(loadNotificationState(42)).toEqual(DEFAULT_NOTIFICATION_STATE);
	});
});

describe('saveNotificationState()', () => {
	it('round-trips through load/save', () => {
		const state: NotificationState = {
			notifiedTasks: { 'a': 1, 'b': 2 },
			lastCheck: 123,
		};
		const saved = saveNotificationState(state);
		const loaded = loadNotificationState(saved);
		expect(loaded).toEqual(state);
	});
});

// ===========================================================================
// pruneNotificationState
// ===========================================================================

describe('pruneNotificationState()', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(REFERENCE_DATE);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('does nothing with empty state', () => {
		const state = freshState();
		pruneNotificationState(state);
		expect(Object.keys(state.notifiedTasks)).toHaveLength(0);
	});

	it('prunes entries older than 30 days even when under 1000 cap', () => {
		const state = mixedAgeNotificationState;
		const before = Object.keys(state.notifiedTasks).length;
		expect(before).toBe(2);

		pruneNotificationState(state);

		const after = Object.keys(state.notifiedTasks).length;
		// The vintage entry (60 days old) should be pruned, the recent (5 days) kept
		expect(after).toBe(1);
		const remainingKey = Object.keys(state.notifiedTasks)[0]!;
		expect(remainingKey).toContain('recent');
	});

	it('keeps all entries under 30 days when under 1000 cap', () => {
		const state = recentNotificationState;
		pruneNotificationState(state);
		expect(Object.keys(state.notifiedTasks)).toHaveLength(2);
	});

	it('caps at 1000 most recent when over cap', () => {
		const state = nearThresholdNotificationState;
		expect(Object.keys(state.notifiedTasks).length).toBe(1001);

		pruneNotificationState(state);

		// After age pruning: 500 fresh entries survive (the 501 stale ones are 40 days old → pruned)
		// So we should have 500 entries, well under 1000 cap
		expect(Object.keys(state.notifiedTasks).length).toBeLessThanOrEqual(1000);
	});

	it('does not prune at exactly 1000 entries if all recent', () => {
		const state = atThresholdNotificationState;
		pruneNotificationState(state);
		expect(Object.keys(state.notifiedTasks)).toHaveLength(1000);
	});
});

// ===========================================================================
// clearTaskNotification
// ===========================================================================

describe('clearTaskNotification()', () => {
	it('removes a task from notification state', () => {
		const task = dueTodayTasks[0]!;
		const state = recentNotificationState;
		const key = `notified:${task.id}:2026-06-11`;
		state.notifiedTasks[key] = Date.now();
		expect(state.notifiedTasks[key]).toBeDefined();

		clearTaskNotification(task, state);
		expect(state.notifiedTasks[key]).toBeUndefined();
	});

	it('is a no-op if task was not notified', () => {
		const state = freshState();
		const task = dueTodayTasks[0]!;
		clearTaskNotification(task, state);
		expect(Object.keys(state.notifiedTasks)).toHaveLength(0);
	});
});

// ===========================================================================
// checkAndNotify
// ===========================================================================

describe('checkAndNotify()', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(REFERENCE_DATE);
		mockTelegramSuccess();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns zero notified for empty task list', async () => {
		const state = freshState();
		const result = await checkAndNotify([], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: true,
			maxTasks: 10,
		});

		expect(result.notifiedTasks).toBe(0);
		expect(result.dueTasks).toBe(0);
		expect(result.sendResults).toEqual([]);
	});

	it('updates lastCheck even when no tasks to notify', async () => {
		const state: NotificationState = { notifiedTasks: {}, lastCheck: 0 };
		await checkAndNotify([], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			maxTasks: 10,
		});
		expect(state.lastCheck).toBeGreaterThan(0);
	});

	it('notifies due and overdue tasks in bulk mode', async () => {
		const state = freshState();
		// Use dueTodayTasks (3 tasks due today) + overdue from allSampleTasks
		const dueToday = dueTodayTasks;
		const overdue = allSampleTasks.filter(
			t => !t.completed && t.deadline !== null && t.deadline.type === 'date-only'
			&& t.deadline.year < 2026
		);

		const result = await checkAndNotify([...dueToday, ...overdue], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: true,
			maxTasks: 10,
		});

		expect(result.notifiedTasks).toBeGreaterThan(0);
		expect(result.sendResults.length).toBe(1); // single bulk message
		expect(result.sendResults[0]!.success).toBe(true);
	});

	it('notifies individual tasks when sendBulk=false', async () => {
		const state = freshState();
		const tasks = dueTodayTasks.slice(0, 2);

		const result = await checkAndNotify(tasks, BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: false,
			maxTasks: 10,
		});

		// One send per task (no bulk)
		expect(result.sendResults.length).toBe(2);
		expect(result.notifiedTasks).toBe(2);
	});

	it('skips already-notified tasks', async () => {
		const task = dueTodayTasks[0]!;
		const state = freshState();
		// Pre-mark the task as notified
		const key = `notified:${task.id}:2026-06-11`;
		state.notifiedTasks[key] = Date.now();

		const result = await checkAndNotify([task], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: true,
			maxTasks: 10,
		});

		expect(result.notifiedTasks).toBe(0);
		expect(result.sendResults).toEqual([]);
	});

	it('respects maxTasks cap', async () => {
		const state = freshState();
		// 3 due today tasks
		const tasks = dueTodayTasks;

		const result = await checkAndNotify(tasks, BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: true,
			maxTasks: 2,
		});

		// Only 2 tasks should be notified (bulk mode → 1 send result with 2 tasks marked)
		expect(result.notifiedTasks).toBe(2);
		expect(result.sendResults.length).toBe(1);
	});

	it('includes upcoming tasks when daysAhead > 0', async () => {
		const state = freshState();
		// Use upcomingTasks from fixtures (due 2026-06-15 and 2026-06-20)
		const upcoming = allSampleTasks.filter(
			t => !t.completed && t.deadline !== null && t.deadline.type === 'date-only'
			&& t.deadline.year === 2026 && t.deadline.month === 6 && t.deadline.day > 11
		);
		expect(upcoming.length).toBeGreaterThan(0);

		const result = await checkAndNotify(upcoming, BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			daysAhead: 10,
			sendBulk: true,
			maxTasks: 10,
		});

		expect(result.notifiedTasks).toBeGreaterThan(0);
	});

	it('excludes upcoming tasks when daysAhead = 0', async () => {
		const state = freshState();
		// Only upcoming tasks (no due/overdue)
		const upcoming = allSampleTasks.filter(
			t => !t.completed && t.deadline !== null && t.deadline.type === 'date-only'
			&& t.deadline.year === 2026 && t.deadline.month === 6 && t.deadline.day > 11
		);

		const result = await checkAndNotify(upcoming, BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			daysAhead: 0,
			sendBulk: true,
			maxTasks: 10,
		});

		expect(result.notifiedTasks).toBe(0);
	});

	it('marks tasks as notified in state after successful bulk send', async () => {
		const state = freshState();
		const tasks = dueTodayTasks.slice(0, 2);

		await checkAndNotify(tasks, BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: true,
			maxTasks: 10,
		});

		expect(Object.keys(state.notifiedTasks).length).toBe(2);
		expect(state.lastCheck).toBeGreaterThan(0);
	});

	it('does not mark tasks as notified when send fails', async () => {
		mockTelegramError(400, 'Bad Request');
		const state = freshState();
		const tasks = dueTodayTasks.slice(0, 2);

		await checkAndNotify(tasks, BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: true,
			maxTasks: 10,
		});

		// Bulk send failed → no tasks should be marked
		expect(Object.keys(state.notifiedTasks).length).toBe(0);
	});

	it('does not mark individual task as notified when its send fails', async () => {
		mockTelegramError(400, 'Bad Request');
		const state = freshState();
		const task = dueTodayTasks[0]!;

		const result = await checkAndNotify([task], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: false,
			maxTasks: 10,
		});

		expect(result.notifiedTasks).toBe(0);
		expect(Object.keys(state.notifiedTasks).length).toBe(0);
	});

	it('uses default options when none provided', async () => {
		const state = freshState();
		const result = await checkAndNotify([], BOT_TOKEN, CHAT_ID, state);
		expect(result.totalTasks).toBe(0);
		expect(result.notifiedTasks).toBe(0);
	});

	it('deduplicates tasks that appear in both due and upcoming lists', async () => {
		const state = freshState();
		// A task due today should not also appear as upcoming
		const tasks = dueTodayTasks;

		const result = await checkAndNotify(tasks, BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			daysAhead: 7,
			sendBulk: true,
			maxTasks: 10,
		});

		// All 3 due-today tasks, no duplicates from upcoming
		expect(result.notifiedTasks).toBe(3);
	});
});

// ===========================================================================
// checkAndNotify with checkToday/checkOverdue flags
// ===========================================================================

describe('checkAndNotify() with check flags', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(REFERENCE_DATE);
		mockTelegramSuccess();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('filters to only today when checkOverdue=false', async () => {
		const state = freshState();
		const overdueTask = makeInlineTask({
			id: 'inline:overdue.md:2026-06-01:ov1',
			deadline: makeDeadlineDateOnly(2026, 6, 1),
		});
		const todayTask = makeInlineTask({
			id: 'inline:today.md:2026-06-11:td1',
			deadline: makeDeadlineDateOnly(2026, 6, 11),
		});

		const result = await checkAndNotify([overdueTask, todayTask], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: false,
			sendBulk: true,
			maxTasks: 10,
		});

		expect(result.dueTasks).toBe(1); // only today
		expect(result.notifiedTasks).toBe(1);
	});

	it('filters to only overdue when checkToday=false', async () => {
		const state = freshState();
		const overdueTask = makeInlineTask({
			id: 'inline:overdue.md:2026-06-01:ov1',
			deadline: makeDeadlineDateOnly(2026, 6, 1),
		});
		const todayTask = makeInlineTask({
			id: 'inline:today.md:2026-06-11:td1',
			deadline: makeDeadlineDateOnly(2026, 6, 11),
		});

		const result = await checkAndNotify([overdueTask, todayTask], BOT_TOKEN, CHAT_ID, state, {
			checkToday: false,
			checkOverdue: true,
			sendBulk: true,
			maxTasks: 10,
		});

		expect(result.dueTasks).toBe(1); // only overdue
		expect(result.notifiedTasks).toBe(1);
	});
});
