/**
 * Sample NotificationState objects for use in unit and integration tests.
 */

import type { NotificationState } from '../checker';

/** Brand-new state with no history. */
export const emptyNotificationState: NotificationState = {
  notifiedTasks: {},
  lastCheck: 0,
};

/** State with a few recent notifications (today). */
export const recentNotificationState: NotificationState = {
  notifiedTasks: {
    'notified:inline:due/today.md:2026-06-11:due01:2026-06-11': Date.now(),
    'notified:frontmatter:due/today-note.md:2026-06-11:2026-06-11': Date.now(),
  },
  lastCheck: Date.now(),
};

/** State with one recent and one old (stale) notification. */
export const mixedAgeNotificationState: NotificationState = {
  notifiedTasks: {
    // Recent — within last 30 days
    'notified:inline:recent/file.md:2026-06-01:recent1:2026-06-01':
      Date.now() - 5 * 24 * 60 * 60 * 1000, // 5 days ago
    // Old — outside 30-day prune window
    'notified:inline:vintage/file.md:2026-01-01:vintage1:2026-01-01':
      Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 days ago
  },
  lastCheck: Date.now() - 60 * 24 * 60 * 60 * 1000,
};

/** State with many entries to test pruning behaviour (just over 1000). */
export const nearThresholdNotificationState: NotificationState = {
  notifiedTasks: Object.fromEntries(
    Array.from({ length: 1001 }, (_, i) => [
      `notified:task-${i}:2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
      i < 500
        ? Date.now() - 5 * 24 * 60 * 60 * 1000 // fresh
        : Date.now() - 40 * 24 * 60 * 60 * 1000, // stale
    ]),
  ),
  lastCheck: Date.now(),
};

/** State with exactly 1000 entries — below prune threshold. */
export const atThresholdNotificationState: NotificationState = {
  notifiedTasks: Object.fromEntries(
    Array.from({ length: 1000 }, (_, i) => [
      `notified:task-${i}:2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
      Date.now() - 5 * 24 * 60 * 60 * 1000,
    ]),
  ),
  lastCheck: Date.now(),
};

/** State where a specific task has already been notified. */
export function notificationStateWithTask(taskId: string, dateStr: string): NotificationState {
  return {
    notifiedTasks: {
      [`notified:${taskId}:${dateStr}`]: Date.now(),
    },
    lastCheck: Date.now(),
  };
}
