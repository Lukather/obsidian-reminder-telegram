/**
 * Unit tests for src/scheduler.ts
 *
 * Covers the granular wake-up behaviour described in issue #89:
 *   - arm/rearm is idempotent and cancels the previous timer
 *   - candidate filtering (completed, non-datetime, already-notified,
 *     past catch-up window, future wake)
 *   - getNextFire reflects the armed state
 *   - cancel clears state cleanly
 *   - onWake is invoked at (or near) the scheduled time
 *   - errors thrown by onWake are caught and logged (don't crash host)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { AtTimeScheduler } from './scheduler';
import { parseTaskLine } from './tasks';
import {
	makeInlineTask,
	makeDeadlineDateOnly,
	makeDeadlineDateTime,
} from './__fixtures__/tasks';

const REFERENCE_DATE = new Date('2026-06-11T12:00:00Z');

/** A completed inline at-time task — should be ignored by the scheduler. */
const completedAtTimeTask = makeInlineTask({
	id: 'inline:done.md:2026-06-11T13:00:00:done01',
	text: 'Already done',
	deadline: makeDeadlineDateTime('2026-06-11T13:00:00'),
	completed: true,
});

/** A date-only task — not eligible for the at-time scheduler. */
const dateOnlyTask = makeInlineTask({
	id: 'inline:dateonly.md:2026-06-11:date01',
	text: 'Date only',
	deadline: makeDeadlineDateOnly(2026, 6, 11),
});

/** A future at-time task (12:30, 30 min from now). */
const futureAtTimeTask = makeInlineTask({
	id: 'inline:future.md:2026-06-11T12:30:00:future01',
	text: 'Future task',
	deadline: makeDeadlineDateTime('2026-06-11T12:30:00'),
});

/** A past at-time task (11:00, 1h ago). */
const pastAtTimeTask = makeInlineTask({
	id: 'inline:past.md:2026-06-11T11:00:00:past01',
	text: 'Past task',
	deadline: makeDeadlineDateTime('2026-06-11T11:00:00'),
});

describe('AtTimeScheduler', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(REFERENCE_DATE);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('arm()', () => {
		it('sets nextFire to the earliest at-time deadline minus lead', () => {
			const callback = vi.fn();
			const scheduler = new AtTimeScheduler(callback);
			scheduler.arm(
				[futureAtTimeTask],
				0,
				60,
				{},
				REFERENCE_DATE
			);
			expect(scheduler.getNextFire()?.toISOString()).toBe('2026-06-11T12:30:00.000Z');
		});

		it('ignores completed tasks', () => {
			const callback = vi.fn();
			const scheduler = new AtTimeScheduler(callback);
			scheduler.arm([completedAtTimeTask], 0, 60, {}, REFERENCE_DATE);
			expect(scheduler.getNextFire()).toBeNull();
			expect(scheduler.hasPendingWake()).toBe(false);
		});

		it('ignores date-only tasks', () => {
			const callback = vi.fn();
			const scheduler = new AtTimeScheduler(callback);
			scheduler.arm([dateOnlyTask], 0, 60, {}, REFERENCE_DATE);
			expect(scheduler.getNextFire()).toBeNull();
		});

		it('subtracts lead time from the scheduled fire', () => {
			const callback = vi.fn();
			const scheduler = new AtTimeScheduler(callback);
			// 12:30 deadline, 5 min lead → fire at 12:25
			scheduler.arm([futureAtTimeTask], 5, 60, {}, REFERENCE_DATE);
			expect(scheduler.getNextFire()?.toISOString()).toBe('2026-06-11T12:25:00.000Z');
		});

		it('picks the earliest among multiple at-time tasks', () => {
			const callback = vi.fn();
			const scheduler = new AtTimeScheduler(callback);
			const a = makeInlineTask({
				id: 'inline:a.md:2026-06-11T15:00:00:a1',
				deadline: makeDeadlineDateTime('2026-06-11T15:00:00'),
			});
			const b = makeInlineTask({
				id: 'inline:b.md:2026-06-11T13:00:00:b1',
				deadline: makeDeadlineDateTime('2026-06-11T13:00:00'),
			});
			const c = makeInlineTask({
				id: 'inline:c.md:2026-06-11T14:00:00:c1',
				deadline: makeDeadlineDateTime('2026-06-11T14:00:00'),
			});
			scheduler.arm([a, b, c], 0, 60, {}, REFERENCE_DATE);
			expect(scheduler.getNextFire()?.toISOString()).toBe('2026-06-11T13:00:00.000Z');
		});

		it('arms for a task parsed from Reminder-plugin @ syntax (issue #96)', () => {
			const parsed = parseTaskLine('- [ ] Call Grandma @2026-06-11 12:30', 'note.md', 1);
			expect(parsed).not.toBeNull();
			expect(parsed!.deadline!.type).toBe('datetime');
			const scheduler = new AtTimeScheduler(() => undefined);
			scheduler.arm(parsed ? [parsed] : [], 0, 60, {}, REFERENCE_DATE);
			expect(scheduler.getNextFire()?.toISOString()).toBe('2026-06-11T12:30:00.000Z');
		});

		it('skips tasks already notified at the same scheduledFire', () => {
			const callback = vi.fn();
			const scheduler = new AtTimeScheduler(callback);
			const scheduledFire = new Date('2026-06-11T12:30:00Z').getTime();
			scheduler.arm(
				[futureAtTimeTask],
				0,
				60,
				{ [futureAtTimeTask.id]: scheduledFire },
				REFERENCE_DATE
			);
			// Already notified → no wake scheduled.
			expect(scheduler.getNextFire()).toBeNull();
		});

		it('schedules a wake for tasks whose scheduledFire is still ahead', () => {
			const callback = vi.fn();
			const scheduler = new AtTimeScheduler(callback);
			// Only a future task — past task is excluded (60min back, catch-up=0).
			scheduler.arm(
				[futureAtTimeTask],
				0,
				0,
				{},
				REFERENCE_DATE
			);
			expect(scheduler.getNextFire()?.toISOString()).toBe('2026-06-11T12:30:00.000Z');
		});
	});

	describe('rearm()', () => {
		it('cancels the previous timer and schedules a new one', () => {
			const callback = vi.fn();
			const scheduler = new AtTimeScheduler(callback);
			scheduler.arm([futureAtTimeTask], 0, 60, {}, REFERENCE_DATE);
			const firstWake = scheduler.getNextFire();
			expect(firstWake).not.toBeNull();

			// Rearm with a different task later in the day.
			const later = makeInlineTask({
				id: 'inline:later.md:2026-06-11T18:00:00:later01',
				deadline: makeDeadlineDateTime('2026-06-11T18:00:00'),
			});
			scheduler.rearm([later], 0, 60, {}, REFERENCE_DATE);
			expect(scheduler.getNextFire()?.toISOString()).toBe('2026-06-11T18:00:00.000Z');
			expect(scheduler.getNextFire()).not.toEqual(firstWake);
		});

		it('is a no-op when no tasks qualify', () => {
			const callback = vi.fn();
			const scheduler = new AtTimeScheduler(callback);
			scheduler.rearm([completedAtTimeTask, dateOnlyTask], 0, 60, {}, REFERENCE_DATE);
			expect(scheduler.getNextFire()).toBeNull();
			expect(scheduler.hasPendingWake()).toBe(false);
		});
	});

	describe('cancel()', () => {
		it('clears the timer and nextFire', () => {
			const callback = vi.fn();
			const scheduler = new AtTimeScheduler(callback);
			scheduler.arm([futureAtTimeTask], 0, 60, {}, REFERENCE_DATE);
			expect(scheduler.hasPendingWake()).toBe(true);
			scheduler.cancel();
			expect(scheduler.hasPendingWake()).toBe(false);
			expect(scheduler.getNextFire()).toBeNull();
		});

		it('is safe to call when no timer is armed', () => {
			const callback = vi.fn();
			const scheduler = new AtTimeScheduler(callback);
			expect(() => scheduler.cancel()).not.toThrow();
			expect(scheduler.getNextFire()).toBeNull();
		});

		it('prevents a pending wake from firing', () => {
			const callback = vi.fn();
			const scheduler = new AtTimeScheduler(callback);
			scheduler.arm([futureAtTimeTask], 0, 60, {}, REFERENCE_DATE);
			scheduler.cancel();
			vi.advanceTimersByTime(60 * 60 * 1000); // 1 hour
			expect(callback).not.toHaveBeenCalled();
		});
	});

	describe('wake callback', () => {
		it('invokes onWake when the timer fires', async () => {
			const callback = vi.fn().mockResolvedValue(undefined);
			const scheduler = new AtTimeScheduler(callback);
			scheduler.arm([futureAtTimeTask], 0, 60, {}, REFERENCE_DATE);
			// Fire is at 12:30 → advance 30 min
			await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
			expect(callback).toHaveBeenCalledTimes(1);
		});

		it('fires immediately for a task in the catch-up window', async () => {
			const callback = vi.fn().mockResolvedValue(undefined);
			const scheduler = new AtTimeScheduler(callback);
			// pastAtTimeTask has deadline 11:00, now is 12:00 — 60min in past
			scheduler.arm([pastAtTimeTask], 0, 60, {}, REFERENCE_DATE);
			// Catch-up fires via setTimeout(0); drive the timer queue.
			await vi.advanceTimersByTimeAsync(0);
			expect(callback).toHaveBeenCalledTimes(1);
		});

		it('drops tasks past the catch-up window without scheduling a wake', () => {
			const callback = vi.fn();
			const scheduler = new AtTimeScheduler(callback);
			// pastAtTimeTask is 60min in the past, catch-up = 30min → drop
			scheduler.arm([pastAtTimeTask], 0, 30, {}, REFERENCE_DATE);
			expect(scheduler.getNextFire()).toBeNull();
			expect(scheduler.hasPendingWake()).toBe(false);
		});

		it('catches a thrown error from the callback and logs it', async () => {
			const error = new Error('boom');
			const callback = vi.fn().mockRejectedValue(error);
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			const scheduler = new AtTimeScheduler(callback);
			scheduler.arm([futureAtTimeTask], 0, 60, {}, REFERENCE_DATE);
			await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
			expect(callback).toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('does not throw to the host if the callback throws', async () => {
			const callback = vi.fn().mockRejectedValue(new Error('boom'));
			vi.spyOn(console, 'error').mockImplementation(() => undefined);
			const scheduler = new AtTimeScheduler(callback);
			scheduler.arm([futureAtTimeTask], 0, 60, {}, REFERENCE_DATE);
			// The scheduler catches and logs internally; the timer
			// queue should not blow up.
			await expect(vi.advanceTimersByTimeAsync(30 * 60 * 1000)).resolves.not.toThrow();
		});
	});

	describe('candidate filtering', () => {
		it('excludes future tasks past the catch-up window? — future tasks always eligible', () => {
			// Catch-up window only applies to tasks *behind* `now`. Future
			// tasks are always considered (otherwise the wake would never
			// be scheduled for them).
			const callback = vi.fn();
			const scheduler = new AtTimeScheduler(callback);
			const farFuture = makeInlineTask({
				id: 'inline:far.md:2026-06-12T10:00:00:far01',
				deadline: makeDeadlineDateTime('2026-06-12T10:00:00'),
			});
			scheduler.arm([farFuture], 0, 60, {}, REFERENCE_DATE);
			expect(scheduler.getNextFire()?.toISOString()).toBe('2026-06-12T10:00:00.000Z');
		});

		it('returns no wake for an empty task list', () => {
			const callback = vi.fn();
			const scheduler = new AtTimeScheduler(callback);
			scheduler.arm([], 0, 60, {}, REFERENCE_DATE);
			expect(scheduler.getNextFire()).toBeNull();
		});
	});
});
