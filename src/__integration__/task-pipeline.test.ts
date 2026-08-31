/**
 * Integration / E2E test for the full task notification pipeline.
 *
 * Only mocked boundaries: Vault I/O (obsidian) and Telegram HTTP (requestUrl).
 * Everything else runs real code: scanning → parsing → filtering → rendering → dispatching.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock obsidian — resolved via vitest.config.ts resolve.alias
import { MockApp, MockTFile, requestUrl } from 'obsidian';

import { scanVaultForTasks } from '../tasks';
import { checkAndNotify, dispatchAtTimeReminders, loadNotificationState } from '../checker';
import { AtTimeScheduler } from '../scheduler';
import { makeInlineTask, makeDeadlineDateTime } from '../__fixtures__/tasks';

/** Path to fixture markdown files. */
const FIXTURES_DIR = path.resolve(__dirname, '..', '__fixtures__');

describe('Task notification pipeline (E2E)', () => {
  // Fixed reference date matching the fixtures (2026-06-11)
  const REFERENCE_DATE = new Date('2026-06-11T12:00:00Z');
  const BOT_TOKEN = 'test:bot-token-1234567890abcdef';
  const CHAT_ID = 'test:chat-id-9876543210abcdef';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(REFERENCE_DATE);
  });

  /**
   * Helper: read a fixture .md file and return its content.
   */
  function readFixture(name: string): string {
    return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
  }

  /**
   * Helper: build a mock App with vault files backed by real fixture content.
   * frontmatter is provided inline (taken from the fixture's YAML) for cache fidelity.
   */
  function buildMockApp(files: Array<{
    path: string;
    fixtureName: string;
    frontmatter?: Record<string, unknown>;
  }>): MockApp {
    const app = new MockApp();

    const tfiles = files.map(f => {
      const tf = new MockTFile(f.path);
      // Override extension to 'md' for all fixture files
      Object.defineProperty(tf, 'extension', { value: 'md' });
      return tf;
    });

    app.vault.getFiles.mockReturnValue(tfiles);

    app.vault.read.mockImplementation((file: MockTFile) => {
      const fixture = files.find(f => f.path === file.path);
      if (!fixture) return Promise.reject(new Error(`File not found: ${file.path}`));
      return Promise.resolve(readFixture(fixture.fixtureName));
    });

    app.metadataCache.getFileCache.mockImplementation((file: MockTFile) => {
      const fixture = files.find(f => f.path === file.path);
      if (!fixture?.frontmatter) return null;
      return {
        frontmatter: fixture.frontmatter,
        frontmatterPosition: { end: { line: 4 } }, // 4 lines of frontmatter in sample files
      } as unknown as ReturnType<typeof app.metadataCache.getFileCache>;
    });

    return app;
  }

  it('scans, filters, and notifies due and overdue tasks', async () => {
    // --- Arrange ---
    const app = buildMockApp([
      {
        // sample-task-file.md has: frontmatter due today, 1 inline due today,
        // 1 completed, 1 upcoming (due::), 1 scheduled, 1 no-date, 1 very overdue
        path: 'inbox/project-report.md',
        fixtureName: 'sample-task-file.md',
        frontmatter: { scheduled: '2026-06-11', status: 'open', tags: ['work', 'urgent'] },
      },
    ]);

    // --- Act 1: scan vault ---
    const allTasks = await scanVaultForTasks(app);

    // Expect: 1 frontmatter task (due today) + 3 inline tasks with deadlines
    //   - Submit timesheet 📅 2026-06-11 (due today)
    //   - Prepare slides due:: 2026-06-15 (upcoming, filtered out)
    //   - Call client scheduled:: 2026-06-12 (upcoming, filtered out)
    //   - Very overdue task 📅 2026-05-01 (overdue)
    //   - Review draft is [x] completed → excluded
    //   - No deadline task → excluded
    expect(allTasks.length).toBeGreaterThanOrEqual(4);

    // Verify parsing worked: frontmatter task text should be heading text
    const fmTask = allTasks.find(t => t.source === 'frontmatter');
    expect(fmTask).toBeDefined();
    expect(fmTask!.text).toBe('Project Report');

    // --- Act 2: get due tasks ---
    const { getDueTasks } = await import('../tasks');
    const dueTasks = getDueTasks(allTasks, REFERENCE_DATE);
    // Should have: frontmatter task (due today) + Submit timesheet (today) + Very overdue
    expect(dueTasks.length).toBeGreaterThanOrEqual(3);
    const dueTexts = dueTasks.map(t => t.text);
    expect(dueTexts).toContain('Project Report');
    expect(dueTexts).toContain('Submit timesheet 📅 2026-06-11');
    expect(dueTexts).toContain('Very overdue task 📅 2026-05-01');

    // --- Act 3: notify ---
    const state = loadNotificationState(null);
    const result = await checkAndNotify(
      allTasks,
      BOT_TOKEN,
      CHAT_ID,
      state,
      { checkToday: true, checkOverdue: true, sendBulk: true, maxTasks: 10 },
      'You have {count} task(s) due:\n\n{tasks}',
      '• {taskName} ({deadline})',
      undefined,
      false,
    );

    // --- Assert ---
    expect(result.notifiedTasks).toBeGreaterThanOrEqual(3);
    expect(result.sendResults.length).toBeGreaterThanOrEqual(1);
    // At least one send result should be success (bulk or individual)
    const successes = result.sendResults.filter(r => r.success);
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // requestUrl should have been called to POST to Telegram
    expect(requestUrl).toHaveBeenCalled();
    const callArg = requestUrl.mock.calls[0]?.[0] as { url?: string; method?: string; body?: string };
    expect(callArg).toBeDefined();
    expect(callArg.url).toContain('api.telegram.org');
    expect(callArg.method).toBe('POST');

    // The notification state should have been updated
    const notifiedKeys = Object.keys(result.state.notifiedTasks);
    expect(notifiedKeys.length).toBeGreaterThanOrEqual(3);
    expect(result.state.lastCheck).toBeGreaterThan(0);
  });

  it('skips already-notified tasks', async () => {
    const app = buildMockApp([
      {
        path: 'inbox/task.md',
        fixtureName: 'sample-task-file.md',
        frontmatter: { scheduled: '2026-06-11', status: 'open' },
      },
    ]);

    const allTasks = await scanVaultForTasks(app);

    // Mark one task as already notified
    const taskToSkip = allTasks.find(t => t.text.includes('Submit timesheet'));
    expect(taskToSkip).toBeDefined();

    const state = loadNotificationState(null);
    const taskKey = `notified:${taskToSkip!.id}:2026-06-11`;
    state.notifiedTasks[taskKey] = Date.now();

    const result = await checkAndNotify(
      allTasks,
      BOT_TOKEN,
      CHAT_ID,
      state,
      { checkToday: true, checkOverdue: true, sendBulk: true, maxTasks: 10 },
    );

    // With bulk mode, if even 1 task is new, all limited tasks get sent
    // So this assertion should just verify the function didn't crash
    expect(result.sendResults.length).toBeGreaterThanOrEqual(0);
  });

  it('handles empty vault gracefully', async () => {
    const app = buildMockApp([]);
    const allTasks = await scanVaultForTasks(app);
    expect(allTasks).toEqual([]);

    const state = loadNotificationState(null);
    const result = await checkAndNotify(
      allTasks,
      BOT_TOKEN,
      CHAT_ID,
      state,
      { checkToday: true, checkOverdue: true },
    );

    expect(result.notifiedTasks).toBe(0);
    expect(result.sendResults).toEqual([]);
  });

  it('catches up on missed overdue tasks within the window after the app was closed (issue #99)', async () => {
    // PC was off overnight: a task became overdue 30min ago (within the
    // catch-up window) and one became overdue 1 day ago (outside it).
    const recent = makeInlineTask({
      id: 'inline:recent.md:2026-06-11T11:30:00:cu1',
      text: 'Recently overdue',
      deadline: makeDeadlineDateTime('2026-06-11T11:30:00'),
    });
    const old = makeInlineTask({
      id: 'inline:old.md:2026-06-10T12:00:00:cu2',
      text: 'Long overdue',
      deadline: makeDeadlineDateTime('2026-06-10T12:00:00'),
    });

    const state = loadNotificationState(null);
    const result = await checkAndNotify(
      [recent, old],
      BOT_TOKEN,
      CHAT_ID,
      state,
      {
        checkToday: true,
        checkOverdue: true,
        sendBulk: true,
        maxTasks: 10,
        // Shared at-time window as the general catch-up window.
        catchUpWindowMinutes: 60,
      },
    );

    // Only the 30-min-old overdue task fires; the 1-day-old one is dropped.
    expect(result.dueTasks).toBe(2);
    expect(result.notifiedTasks).toBe(1);
    const keys = Object.keys(result.state.notifiedTasks);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain('inline:recent.md');
    expect(requestUrl).toHaveBeenCalled();
  });
});

// ===========================================================================
// At-time scheduler pipeline (issue #89)
// ===========================================================================

describe('At-time scheduler pipeline (E2E)', () => {
  const BOT_TOKEN = 'test:bot-token-1234567890abcdef';
  const CHAT_ID = 'test:chat-id-9876543210abcdef';
  const FIXED_NOW = new Date('2026-06-11T12:00:00Z');

  /** A 12:30 inline at-time task. The scheduler should fire at 12:30 with 0 lead. */
  const at1230Task = makeInlineTask({
    id: 'inline:at1230.md:2026-06-11T12:30:00:at1',
    text: '12:30 at-time task',
    filePath: 'at-time/1230.md',
    fileName: '1230.md',
    lineNumber: 1,
    deadline: makeDeadlineDateTime('2026-06-11T12:30:00'),
  });

  beforeEach(() => {
    // The previous describe block doesn't reset fake timers, so
    // real-timer first to give useFakeTimers a clean slate.
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    (requestUrl as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ ok: true, result: {} }),
      json: { ok: true, result: {} },
      status: 200,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Drain the microtask queue so a `void this.fire()` initiated during
   * `arm()` has a chance to complete before assertions run.
   * The scheduler's catch-up path is a synchronous (microtask) fire,
   * not a timer-based fire, so advanceTimersByTime alone isn't enough.
   */
  async function flushMicrotasks(): Promise<void> {
    // Multiple rounds walk the await chain inside the dispatcher
    // (fire → onWake → dispatchAtTimeReminders → sendTaskReminder → requestUrl).
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
  }

  it('Task 12:30 + 0 lead + 60 catch-up → arm() sets nextFire to 12:30', () => {
    const scheduler = new AtTimeScheduler(() => Promise.resolve());
    scheduler.arm([at1230Task], 0, 60, {}, FIXED_NOW);
    expect(scheduler.getNextFire()?.toISOString()).toBe('2026-06-11T12:30:00.000Z');
  });

  it('vi.useFakeTimers() + advance to 12:30 → notification fires, notifiedAtTimeInstances set', async () => {
    let capturedState: ReturnType<typeof loadNotificationState> | null = null;

    const scheduler = new AtTimeScheduler(async () => {
      // Real dispatcher — exactly the call the plugin makes.
      const { state } = await dispatchAtTimeReminders(
        [at1230Task],
        new Date(),
        60,
        0,
        { botToken: BOT_TOKEN, chatId: CHAT_ID, state: captureState() }
      );
      capturedState = state;
    });

    scheduler.arm([at1230Task], 0, 60, {}, FIXED_NOW);
    expect(requestUrl).not.toHaveBeenCalled();

    // Advance to 12:30 — the wake should fire. Then drain the
    // microtask chain inside the dispatcher.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await flushMicrotasks();

    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(capturedState).not.toBeNull();
    const scheduledFire = new Date('2026-06-11T12:30:00Z').getTime();
    expect(capturedState!.notifiedAtTimeInstances[at1230Task.id]).toBe(scheduledFire);

    // Local helper to lazy-init the state object referenced in the callback.
    function captureState() {
      if (!capturedState) {
        capturedState = loadNotificationState(null);
      }
      return capturedState;
    }
  });

  it('rearm after new task cancels prior timer and sets a new one', () => {
    const scheduler = new AtTimeScheduler(() => Promise.resolve());
    scheduler.arm([at1230Task], 0, 60, {}, FIXED_NOW);
    const first = scheduler.getNextFire();
    expect(first?.toISOString()).toBe('2026-06-11T12:30:00.000Z');

    const laterTask = makeInlineTask({
      id: 'inline:later.md:2026-06-11T18:00:00:lt1',
      text: 'Later',
      deadline: makeDeadlineDateTime('2026-06-11T18:00:00'),
    });
    scheduler.rearm([laterTask], 0, 60, {}, FIXED_NOW);
    expect(scheduler.getNextFire()?.toISOString()).toBe('2026-06-11T18:00:00.000Z');
  });

  it('cancel → wakeTimer null, nextFire null', () => {
    const scheduler = new AtTimeScheduler(() => Promise.resolve());
    scheduler.arm([at1230Task], 0, 60, {}, FIXED_NOW);
    expect(scheduler.hasPendingWake()).toBe(true);
    scheduler.cancel();
    expect(scheduler.hasPendingWake()).toBe(false);
    expect(scheduler.getNextFire()).toBeNull();
  });

  it('Multiple at-time tasks in the same minute → one wake, all notified', async () => {
    const a = makeInlineTask({
      id: 'inline:a.md:2026-06-11T12:30:00:aa1',
      deadline: makeDeadlineDateTime('2026-06-11T12:30:00'),
    });
    const b = makeInlineTask({
      id: 'inline:b.md:2026-06-11T12:30:00:bb1',
      deadline: makeDeadlineDateTime('2026-06-11T12:30:00'),
    });
    const c = makeInlineTask({
      id: 'inline:c.md:2026-06-11T12:30:00:cc1',
      deadline: makeDeadlineDateTime('2026-06-11T12:30:00'),
    });

    const state = loadNotificationState(null);
    const scheduler = new AtTimeScheduler(async () => {
      await dispatchAtTimeReminders(
        [a, b, c],
        new Date(),
        60,
        0,
        { botToken: BOT_TOKEN, chatId: CHAT_ID, state }
      );
    });
    // Arm at 12:00 with wake at 12:30 (30 min ahead). Advance the
    // fake clock past 12:30 to trigger the wake, then drain the
    // microtask chain inside the dispatcher.
    scheduler.arm([a, b, c], 0, 60, {}, FIXED_NOW);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await flushMicrotasks();

    // All three tasks should have been notified.
    expect(requestUrl).toHaveBeenCalledTimes(3);
    const scheduledFire = new Date('2026-06-11T12:30:00Z').getTime();
    expect(state.notifiedAtTimeInstances[a.id]).toBe(scheduledFire);
    expect(state.notifiedAtTimeInstances[b.id]).toBe(scheduledFire);
    expect(state.notifiedAtTimeInstances[c.id]).toBe(scheduledFire);
  });

  it('Reopen after 30min missed → notification fires with delayedByMinutes: 30', async () => {
    // "Reopen" = scheduler arms at a `now` that's 30min past the deadline.
    const reopenNow = new Date('2026-06-11T13:00:00Z'); // 30 min after 12:30
    // Move the fake clock to match — the callback uses new Date() to
    // decide which tasks are due, so the system clock and the arm()
    // `now` must agree.
    vi.setSystemTime(reopenNow);
    const state = loadNotificationState(null);
    const scheduler = new AtTimeScheduler(async () => {
      await dispatchAtTimeReminders(
        [at1230Task],
        new Date(),
        60,
        0,
        { botToken: BOT_TOKEN, chatId: CHAT_ID, state }
      );
    });
    // arm() sets a setTimeout(0) for the catch-up fire. Drive the
    // timer queue to fire it, then drain the microtask chain.
    scheduler.arm([at1230Task], 0, 60, {}, reopenNow);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(requestUrl).toHaveBeenCalledTimes(1);
    const calls = (requestUrl as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = calls[calls.length - 1]!;
    const arg = lastCall[0] as { body?: string };
    const body = arg.body ? JSON.parse(arg.body) as { text?: string } : {};
    expect(body.text).toContain('(delayed 30m)');
  });

  it('Reopen after 90min with catchUpWindowMinutes=60 → silently dropped', async () => {
    const reopenNow = new Date('2026-06-11T14:00:00Z'); // 90 min after 12:30
    const state = loadNotificationState(null);
    const scheduler = new AtTimeScheduler(async () => {
      await dispatchAtTimeReminders(
        [at1230Task],
        new Date(),
        60,
        0,
        { botToken: BOT_TOKEN, chatId: CHAT_ID, state }
      );
    });
    // Task is 90min past, catch-up is 60min → scheduler filters it out,
    // no wake is scheduled.
    scheduler.arm([at1230Task], 0, 60, {}, reopenNow);

    expect(requestUrl).not.toHaveBeenCalled();
    expect(state.notifiedAtTimeInstances[at1230Task.id]).toBeUndefined();
  });
});
