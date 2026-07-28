/**
 * Sample VaultTask objects for use in unit and integration tests.
 *
 * Provides a comprehensive set of tasks covering every combination of:
 *   source × status × deadline × format
 */

import type { VaultTask, Deadline } from '../tasks';

// ---- Helper factories ----

export function makeDeadlineDateOnly(
  year: number,
  month: number,
  day: number,
): Deadline {
  return { type: 'date-only', year, month, day };
}

export function makeDeadlineDateTime(iso: string): Deadline {
  return { type: 'datetime', date: new Date(iso) };
}

export function makeInlineTask(overrides: Partial<VaultTask> = {}): VaultTask {
  return {
    id: 'inline:test/file.md:2026-06-11:abc12345',
    text: 'Buy groceries',
    filePath: 'test/file.md',
    fileName: 'file.md',
    lineNumber: 5,
    completed: false,
    deadline: makeDeadlineDateOnly(2026, 6, 11),
    deadlineString: '📅 2026-06-11',
    originalLine: '- [ ] Buy groceries 📅 2026-06-11',
    source: 'inline',
    tags: [],
    ...overrides,
  };
}

export function makeFrontmatterTask(
  overrides: Partial<VaultTask> = {},
): VaultTask {
  return {
    id: 'frontmatter:test/note.md:2026-06-11',
    text: 'Project Report',
    filePath: 'test/note.md',
    fileName: 'note.md',
    lineNumber: 0,
    completed: false,
    deadline: makeDeadlineDateOnly(2026, 6, 11),
    deadlineString: '2026-06-11',
    originalLine: '---\n  scheduled: 2026-06-11\n  status: open\n---',
    source: 'frontmatter',
    tags: ['work', 'report'],
    ...overrides,
  };
}

// ---- Concrete fixture sets ----

/** Tasks due today (2026-06-11) — all should be picked up by getDueTasks */
export const dueTodayTasks: VaultTask[] = [
  makeInlineTask({
    id: 'inline:due/today.md:2026-06-11:due01',
    text: 'Submit timesheet',
    filePath: 'due/today.md',
    deadline: makeDeadlineDateOnly(2026, 6, 11),
    deadlineString: '📅 2026-06-11',
  }),
  makeFrontmatterTask({
    id: 'frontmatter:due/today-note.md:2026-06-11',
    text: 'Standup prep',
    filePath: 'due/today-note.md',
    deadline: makeDeadlineDateOnly(2026, 6, 11),
    deadlineString: '2026-06-11',
    tags: ['work'],
  }),
  makeInlineTask({
    id: 'inline:due/datetime-today.md:2026-06-11:due02',
    text: 'Meeting at 3pm',
    filePath: 'due/datetime-today.md',
    deadline: makeDeadlineDateTime('2026-06-11T15:00:00'),
    deadlineString: '📅 2026-06-11',
  }),
];

/** Overdue tasks — deadline before 2026-06-11 */
export const overdueTasks: VaultTask[] = [
  makeInlineTask({
    id: 'inline:overdue/old-task.md:2026-06-01:over01',
    text: 'Pay electricity bill',
    filePath: 'overdue/old-task.md',
    deadline: makeDeadlineDateOnly(2026, 6, 1),
    deadlineString: '📅 2026-06-01',
  }),
  makeInlineTask({
    id: 'inline:overdue/very-old.md:2026-05-20:over02',
    text: 'Renew passport',
    filePath: 'overdue/very-old.md',
    deadline: makeDeadlineDateOnly(2026, 5, 20),
    deadlineString: '📅 2026-05-20',
  }),
  makeFrontmatterTask({
    id: 'frontmatter:overdue/note.md:2026-05-15',
    text: 'Tax return',
    filePath: 'overdue/note.md',
    deadline: makeDeadlineDateOnly(2026, 5, 15),
    deadlineString: '2026-05-15',
    tags: ['finance'],
  }),
];

/** Upcoming tasks — deadline after today */
export const upcomingTasks: VaultTask[] = [
  makeInlineTask({
    id: 'inline:upcoming/task1.md:2026-06-15:up01',
    text: 'Prepare slides',
    filePath: 'upcoming/task1.md',
    deadline: makeDeadlineDateOnly(2026, 6, 15),
    deadlineString: '📅 2026-06-15',
  }),
  makeInlineTask({
    id: 'inline:upcoming/task2.md:2026-06-20:up02',
    text: 'Book flight',
    filePath: 'upcoming/task2.md',
    deadline: makeDeadlineDateOnly(2026, 6, 20),
    deadlineString: '📅 2026-06-20',
  }),
];

/** Completed tasks — should be excluded from getDueTasks */
export const completedTasks: VaultTask[] = [
  makeInlineTask({
    id: 'inline:completed/done1.md:2026-06-10:comp01',
    text: 'Clean inbox',
    filePath: 'completed/done1.md',
    completed: true,
    deadline: makeDeadlineDateOnly(2026, 6, 10),
    deadlineString: '📅 2026-06-10',
  }),
  makeFrontmatterTask({
    id: 'frontmatter:completed/note.md:2026-06-09',
    text: 'Performance review',
    filePath: 'completed/note.md',
    completed: true,
    deadline: makeDeadlineDateOnly(2026, 6, 9),
    deadlineString: '2026-06-09',
    tags: ['hr'],
  }),
];

/** Tasks without any deadline — should never appear in getDueTasks */
export const noDeadlineTasks: VaultTask[] = [
  makeInlineTask({
    id: 'inline:none/nodate1.md::nodead01',
    text: 'Idea for blog post',
    filePath: 'none/nodate1.md',
    deadline: null,
    deadlineString: null,
    originalLine: '- [ ] Idea for blog post',
  }),
  makeFrontmatterTask({
    id: 'frontmatter:none/nodate2.md:',
    text: 'Someday project',
    filePath: 'none/nodate2.md',
    deadline: null,
    deadlineString: null,
    originalLine: '---\n  status: open\n---',
    tags: [],
  }),
];

/** A full realistic vault mix (no duplicates) */
export const allSampleTasks: VaultTask[] = [
  ...dueTodayTasks,
  ...overdueTasks,
  ...upcomingTasks,
  ...completedTasks,
  ...noDeadlineTasks,
];

// ---- Specific edge-case tasks ----

export const mmddDateTask = makeInlineTask({
  id: 'inline:mmdd/file.md:2026-12-31:mmdd01',
  text: 'New Year prep',
  filePath: 'mmdd/file.md',
  deadline: makeDeadlineDateOnly(2026, 12, 31),
  deadlineString: '📅 12/31/2026',
  originalLine: '- [ ] New Year prep 📅 12/31/2026',
});

export const ddmmDateTask = makeInlineTask({
  id: 'inline:ddmm/file.md:2026-05-04:ddmm01',
  text: 'Star Wars day',
  filePath: 'ddmm/file.md',
  deadline: makeDeadlineDateOnly(2026, 5, 4),
  deadlineString: '📅 04-05-2026',
  originalLine: '- [ ] Star Wars day 📅 04-05-2026',
});

export const duePrefixTask = makeInlineTask({
  id: 'inline:dueprefix/file.md:2026-07-01:duepfx',
  text: 'Quarterly review',
  filePath: 'dueprefix/file.md',
  deadline: makeDeadlineDateOnly(2026, 7, 1),
  deadlineString: 'due:: 2026-07-01',
  originalLine: '- [ ] Quarterly review due:: 2026-07-01',
});

export const scheduledPrefixTask = makeInlineTask({
  id: 'inline:sched/file.md:2026-08-15:schedpfx',
  text: 'Plan vacation',
  filePath: 'sched/file.md',
  deadline: makeDeadlineDateOnly(2026, 8, 15),
  deadlineString: 'scheduled:: 2026-08-15',
  originalLine: '- [ ] Plan vacation scheduled:: 2026-08-15',
});

export const multiDayOverdueTask = makeInlineTask({
  id: 'inline:multi/file.md:2026-01-01:multi01',
  text: 'Finish annual report',
  filePath: 'multi/file.md',
  deadline: makeDeadlineDateOnly(2026, 1, 1),
  deadlineString: '📅 2026-01-01',
  originalLine: '- [ ] Finish annual report 📅 2026-01-01',
});
