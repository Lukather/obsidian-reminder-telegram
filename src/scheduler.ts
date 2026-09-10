/**
 * AtTimeScheduler — granular wake-up for at-time task notifications.
 *
 * Schedules a single `setTimeout` to fire at the next at-time deadline
 * (minus the configured lead time), so notifications are sent within
 * seconds of the actual deadline rather than waiting for the next
 * periodic-interval check.
 *
 * Re-arming is idempotent: calling `arm`/`rearm` cancels the previous
 * timer before scheduling a new one. The `cancel` method is also
 * exposed so callers (and the periodic-interval safety net) can
 * clear a stale timer without scheduling a replacement.
 *
 * The scheduler itself is purely a timer. All notification dispatch
 * (filtering, sending, marking notified, saving state) is the
 * responsibility of the `onWake` callback supplied at construction
 * time. This keeps the scheduler trivially testable in isolation
 * and lets the plugin own the side effects.
 */

import type { VaultTask } from './tasks';

/**
 * Callback invoked when the wake timer fires. The callback is
 * responsible for any notification dispatch; the scheduler does not
 * re-arm itself after a fire. Callers should `rearm` from inside the
 * callback (typically in a `.finally` block) so a thrown notification
 * error doesn't leave the scheduler with no upcoming wake.
 */
export type AtTimeSchedulerCallback = () => Promise<void> | void;

export class AtTimeScheduler {
	private wakeTimer: number | null = null;
	private nextFire: Date | null = null;
	private readonly onWake: AtTimeSchedulerCallback;

	constructor(onWake: AtTimeSchedulerCallback) {
		this.onWake = onWake;
	}

	/**
	 * Compute the next wake-up for the given at-time tasks and start
	 * the timer. If a previous timer exists it is cancelled first.
	 *
	 * The fire is fire-and-forget: this method returns synchronously
	 * and the wake callback is invoked asynchronously when the timer
	 * comes due. Callers that need to wait for the fire to complete
	 * (e.g. tests) should advance fake timers and/or drain microtasks
	 * after calling.
	 *
	 * @param tasks                  Vault tasks (only `datetime` deadlines are considered).
	 * @param leadTimeMinutes        Minutes before the deadline to fire.
	 * @param catchUpWindowMinutes   Max minutes of delay accepted on the next fire.
	 * @param notifiedInstances      Per-task ledger from `NotificationState.notifiedAtTimeInstances`.
	 * @param now                    Reference time (defaults to the current time).
	 */
	arm(
		tasks: VaultTask[],
		leadTimeMinutes: number,
		catchUpWindowMinutes: number,
		notifiedInstances: Record<string, number> = {},
		now: Date = new Date(),
	): void {
		this.cancel();

		// No at-time tasks → no wake needed. Leave wakeTimer null and
		// nextFire null so getNextFire() reflects the idle state.
		const candidates = this.filterCandidates(
			tasks,
			leadTimeMinutes,
			catchUpWindowMinutes,
			notifiedInstances,
			now,
		);
		if (candidates.length === 0) return;

		// Earliest scheduled fire wins.
		const earliest = candidates.reduce(
			(min, t) => (t.scheduledFire < min.scheduledFire ? t : min),
			candidates[0]!,
		);

		// If the earliest candidate is in the catch-up window, fire
		// immediately via a 0ms setTimeout. Using the timer queue
		// (rather than a bare microtask) means the fire is observable
		// to test harnesses that drive timers with
		// `vi.advanceTimersByTimeAsync` / `vi.runAllTimersAsync`.
		const delayMs =
			earliest.scheduledFire <= now.getTime()
				? 0
				: earliest.scheduledFire - now.getTime();

		this.nextFire = new Date(earliest.scheduledFire);
		this.wakeTimer = window.setTimeout(() => {
			this.wakeTimer = null;
			this.nextFire = null;
			void this.fire();
		}, delayMs);
	}

	/**
	 * Same as `arm` — provided as an explicit entry point because the
	 * issue spec uses both terms. Semantically the two are identical:
	 * cancel any existing timer, then schedule a new one.
	 */
	rearm(
		tasks: VaultTask[],
		leadTimeMinutes: number,
		catchUpWindowMinutes: number,
		notifiedInstances: Record<string, number> = {},
		now: Date = new Date(),
	): void {
		this.arm(
			tasks,
			leadTimeMinutes,
			catchUpWindowMinutes,
			notifiedInstances,
			now,
		);
	}

	/** Cancel any pending wake timer. Safe to call when no timer is set. */
	cancel(): void {
		if (this.wakeTimer !== null) {
			window.clearTimeout(this.wakeTimer);
			this.wakeTimer = null;
		}
		this.nextFire = null;
	}

	/** Returns the next scheduled wake time, or null if no timer is armed. */
	getNextFire(): Date | null {
		return this.nextFire;
	}

	/** True iff a wake timer is currently scheduled. */
	hasPendingWake(): boolean {
		return this.wakeTimer !== null;
	}

	/**
	 * Invoke the wake callback. Errors are caught and logged so a
	 * thrown callback never crashes the host (Obsidian plugin context
	 * is unforgiving about uncaught promise rejections).
	 */
	private async fire(): Promise<void> {
		try {
			await this.onWake();
		} catch (error) {
			console.error('AtTimeScheduler: wake callback threw', error);
		}
	}

	/**
	 * Compute the set of at-time tasks that warrant a wake-up, given
	 * the current time, lead time, catch-up window, and notified ledger.
	 * Returns one entry per task (not per scheduledFire), tagged with
	 * the resolved `scheduledFire` timestamp.
	 */
	private filterCandidates(
		tasks: VaultTask[],
		leadTimeMinutes: number,
		catchUpWindowMinutes: number,
		notifiedInstances: Record<string, number>,
		now: Date,
	): Array<{ scheduledFire: number }> {
		const nowMs = now.getTime();
		const leadMs = leadTimeMinutes * 60 * 1000;
		const catchUpMs = catchUpWindowMinutes * 60 * 1000;
		const result: Array<{ scheduledFire: number }> = [];

		for (const task of tasks) {
			if (task.completed) continue;
			if (!task.deadline || task.deadline.type !== 'datetime') continue;

			const scheduledFire = task.deadline.date.getTime() - leadMs;
			// Drop tasks that are still further in the future than the
			// catch-up window — they're a future wake candidate, not now.
			if (scheduledFire < nowMs - catchUpMs) continue;
			// Skip if already notified at exactly this scheduledFire.
			if (notifiedInstances[task.id] === scheduledFire) continue;

			result.push({ scheduledFire });
		}

		return result;
	}
}
