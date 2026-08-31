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
	computeNextAtTimeFire,
	dueAtTimeTasks,
	markAtTimeInstanceNotified,
	dispatchAtTimeReminders,
	DEFAULT_NOTIFICATION_STATE,
	type NotificationState,
} from './checker';
import {
	makeInlineTask,
	makeDeadlineDateOnly,
	makeDeadlineDateTime,
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
	return { notifiedTasks: {}, notifiedAtTimeInstances: {}, lastCheck: 0 };
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
			notifiedAtTimeInstances: { 'task-a': 2000 },
			lastCheck: 999,
		};
		const state = loadNotificationState(data);
		expect(state.notifiedTasks).toEqual({ key1: 1000 });
		expect(state.notifiedAtTimeInstances).toEqual({ 'task-a': 2000 });
		expect(state.lastCheck).toBe(999);
	});

	it('handles partial persisted state', () => {
		const state = loadNotificationState({ lastCheck: 42 });
		expect(state.notifiedTasks).toEqual({});
		expect(state.notifiedAtTimeInstances).toEqual({});
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
			notifiedAtTimeInstances: { 'task-x': 9000 },
			lastCheck: 123,
		};
		const saved = saveNotificationState(state);
		const loaded = loadNotificationState(saved);
		expect(loaded).toEqual(state);
	});

	it('round-trips an empty at-time ledger', () => {
		const state: NotificationState = {
			notifiedTasks: {},
			notifiedAtTimeInstances: {},
			lastCheck: 0,
		};
		const saved = saveNotificationState(state);
		const loaded = loadNotificationState(saved);
		expect(loaded.notifiedAtTimeInstances).toEqual({});
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
		const state: NotificationState = { notifiedTasks: {}, notifiedAtTimeInstances: {}, lastCheck: 0 };
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

// ===========================================================================
// checkAndNotify with strictTimeMode (issue #89)
// ===========================================================================

describe('checkAndNotify() with strictTimeMode', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(REFERENCE_DATE);
		mockTelegramSuccess();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('excludes at-time (datetime) tasks when strictTimeMode is on', async () => {
		const state = freshState();
		const dateOnlyTask = makeInlineTask({
			id: 'inline:dateonly.md:2026-06-11:ds1',
			deadline: makeDeadlineDateOnly(2026, 6, 11),
		});
		const datetimeTask = makeInlineTask({
			id: 'inline:datetime.md:2026-06-11T15:00:00:dt1',
			deadline: makeDeadlineDateTime('2026-06-11T15:00:00'),
		});

		const result = await checkAndNotify([dateOnlyTask, datetimeTask], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: true,
			maxTasks: 10,
			strictTimeMode: true
		});

		// Only the date-only task is notified; the datetime task is
		// owned by the AtTimeScheduler in strict mode.
		expect(result.notifiedTasks).toBe(1);
	});

	it('includes at-time (datetime) tasks when strictTimeMode is off (default)', async () => {
		const state = freshState();
		const dateOnlyTask = makeInlineTask({
			id: 'inline:dateonly.md:2026-06-11:ds2',
			deadline: makeDeadlineDateOnly(2026, 6, 11),
		});
		const datetimeTask = makeInlineTask({
			id: 'inline:datetime.md:2026-06-11T15:00:00:dt2',
			deadline: makeDeadlineDateTime('2026-06-11T15:00:00'),
		});

		const result = await checkAndNotify([dateOnlyTask, datetimeTask], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: true,
			maxTasks: 10,
		});

		// Both tasks are notified when strictTimeMode is off.
		expect(result.notifiedTasks).toBe(2);
	});
});

// ===========================================================================
// checkAndNotify with the overdue catch-up window (issue #99)
// ===========================================================================

describe('checkAndNotify() with overdue catch-up window (issue #99)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(REFERENCE_DATE); // 2026-06-11T12:00:00Z
		mockTelegramSuccess();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** A datetime deadline 24h before the reference time (clearly overdue). */
	const overdue24h = makeInlineTask({
		id: 'inline:overdue24h.md:2026-06-10T12:00:00:od1',
		deadline: makeDeadlineDateTime('2026-06-10T12:00:00'),
	});

	it('fires an overdue task inside the catch-up window (PC was off briefly)', async () => {
		const state = freshState();
		// 24h overdue, window 25h → within window → fires.
		const result = await checkAndNotify([overdue24h], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: true,
			maxTasks: 10,
			catchUpWindowMinutes: 1500,
		});

		expect(result.notifiedTasks).toBe(1);
		expect(result.sendResults.length).toBe(1);
		expect(result.sendResults[0]!.success).toBe(true);
	});

	it('silently drops an overdue task outside the catch-up window', async () => {
		const state = freshState();
		// 24h overdue, window 60min → outside → dropped, but still counted as due.
		const result = await checkAndNotify([overdue24h], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: true,
			maxTasks: 10,
			catchUpWindowMinutes: 60,
		});

		expect(result.dueTasks).toBe(1); // still a due/overdue task overall
		expect(result.notifiedTasks).toBe(0);
		expect(result.sendResults).toEqual([]);
	});

	it('fires tasks due today regardless of the catch-up window', async () => {
		const state = freshState();
		const dueTodayTask = makeInlineTask({
			id: 'inline:today.md:2026-06-11:cw1',
			deadline: makeDeadlineDateOnly(2026, 6, 11),
		});

		const result = await checkAndNotify([dueTodayTask], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: true,
			maxTasks: 10,
			catchUpWindowMinutes: 60,
		});

		expect(result.notifiedTasks).toBe(1);
	});

	it('drops a date-only overdue task outside the window (silently)', async () => {
		const state = freshState();
		// Due 2026-06-01 → ≥10 days overdue at reference time, far beyond any sane window.
		const oldOverdue = makeInlineTask({
			id: 'inline:old.md:2026-06-01:cw2',
			deadline: makeDeadlineDateOnly(2026, 6, 1),
		});

		const result = await checkAndNotify([oldOverdue], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: true,
			maxTasks: 10,
			catchUpWindowMinutes: 60,
		});

		expect(result.dueTasks).toBe(1);
		expect(result.notifiedTasks).toBe(0);
		expect(result.sendResults).toEqual([]);
	});

	it('keeps notifying old overdue tasks when the window is disabled (0 / default)', async () => {
		const state = freshState();
		const oldOverdue = makeInlineTask({
			id: 'inline:old.md:2026-06-01:cw3',
			deadline: makeDeadlineDateOnly(2026, 6, 1),
		});

		const result = await checkAndNotify([oldOverdue], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: true,
			maxTasks: 10,
		});

		expect(result.notifiedTasks).toBe(1);
	});

	it('fires a missed upcoming task that became overdue within the window on open', async () => {
		const state = freshState();
		// Was upcoming while the PC was off; now overdue by 24h — inside a 25h window.
		const result = await checkAndNotify([overdue24h], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			daysAhead: 7,
			sendBulk: true,
			maxTasks: 10,
			catchUpWindowMinutes: 1500,
		});

		expect(result.notifiedTasks).toBe(1);
	});

	it('still fires genuinely-upcoming tasks after the app was closed (window only gates overdue)', async () => {
		const state = freshState();
		const upcomingTask = makeInlineTask({
			id: 'inline:upcoming.md:2026-06-13:cw4',
			deadline: makeDeadlineDateOnly(2026, 6, 13),
		});

		const result = await checkAndNotify([upcomingTask], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			daysAhead: 7,
			sendBulk: true,
			maxTasks: 10,
			catchUpWindowMinutes: 60,
		});

		expect(result.notifiedTasks).toBe(1);
	});
});

// ===========================================================================
// At-time scheduler helpers (issue #89)
// ===========================================================================

describe('computeNextAtTimeFire()', () => {
	const NOW = new Date('2026-06-11T12:00:00Z');

	it('returns the next datetime deadline minus lead', () => {
		const t = makeInlineTask({
			deadline: makeDeadlineDateTime('2026-06-11T13:00:00'),
		});
		const next = computeNextAtTimeFire([t], NOW, 0, {});
		expect(next?.toISOString()).toBe('2026-06-11T13:00:00.000Z');
	});

	it('subtracts lead time from the deadline', () => {
		const t = makeInlineTask({
			deadline: makeDeadlineDateTime('2026-06-11T13:00:00'),
		});
		const next = computeNextAtTimeFire([t], NOW, 15, {});
		expect(next?.toISOString()).toBe('2026-06-11T12:45:00.000Z');
	});

	it('returns the earliest when multiple at-time tasks exist', () => {
		const a = makeInlineTask({
			id: 'inline:a.md:2026-06-11T15:00:00:aaa1',
			deadline: makeDeadlineDateTime('2026-06-11T15:00:00'),
		});
		const b = makeInlineTask({
			id: 'inline:b.md:2026-06-11T13:00:00:bbb1',
			deadline: makeDeadlineDateTime('2026-06-11T13:00:00'),
		});
		const next = computeNextAtTimeFire([a, b], NOW, 0, {});
		expect(next?.toISOString()).toBe('2026-06-11T13:00:00.000Z');
	});

	it('returns null when no datetime tasks exist', () => {
		const t = makeInlineTask({
			deadline: makeDeadlineDateOnly(2026, 6, 11),
		});
		expect(computeNextAtTimeFire([t], NOW, 0, {})).toBeNull();
	});

	it('returns null when all tasks are completed', () => {
		const t = makeInlineTask({
			deadline: makeDeadlineDateTime('2026-06-11T13:00:00'),
			completed: true,
		});
		expect(computeNextAtTimeFire([t], NOW, 0, {})).toBeNull();
	});

	it('skips tasks whose scheduledFire is in the past', () => {
		const past = makeInlineTask({
			id: 'inline:past.md:2026-06-11T10:00:00:pp01',
			deadline: makeDeadlineDateTime('2026-06-11T10:00:00'),
		});
		const future = makeInlineTask({
			id: 'inline:future.md:2026-06-11T13:00:00:ff01',
			deadline: makeDeadlineDateTime('2026-06-11T13:00:00'),
		});
		const next = computeNextAtTimeFire([past, future], NOW, 0, {});
		expect(next?.toISOString()).toBe('2026-06-11T13:00:00.000Z');
	});

	it('skips tasks already notified at the same scheduledFire', () => {
		const t = makeInlineTask({
			deadline: makeDeadlineDateTime('2026-06-11T13:00:00'),
		});
		const scheduledFire = new Date('2026-06-11T13:00:00Z').getTime();
		expect(computeNextAtTimeFire([t], NOW, 0, { [t.id]: scheduledFire })).toBeNull();
	});

	it('returns a future wake for tasks past the catch-up window (catch-up is for now-fires only)', () => {
		const t = makeInlineTask({
			deadline: makeDeadlineDateTime('2026-06-11T13:00:00'),
		});
		// catchUpWindowMinutes doesn't filter the *future* wake \u2014 only
		// `dueAtTimeTasks` honours it for catch-up candidates.
		const next = computeNextAtTimeFire([t], NOW, 0, {});
		expect(next?.toISOString()).toBe('2026-06-11T13:00:00.000Z');
	});
});

describe('dueAtTimeTasks()', () => {
	const NOW = new Date('2026-06-11T12:00:00Z');

	it('returns tasks whose scheduledFire is in the catch-up window', () => {
		const past = makeInlineTask({
			id: 'inline:past.md:2026-06-11T11:30:00:pp01',
			deadline: makeDeadlineDateTime('2026-06-11T11:30:00'),
		});
		const fires = dueAtTimeTasks([past], NOW, 60, 0, {});
		expect(fires).toHaveLength(1);
		expect(fires[0]!.task.id).toBe(past.id);
		expect(fires[0]!.delayedByMinutes).toBe(30);
	});

	it('reports delayedByMinutes=0 for on-time fires', () => {
		const onTime = makeInlineTask({
			id: 'inline:now.md:2026-06-11T12:00:00:nn01',
			deadline: makeDeadlineDateTime('2026-06-11T12:00:00'),
		});
		const fires = dueAtTimeTasks([onTime], NOW, 60, 0, {});
		expect(fires).toHaveLength(1);
		expect(fires[0]!.delayedByMinutes).toBe(0);
	});

	it('drops tasks past the catch-up window', () => {
		const oldTask = makeInlineTask({
			id: 'inline:old.md:2026-06-11T10:00:00:oo01',
			deadline: makeDeadlineDateTime('2026-06-11T10:00:00'),
		});
		// 2h delay, catch-up = 60m → silently dropped
		const fires = dueAtTimeTasks([oldTask], NOW, 60, 0, {});
		expect(fires).toEqual([]);
	});

	it('drops tasks whose scheduledFire is in the future (not yet due)', () => {
		const future = makeInlineTask({
			id: 'inline:future.md:2026-06-11T15:00:00:ff01',
			deadline: makeDeadlineDateTime('2026-06-11T15:00:00'),
		});
		const fires = dueAtTimeTasks([future], NOW, 60, 0, {});
		expect(fires).toEqual([]);
	});

	it('skips already-notified instances', () => {
		const t = makeInlineTask({
			id: 'inline:skip.md:2026-06-11T11:00:00:ss01',
			deadline: makeDeadlineDateTime('2026-06-11T11:00:00'),
		});
		const scheduledFire = new Date('2026-06-11T11:00:00Z').getTime();
		const fires = dueAtTimeTasks([t], NOW, 60, 0, { [t.id]: scheduledFire });
		expect(fires).toEqual([]);
	});

	it('fires a re-scheduled instance even if the same task was notified before', () => {
		const t = makeInlineTask({
			id: 'inline:resched.md:2026-06-11T11:30:00:rr01',
			deadline: makeDeadlineDateTime('2026-06-11T11:30:00'),
		});
		// Previous scheduledFire was different (e.g. 10:00) — current
		// scheduledFire (11:30) is new and should still fire.
		const fires = dueAtTimeTasks([t], NOW, 60, 0, {
			[t.id]: new Date('2026-06-11T10:00:00Z').getTime(),
		});
		expect(fires).toHaveLength(1);
	});

	it('skips completed and date-only tasks', () => {
		const completed = makeInlineTask({
			id: 'inline:done.md:2026-06-11T11:00:00:dd01',
			deadline: makeDeadlineDateTime('2026-06-11T11:00:00'),
			completed: true,
		});
		const dateOnly = makeInlineTask({
			id: 'inline:dateonly.md:2026-06-11:dp01',
			deadline: makeDeadlineDateOnly(2026, 6, 11),
		});
		const fires = dueAtTimeTasks([completed, dateOnly], NOW, 60, 0, {});
		expect(fires).toEqual([]);
	});

	it('returns multiple fires sorted by scheduledFire ascending', () => {
		const a = makeInlineTask({
			id: 'inline:a.md:2026-06-11T11:50:00:aa1',
			deadline: makeDeadlineDateTime('2026-06-11T11:50:00'),
		});
		const b = makeInlineTask({
			id: 'inline:b.md:2026-06-11T11:00:00:bb1',
			deadline: makeDeadlineDateTime('2026-06-11T11:00:00'),
		});
		const c = makeInlineTask({
			id: 'inline:c.md:2026-06-11T11:30:00:cc1',
			deadline: makeDeadlineDateTime('2026-06-11T11:30:00'),
		});
		const fires = dueAtTimeTasks([a, b, c], NOW, 60, 0, {});
		expect(fires.map(f => f.task.id)).toEqual([b.id, c.id, a.id]);
	});

	it('catch-up window of 0 drops anything from the past', () => {
		const past = makeInlineTask({
			id: 'inline:past.md:2026-06-11T11:59:00:pp01',
			deadline: makeDeadlineDateTime('2026-06-11T11:59:00'),
		});
		expect(dueAtTimeTasks([past], NOW, 0, 0, {})).toEqual([]);
	});

	it('honours lead time when computing scheduledFire', () => {
		// Task deadline 12:00, lead 10min → scheduledFire = 11:50.
		// At 12:00, the fire is 10 min late.
		const t = makeInlineTask({
			id: 'inline:lead.md:2026-06-11T12:00:00:ll01',
			deadline: makeDeadlineDateTime('2026-06-11T12:00:00'),
		});
		const fires = dueAtTimeTasks([t], NOW, 60, 10, {});
		expect(fires).toHaveLength(1);
		expect(fires[0]!.delayedByMinutes).toBe(10);
	});
});

describe('markAtTimeInstanceNotified()', () => {
	it('records scheduledFire under the task id', () => {
		const t = makeInlineTask({
			deadline: makeDeadlineDateTime('2026-06-11T13:00:00'),
		});
		const state = freshState();
		const scheduledFire = new Date('2026-06-11T13:00:00Z').getTime();
		markAtTimeInstanceNotified(t, scheduledFire, state);
		expect(state.notifiedAtTimeInstances[t.id]).toBe(scheduledFire);
	});

	it('updates lastCheck', () => {
		const t = makeInlineTask({
			deadline: makeDeadlineDateTime('2026-06-11T13:00:00'),
		});
		const state = freshState();
		const before = state.lastCheck;
		markAtTimeInstanceNotified(t, Date.now(), state);
		expect(state.lastCheck).toBeGreaterThanOrEqual(before);
	});

	it('overwrites the previous entry for the same task', () => {
		const t = makeInlineTask({
			deadline: makeDeadlineDateTime('2026-06-11T13:00:00'),
		});
		const state = freshState();
		const oldFire = new Date('2026-06-11T10:00:00Z').getTime();
		const newFire = new Date('2026-06-11T13:00:00Z').getTime();
		markAtTimeInstanceNotified(t, oldFire, state);
		markAtTimeInstanceNotified(t, newFire, state);
		expect(state.notifiedAtTimeInstances[t.id]).toBe(newFire);
	});
});

// ===========================================================================
// dispatchAtTimeReminders (issue #89)
// ===========================================================================

describe('dispatchAtTimeReminders()', () => {
	const NOW = new Date('2026-06-11T12:00:00Z');

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		mockTelegramSuccess();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('sends an individual reminder for a fire in the catch-up window', async () => {
		const task = makeInlineTask({
			id: 'inline:at-time.md:2026-06-11T11:30:00:at01',
			text: 'At-time task',
			deadline: makeDeadlineDateTime('2026-06-11T11:30:00'),
		});
		const state = freshState();
		const result = await dispatchAtTimeReminders([task], NOW, 60, 0, {
			botToken: BOT_TOKEN,
			chatId: CHAT_ID,
			state
		});
		expect(result.fires).toHaveLength(1);
		expect(result.sendResults).toHaveLength(1);
		expect(result.sendResults[0]!.success).toBe(true);
	});

	it('appends (delayed Xm) when the fire is past scheduledFire', async () => {
		const task = makeInlineTask({
			id: 'inline:delay.md:2026-06-11T11:00:00:dl01',
			text: 'Delayed task',
			deadline: makeDeadlineDateTime('2026-06-11T11:00:00'),
		});
		const state = freshState();
		await dispatchAtTimeReminders([task], NOW, 60, 0, {
			botToken: BOT_TOKEN,
			chatId: CHAT_ID,
			state,
			individualTemplate: 'Task: {taskName} ({deadline})'
		});
		const calls = (requestUrl as ReturnType<typeof vi.fn>).mock.calls;
		const lastCall = calls[calls.length - 1]!;
		const arg = lastCall[0] as { body?: string };
		const body = arg.body ? JSON.parse(arg.body) as { text?: string } : {};
		expect(body.text).toContain('(delayed 60m)');
	});

	it('does not append a delay suffix for on-time fires', async () => {
		const task = makeInlineTask({
			id: 'inline:ontime.md:2026-06-11T12:00:00:ot01',
			text: 'On-time task',
			deadline: makeDeadlineDateTime('2026-06-11T12:00:00'),
		});
		const state = freshState();
		await dispatchAtTimeReminders([task], NOW, 60, 0, {
			botToken: BOT_TOKEN,
			chatId: CHAT_ID,
			state,
			individualTemplate: 'Task: {taskName}'
		});
		const calls = (requestUrl as ReturnType<typeof vi.fn>).mock.calls;
		const lastCall = calls[calls.length - 1]!;
		const arg = lastCall[0] as { body?: string };
		const body = arg.body ? JSON.parse(arg.body) as { text?: string } : {};
		expect(body.text).not.toContain('delayed');
	});

	it('marks the instance as notified after a successful send', async () => {
		const task = makeInlineTask({
			id: 'inline:mark.md:2026-06-11T11:00:00:mm01',
			deadline: makeDeadlineDateTime('2026-06-11T11:00:00'),
		});
		const state = freshState();
		await dispatchAtTimeReminders([task], NOW, 60, 0, {
			botToken: BOT_TOKEN,
			chatId: CHAT_ID,
			state
		});
		const scheduledFire = new Date('2026-06-11T11:00:00Z').getTime();
		expect(state.notifiedAtTimeInstances[task.id]).toBe(scheduledFire);
	});

	it('does NOT mark the instance when the send fails', async () => {
		mockTelegramError(400, 'Bad Request');
		const task = makeInlineTask({
			id: 'inline:fail.md:2026-06-11T11:00:00:ff01',
			deadline: makeDeadlineDateTime('2026-06-11T11:00:00'),
		});
		const state = freshState();
		await dispatchAtTimeReminders([task], NOW, 60, 0, {
			botToken: BOT_TOKEN,
			chatId: CHAT_ID,
			state
		});
		expect(state.notifiedAtTimeInstances[task.id]).toBeUndefined();
	});

	it('returns an empty fires array when nothing matches', async () => {
		const state = freshState();
		const result = await dispatchAtTimeReminders([], NOW, 60, 0, {
			botToken: BOT_TOKEN,
			chatId: CHAT_ID,
			state
		});
		expect(result.fires).toEqual([]);
		expect(result.sendResults).toEqual([]);
	});
});

// ===========================================================================
// checkAndNotify with separate upcoming templates (issue #87)
// ===========================================================================

describe('checkAndNotify() with separate upcoming templates', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(REFERENCE_DATE);
		mockTelegramSuccess();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('sends upcoming tasks using upcoming-specific templates', async () => {
		const state = freshState();
		// Only upcoming tasks (no due/overdue)
		const upcoming = allSampleTasks.filter(
			t => !t.completed && t.deadline !== null && t.deadline.type === 'date-only'
			&& t.deadline.year === 2026 && t.deadline.month === 6 && t.deadline.day > 11
		);
		expect(upcoming.length).toBeGreaterThan(0);

		const customUpcomingTemplate = 'Upcoming: {taskName}';
		const customUpcomingBulkTemplate = 'UPCOMING ({count}): {tasks}';

		const result = await checkAndNotify(upcoming, BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			daysAhead: 10,
			sendBulk: false,
			maxTasks: 10,
		},
		// bulkTemplate, individualTemplate, testTemplate, useMarkdown
		undefined, 'Regular: {taskName}', undefined, false,
		// upcomingBulkTemplate, upcomingIndividualTemplate
		customUpcomingBulkTemplate, customUpcomingTemplate
		);

		expect(result.notifiedTasks).toBeGreaterThan(0);
		expect(result.upcomingTasks).toBeGreaterThan(0);

		// Verify the upcoming template was used in the sent messages
		const calls = (requestUrl as ReturnType<typeof vi.fn>).mock.calls;
		for (const call of calls) {
			const arg = call[0] as { body?: string };
			const body = arg.body ? JSON.parse(arg.body) as { text?: string } : {};
			expect(body.text).toContain('Upcoming:');
		}
	});

	it('sends due tasks using regular templates even when upcoming templates are set', async () => {
		const state = freshState();
		const tasks = dueTodayTasks.slice(0, 2);

		const customUpcomingTemplate = 'Upcoming: {taskName}';
		const customUpcomingBulkTemplate = 'UPCOMING ({count}): {tasks}';

		const result = await checkAndNotify(tasks, BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			sendBulk: false,
			maxTasks: 10,
		},
		// bulkTemplate, individualTemplate, testTemplate, useMarkdown
		undefined, 'Regular: {taskName}', undefined, false,
		// upcomingBulkTemplate, upcomingIndividualTemplate
		customUpcomingBulkTemplate, customUpcomingTemplate
		);

		expect(result.notifiedTasks).toBe(2);

		// Verify the regular template was used, not the upcoming one
		const calls = (requestUrl as ReturnType<typeof vi.fn>).mock.calls;
		for (const call of calls) {
			const arg = call[0] as { body?: string };
			const body = arg.body ? JSON.parse(arg.body) as { text?: string } : {};
			expect(body.text).toContain('Regular:');
			expect(body.text).not.toContain('Upcoming:');
		}
	});

	it('sends separate messages for due and upcoming tasks', async () => {
		const state = freshState();
		// Mix of due and upcoming tasks
		const dueTask = dueTodayTasks[0]!;
		const upcomingTask = makeInlineTask({
			id: 'inline:upcoming/future.md:2026-06-15:sep01',
			text: 'Future task',
			deadline: makeDeadlineDateOnly(2026, 6, 15),
			deadlineString: '📅 2026-06-15',
		});

		const result = await checkAndNotify([dueTask, upcomingTask], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			daysAhead: 7,
			sendBulk: false,
			maxTasks: 10,
		},
		undefined, 'Due: {taskName}', undefined, false,
		undefined, 'Future: {taskName}'
		);

		// Should get 2 send results (one for due, one for upcoming)
		expect(result.sendResults.length).toBe(2);
		expect(result.notifiedTasks).toBe(2);

		// Verify different templates were used
		const calls = (requestUrl as ReturnType<typeof vi.fn>).mock.calls;
		const messages = calls.map((call: unknown[]) => {
			const arg = call[0] as { body?: string };
			return arg.body ? (JSON.parse(arg.body) as { text?: string }).text : '';
		});

		const hasDueMessage = messages.some((msg: string) => msg.includes('Due:'));
		const hasFutureMessage = messages.some((msg: string) => msg.includes('Future:'));
		expect(hasDueMessage).toBe(true);
		expect(hasFutureMessage).toBe(true);
	});

	it('sends bulk upcoming tasks with upcoming bulk template', async () => {
		const state = freshState();
		const upcoming1 = makeInlineTask({
			id: 'inline:upcoming/f1.md:2026-06-15:ub01',
			text: 'Task A',
			deadline: makeDeadlineDateOnly(2026, 6, 15),
			deadlineString: '📅 2026-06-15',
		});
		const upcoming2 = makeInlineTask({
			id: 'inline:upcoming/f2.md:2026-06-16:ub02',
			text: 'Task B',
			deadline: makeDeadlineDateOnly(2026, 6, 16),
			deadlineString: '📅 2026-06-16',
		});

		const customUpcomingBulkTemplate = 'UPCOMING DIGEST ({count}):\n\n{tasks}';

		const result = await checkAndNotify([upcoming1, upcoming2], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			daysAhead: 7,
			sendBulk: true,
			maxTasks: 10,
		},
		'Due bulk: {count}', 'Due: {taskName}', undefined, false,
		customUpcomingBulkTemplate, 'Up: {taskName}'
		);

		expect(result.notifiedTasks).toBe(2);

		// Verify the upcoming bulk template was used
		const calls = (requestUrl as ReturnType<typeof vi.fn>).mock.calls;
		const lastCall = calls[calls.length - 1]!;
		const arg = lastCall[0] as { body?: string };
		const body = arg.body ? JSON.parse(arg.body) as { text?: string } : {};
		expect(body.text).toContain('UPCOMING DIGEST');
		expect(body.text).not.toContain('Due bulk');
	});

	it('respects maxTasks across both due and upcoming', async () => {
		const state = freshState();
		// 2 due tasks + 2 upcoming tasks = 4 total
		const tasks = [...dueTodayTasks.slice(0, 2)];
		const upcoming1 = makeInlineTask({
			id: 'inline:upcoming/f1.md:2026-06-15:mx01',
			text: 'Upcoming A',
			deadline: makeDeadlineDateOnly(2026, 6, 15),
			deadlineString: '📅 2026-06-15',
		});
		const upcoming2 = makeInlineTask({
			id: 'inline:upcoming/f2.md:2026-06-16:mx02',
			text: 'Upcoming B',
			deadline: makeDeadlineDateOnly(2026, 6, 16),
			deadlineString: '📅 2026-06-16',
		});
		tasks.push(upcoming1, upcoming2);

		const result = await checkAndNotify(tasks, BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			daysAhead: 7,
			sendBulk: false,
			maxTasks: 3, // Only 3 total allowed
		},
		undefined, 'Due: {taskName}', undefined, false,
		undefined, 'Upcoming: {taskName}'
		);

		// 2 due + 1 upcoming (maxTasks=3, due tasks consume 2 slots, 1 remaining for upcoming)
		expect(result.notifiedTasks).toBe(3);
	});

	it('deduplicates tasks that appear in both due and upcoming lists using separate templates', async () => {
		const state = freshState();
		// A task due today should not also be sent as upcoming
		const tasks = dueTodayTasks;

		const result = await checkAndNotify(tasks, BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			daysAhead: 7,
			sendBulk: true,
			maxTasks: 10,
		},
		undefined, 'Due: {taskName}', undefined, false,
		undefined, 'Upcoming: {taskName}'
		);

		// All 3 due-today tasks, no duplicates from upcoming
		expect(result.notifiedTasks).toBe(3);
		// No upcoming tasks should be in the result since all are due-today
		expect(result.upcomingTasks).toBe(0);
	});

	it('returns upcomingTasks count in result', async () => {
		const state = freshState();
		const upcoming = makeInlineTask({
			id: 'inline:upcoming/count.md:2026-06-15:ct01',
			text: 'Count task',
			deadline: makeDeadlineDateOnly(2026, 6, 15),
			deadlineString: '📅 2026-06-15',
		});

		const result = await checkAndNotify([upcoming], BOT_TOKEN, CHAT_ID, state, {
			checkToday: true,
			checkOverdue: true,
			daysAhead: 7,
			sendBulk: false,
			maxTasks: 10,
		},
		undefined, 'Due: {taskName}', undefined, false,
		undefined, 'Upcoming: {taskName}'
		);

		expect(result.upcomingTasks).toBe(1);
		expect(result.dueTasks).toBe(0);
	});
});
