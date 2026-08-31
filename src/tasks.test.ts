/**
 * Unit tests for src/tasks.ts
 *
 * Target: 95% coverage
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// obsidian is resolved to __mocks__/obsidian.ts via vitest.config.ts resolve.alias
import { MockApp, MockTFile } from 'obsidian';
import {
  parseDate,
  deadlineToCalendarDay,
  deadlineToDateString,
  compareCalendarDays,
  addDaysToCalendarDay,
  taskDeadlineOnCalendarDay,
  taskDeadlineOverdueBeforeDay,
  parseTaskLine,
  parseFrontmatterTasksFromCache,
  parseInlineTasks,
  scanVaultForTasks,
  getDueTasks,
  filterDueTasksByCheckFlags,
  getUpcomingTasks,
  getIncompleteTasksWithDeadlines,
  getTaskNotificationKey,
  type VaultTask,
  type Deadline,
} from './tasks';
import { makeDeadlineDateOnly, makeInlineTask, allSampleTasks } from './__fixtures__/tasks';

// ===========================================================================
// parseDate
// ===========================================================================

describe('parseDate()', () => {
  it('parses ISO datetime (YYYY-MM-DDTHH:MM)', () => {
    const result = parseDate('2026-06-11T15:30:00.000Z');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('datetime');
    expect((result as { type: 'datetime'; date: Date }).date.getTime()).not.toBeNaN();
  });

  it('parses ISO date-only (YYYY-MM-DD)', () => {
    const result = parseDate('2026-06-11');
    expect(result).toEqual({ type: 'date-only', year: 2026, month: 6, day: 11 });
  });

  it('parses MM/DD/YYYY', () => {
    const result = parseDate('06/11/2026');
    expect(result).toEqual({ type: 'date-only', year: 2026, month: 6, day: 11 });
  });

  it('parses DD-MM-YYYY (interpreting as DD/MM/YYYY when first > 12)', () => {
    // 13 > 12 → first part is day, second is month
    const result = parseDate('13-06-2026');
    expect(result).toEqual({ type: 'date-only', year: 2026, month: 6, day: 13 });
  });

  it('parses MM-DD-YYYY (interpreting as MM/DD/YYYY when first <= 12)', () => {
    // 11 <= 12 → first part is month
    const result = parseDate('11-06-2026');
    expect(result).toEqual({ type: 'date-only', year: 2026, month: 11, day: 6 });
  });

  it('parses MM-DD-YY with 2-digit year', () => {
    const result = parseDate('06-11-26');
    expect(result).toEqual({ type: 'date-only', year: 2026, month: 6, day: 11 });
  });

  it('does NOT parse YYYY/MM/DD with slashes (current code limitation)', () => {
    // The regex only matches YYYY-MM-DD with dashes for ISO format
    const result = parseDate('2026/06/11');
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseDate('')).toBeNull();
  });

  it('returns null for invalid date string', () => {
    expect(parseDate('not-a-date')).toBeNull();
  });

  it('returns null for gibberish', () => {
    expect(parseDate('hello-world')).toBeNull();
  });
});

// ===========================================================================
// deadlineToCalendarDay
// ===========================================================================

describe('deadlineToCalendarDay()', () => {
  it('converts date-only deadline', () => {
    const d: Deadline = { type: 'date-only', year: 2026, month: 12, day: 25 };
    expect(deadlineToCalendarDay(d)).toEqual({ year: 2026, month: 12, day: 25 });
  });

  it('converts datetime deadline', () => {
    const d: Deadline = { type: 'datetime', date: new Date('2026-12-25T10:00:00') };
    const result = deadlineToCalendarDay(d);
    expect(result).toEqual({ year: 2026, month: 12, day: 25 });
  });
});

// ===========================================================================
// deadlineToDateString
// ===========================================================================

describe('deadlineToDateString()', () => {
  it('returns YYYY-MM-DD for date-only', () => {
    const d: Deadline = { type: 'date-only', year: 2026, month: 3, day: 5 };
    expect(deadlineToDateString(d)).toBe('2026-03-05');
  });

  it('returns YYYY-MM-DD for datetime', () => {
    const d: Deadline = { type: 'datetime', date: new Date('2026-12-01T08:00:00') };
    expect(deadlineToDateString(d)).toBe('2026-12-01');
  });

  it('returns null for null input', () => {
    expect(deadlineToDateString(null)).toBeNull();
  });

  it('pads single-digit month and day', () => {
    const d: Deadline = { type: 'date-only', year: 2026, month: 1, day: 9 };
    expect(deadlineToDateString(d)).toBe('2026-01-09');
  });
});

// ===========================================================================
// compareCalendarDays
// ===========================================================================

describe('compareCalendarDays()', () => {
  it('returns 0 for equal days', () => {
    expect(compareCalendarDays(
      { year: 2026, month: 6, day: 11 },
      { year: 2026, month: 6, day: 11 },
    )).toBe(0);
  });

  it('returns negative when a < b', () => {
    expect(compareCalendarDays(
      { year: 2026, month: 6, day: 10 },
      { year: 2026, month: 6, day: 11 },
    )).toBeLessThan(0);
  });

  it('returns positive when a > b', () => {
    expect(compareCalendarDays(
      { year: 2026, month: 6, day: 12 },
      { year: 2026, month: 6, day: 11 },
    )).toBeGreaterThan(0);
  });

  it('compares year first', () => {
    expect(compareCalendarDays(
      { year: 2025, month: 12, day: 31 },
      { year: 2026, month: 1, day: 1 },
    )).toBeLessThan(0);
  });

  it('compares month second', () => {
    expect(compareCalendarDays(
      { year: 2026, month: 5, day: 1 },
      { year: 2026, month: 6, day: 1 },
    )).toBeLessThan(0);
  });
});

// ===========================================================================
// addDaysToCalendarDay
// ===========================================================================

describe('addDaysToCalendarDay()', () => {
  it('adds positive days', () => {
    expect(addDaysToCalendarDay({ year: 2026, month: 6, day: 11 }, 5))
      .toEqual({ year: 2026, month: 6, day: 16 });
  });

  it('adds negative days', () => {
    expect(addDaysToCalendarDay({ year: 2026, month: 6, day: 11 }, -3))
      .toEqual({ year: 2026, month: 6, day: 8 });
  });

  it('wraps into next month', () => {
    expect(addDaysToCalendarDay({ year: 2026, month: 6, day: 28 }, 5))
      .toEqual({ year: 2026, month: 7, day: 3 });
  });

  it('wraps into previous month', () => {
    expect(addDaysToCalendarDay({ year: 2026, month: 6, day: 1 }, -3))
      .toEqual({ year: 2026, month: 5, day: 29 });
  });

  it('wraps into next year', () => {
    expect(addDaysToCalendarDay({ year: 2026, month: 12, day: 30 }, 3))
      .toEqual({ year: 2027, month: 1, day: 2 });
  });

  it('handles zero days', () => {
    expect(addDaysToCalendarDay({ year: 2026, month: 6, day: 11 }, 0))
      .toEqual({ year: 2026, month: 6, day: 11 });
  });
});

// ===========================================================================
// taskDeadlineOnCalendarDay
// ===========================================================================

describe('taskDeadlineOnCalendarDay()', () => {
  it('returns true when date-only matches reference date', () => {
    const d: Deadline = { type: 'date-only', year: 2026, month: 6, day: 11 };
    expect(taskDeadlineOnCalendarDay(d, new Date('2026-06-11'))).toBe(true);
  });

  it('returns true when datetime matches reference date', () => {
    const d: Deadline = { type: 'datetime', date: new Date('2026-06-11T15:00:00') };
    expect(taskDeadlineOnCalendarDay(d, new Date('2026-06-11'))).toBe(true);
  });

  it('returns false when dates differ', () => {
    const d: Deadline = { type: 'date-only', year: 2026, month: 6, day: 12 };
    expect(taskDeadlineOnCalendarDay(d, new Date('2026-06-11'))).toBe(false);
  });

  it('returns false when month differs', () => {
    const d: Deadline = { type: 'date-only', year: 2026, month: 7, day: 11 };
    expect(taskDeadlineOnCalendarDay(d, new Date('2026-06-11'))).toBe(false);
  });
});

// ===========================================================================
// taskDeadlineOverdueBeforeDay
// ===========================================================================

describe('taskDeadlineOverdueBeforeDay()', () => {
  it('returns true when deadline is before reference date', () => {
    const d: Deadline = { type: 'date-only', year: 2026, month: 6, day: 10 };
    expect(taskDeadlineOverdueBeforeDay(d, new Date('2026-06-11'))).toBe(true);
  });

  it('returns false when deadline is on reference date', () => {
    const d: Deadline = { type: 'date-only', year: 2026, month: 6, day: 11 };
    expect(taskDeadlineOverdueBeforeDay(d, new Date('2026-06-11'))).toBe(false);
  });

  it('returns false when deadline is after reference date', () => {
    const d: Deadline = { type: 'date-only', year: 2026, month: 6, day: 12 };
    expect(taskDeadlineOverdueBeforeDay(d, new Date('2026-06-11'))).toBe(false);
  });
});

// ===========================================================================
// parseTaskLine
// ===========================================================================

describe('parseTaskLine()', () => {
  it('parses an incomplete task with calendar emoji date', () => {
    const result = parseTaskLine('- [ ] Buy milk 📅 2026-06-11', 'test.md', 3);
    expect(result).not.toBeNull();
    // text includes everything after the checkbox (including date marker)
    expect(result!.text).toBe('Buy milk 📅 2026-06-11');
    expect(result!.completed).toBe(false);
    expect(result!.deadline).toEqual({ type: 'date-only', year: 2026, month: 6, day: 11 });
    expect(result!.source).toBe('inline');
    expect(result!.filePath).toBe('test.md');
    expect(result!.lineNumber).toBe(3);
  });

  it('parses a completed task', () => {
    const result = parseTaskLine('- [x] Buy milk 📅 2026-06-11', 'test.md', 5);
    expect(result).not.toBeNull();
    expect(result!.completed).toBe(true);
  });

  it('parses [X] as completed', () => {
    const result = parseTaskLine('- [X] Buy milk 📅 2026-06-11', 'test.md', 5);
    expect(result).not.toBeNull();
    expect(result!.completed).toBe(true);
  });

  it('parses due:: prefix date', () => {
    const result = parseTaskLine('- [ ] Quarterly review due:: 2026-07-01', 'test.md', 7);
    expect(result).not.toBeNull();
    expect(result!.deadline).toEqual({ type: 'date-only', year: 2026, month: 7, day: 1 });
  });

  it('parses scheduled:: prefix date', () => {
    const result = parseTaskLine('- [ ] Plan vacation scheduled:: 2026-08-15', 'test.md', 9);
    expect(result).not.toBeNull();
    expect(result!.deadlineString).toContain('2026-08-15');
  });

  it('parses starts:: prefix date', () => {
    const result = parseTaskLine('- [ ] Start project starts:: 2026-09-01', 'test.md', 11);
    expect(result).not.toBeNull();
    expect(result!.deadline).toEqual({ type: 'date-only', year: 2026, month: 9, day: 1 });
  });

  it('returns null for non-task line', () => {
    expect(parseTaskLine('This is not a task', 'test.md', 1)).toBeNull();
  });

  it('returns null for a list item without checkbox', () => {
    expect(parseTaskLine('- Just a list item', 'test.md', 2)).toBeNull();
  });

  it('returns task with null deadline when no date found', () => {
    const result = parseTaskLine('- [ ] Simple task without date', 'test.md', 4);
    expect(result).not.toBeNull();
    expect(result!.deadline).toBeNull();
    expect(result!.deadlineString).toBeNull();
  });

  it('generates stable ID that ignores line number', () => {
    const a = parseTaskLine('- [ ] Task 📅 2026-06-11', 'same.md', 1);
    const b = parseTaskLine('- [ ] Task 📅 2026-06-11', 'same.md', 99);
    expect(a!.id).toBe(b!.id);
  });

  it('generates different IDs for different task text', () => {
    const a = parseTaskLine('- [ ] Task A 📅 2026-06-11', 'same.md', 1);
    const b = parseTaskLine('- [ ] Task B 📅 2026-06-11', 'same.md', 1);
    expect(a!.id).not.toBe(b!.id);
  });
});

// ===========================================================================
// parseDate — space separator (issue #88)
// ===========================================================================

describe('parseDate() — space separator (issue #88)', () => {
  it('parses YYYY-MM-DD HH:MM as datetime', () => {
    const result = parseDate('2026-07-22 12:30');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('datetime');
  });

  it('parses YYYY-MM-DD HH:MM:SS as datetime', () => {
    const result = parseDate('2026-07-22 12:30:45');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('datetime');
  });

  it('still parses YYYY-MM-DDTHH:MM as datetime (T separator)', () => {
    const result = parseDate('2026-07-22T12:30');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('datetime');
  });

  it('still parses YYYY-MM-DD as date-only', () => {
    const result = parseDate('2026-07-22');
    expect(result).toEqual({ type: 'date-only', year: 2026, month: 7, day: 22 });
  });
});

// ===========================================================================
// Inline task time parsing (issue #88)
// ===========================================================================

describe('Inline task time parsing (issue #88)', () => {
  // AC1
  it('parses space-separated time after 📅 as datetime and populates timeString/isAtTime', () => {
    const result = parseTaskLine('- [ ] Call Grandma 📅 2026-07-22 12:30', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline).not.toBeNull();
    expect(result!.deadline!.type).toBe('datetime');
    expect(result!.timeString).toBe('12:30');
    expect(result!.isAtTime).toBe(true);
  });

  // AC2
  it('keeps date-only tasks as date-only with null timeString and isAtTime=false', () => {
    const result = parseTaskLine('- [ ] Buy milk 📅 2026-07-22', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline).toEqual({ type: 'date-only', year: 2026, month: 7, day: 22 });
    expect(result!.timeString).toBeNull();
    expect(result!.isAtTime).toBe(false);
  });

  // AC3
  it('parses seconds-precision time but reports HH:MM in timeString', () => {
    const result = parseTaskLine('- [ ] Call Grandma 📅 2026-07-22 12:30:45', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline!.type).toBe('datetime');
    expect(result!.timeString).toBe('12:30');
    expect(result!.isAtTime).toBe(true);
  });

  // AC4
  it('parses T-separated ISO datetime after 📅', () => {
    const result = parseTaskLine('- [ ] Call Grandma 📅 2026-07-22T12:30', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline!.type).toBe('datetime');
    expect(result!.timeString).toBe('12:30');
    expect(result!.isAtTime).toBe(true);
  });

  // AC5
  it('falls back to date-only for malformed time without throwing', () => {
    expect(() => parseTaskLine('- [ ] Call Grandma 📅 2026-07-22 25:99', 'note.md', 1)).not.toThrow();
    const result = parseTaskLine('- [ ] Call Grandma 📅 2026-07-22 25:99', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline).toEqual({ type: 'date-only', year: 2026, month: 7, day: 22 });
    expect(result!.timeString).toBeNull();
    expect(result!.isAtTime).toBe(false);
  });

  // AC6
  it('parses due:: with time as datetime', () => {
    const result = parseTaskLine('- [ ] Quarterly review due:: 2026-07-22 09:00', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline!.type).toBe('datetime');
    expect(result!.timeString).toBe('09:00');
    expect(result!.isAtTime).toBe(true);
  });

  // AC7
  it('parses scheduled:: with time as datetime', () => {
    const result = parseTaskLine('- [ ] Plan trip scheduled:: 2026-07-22 14:00', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline!.type).toBe('datetime');
    expect(result!.timeString).toBe('14:00');
    expect(result!.isAtTime).toBe(true);
  });

  it('parses starts:: with time as datetime', () => {
    const result = parseTaskLine('- [ ] Start project starts:: 2026-07-22 08:15', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline!.type).toBe('datetime');
    expect(result!.timeString).toBe('08:15');
    expect(result!.isAtTime).toBe(true);
  });

  it('parses time via parseInlineTasks (end-to-end)', () => {
    const content = [
      '- [ ] With time 📅 2026-08-01 09:30',
      '- [ ] Without time 📅 2026-08-02',
    ].join('\n');
    const tasks = parseInlineTasks(content, 'note.md');
    expect(tasks).toHaveLength(2);
    const withTime = tasks.find(t => t.text.includes('With time'))!;
    const withoutTime = tasks.find(t => t.text.includes('Without time'))!;
    expect(withTime.deadline!.type).toBe('datetime');
    expect(withTime.timeString).toBe('09:30');
    expect(withTime.isAtTime).toBe(true);
    expect(withoutTime.deadline!.type).toBe('date-only');
    expect(withoutTime.timeString).toBeNull();
    expect(withoutTime.isAtTime).toBe(false);
  });
});

// ===========================================================================
// Reminder-plugin inline syntax (issue #96)
// ===========================================================================

describe('Reminder-plugin inline syntax (issue #96)', () => {
  // AC1: @YYYY-MM-DD HH:MM
  it('parses bare @YYYY-MM-DD HH:MM as datetime', () => {
    const result = parseTaskLine('- [ ] Call Grandma @2026-07-22 12:30', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline).not.toBeNull();
    expect(result!.deadline!.type).toBe('datetime');
    expect(result!.timeString).toBe('12:30');
    expect(result!.isAtTime).toBe(true);
    expect(result!.deadlineString).toBe('@2026-07-22 12:30');
  });

  // AC2: (@YYYY-MM-DD HH:MM)
  it('parses parenthesized (@YYYY-MM-DD HH:MM) as datetime', () => {
    const result = parseTaskLine('- [ ] Call Grandma (@2026-07-22 12:30)', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline!.type).toBe('datetime');
    expect(result!.timeString).toBe('12:30');
    expect(result!.isAtTime).toBe(true);
    expect(result!.deadlineString).toBe('(@2026-07-22 12:30)');
  });

  // AC3: (@YYYY-MM-DD)
  it('parses parenthesized (@YYYY-MM-DD) as date-only', () => {
    const result = parseTaskLine('- [ ] Buy milk (@2026-07-22)', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline).toEqual({ type: 'date-only', year: 2026, month: 7, day: 22 });
    expect(result!.timeString).toBeNull();
    expect(result!.isAtTime).toBe(false);
  });

  it('parses bare @ with T-separated ISO datetime', () => {
    const result = parseTaskLine('- [ ] Call Grandma @2026-07-22T12:30', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline!.type).toBe('datetime');
    expect(result!.timeString).toBe('12:30');
    expect(result!.isAtTime).toBe(true);
  });

  it('parses the time component of recurring reminder syntax and ignores the suffix', () => {
    const result = parseTaskLine('- [ ] Call Grandma #Task/regularly (@2026-07-31 09:00 🔁 every week on Sunday)', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline!.type).toBe('datetime');
    expect(result!.timeString).toBe('09:00');
    expect(result!.isAtTime).toBe(true);
  });

  it('treats bare @YYYY-MM-DD as date-only only via Kanban syntax (issue #97)', () => {
    // Default options (kanbanSyntaxEnabled omitted → on) recognize the
    // Kanban due-date form as a date-only deadline.
    const enabled = parseTaskLine('- [ ] Buy milk @2026-07-22', 'note.md', 1);
    expect(enabled).not.toBeNull();
    expect(enabled!.deadline).toEqual({ type: 'date-only', year: 2026, month: 7, day: 22 });
    expect(enabled!.isAtTime).toBe(false);
    // With the Kanban toggle off, the bare @ date is not a deadline.
    const disabled = parseTaskLine('- [ ] Buy milk @2026-07-22', 'note.md', 1, { kanbanSyntaxEnabled: false });
    expect(disabled).not.toBeNull();
    expect(disabled!.deadline).toBeNull();
  });

  it('does not let the generic fallback swallow @-prefixed dates it cannot resolve', () => {
    // Regression: with reminders enabled, an @-prefixed date that matches
    // no reminder pattern (here MM/DD/YYYY instead of YYYY-MM-DD) must NOT
    // leak into the bare-date fallback as a date-only deadline.
    const result = parseTaskLine('- [ ] Buy milk @07/22/2026', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline).toBeNull();
  });

  it('honours reminderSyntaxEnabled=false: bare @ datetime is ignored', () => {
    // Reminder off + Kanban off: the @ token is not a deadline at all.
    const result = parseTaskLine(
      '- [ ] Call Grandma @2026-07-22 12:30',
      'note.md',
      1,
      { reminderSyntaxEnabled: false, kanbanSyntaxEnabled: false }
    );
    expect(result).not.toBeNull();
    expect(result!.deadline).toBeNull();
  });

  it('honours reminderSyntaxEnabled=false: parenthesized date-only is ignored', () => {
    const result = parseTaskLine(
      '- [ ] Buy milk (@2026-07-22)',
      'note.md',
      1,
      { reminderSyntaxEnabled: false, kanbanSyntaxEnabled: false }
    );
    expect(result).not.toBeNull();
    expect(result!.deadline).toBeNull();
  });

  it('keeps existing obsidian syntax working when reminder syntax is disabled', () => {
    const result = parseTaskLine(
      '- [ ] Call Grandma 📅 2026-07-22 12:30',
      'note.md',
      1,
      { reminderSyntaxEnabled: false }
    );
    expect(result).not.toBeNull();
    expect(result!.deadline!.type).toBe('datetime');
    expect(result!.timeString).toBe('12:30');
  });

  it('parses all variants via parseInlineTasks (end-to-end)', () => {
    const content = [
      '- [ ] Bare at-time @2026-08-01 09:30',
      '- [ ] Paren at-time (@2026-08-01 09:30)',
      '- [ ] Paren date-only (@2026-08-02)',
      '- [ ] Plain date 2026-08-03',
    ].join('\n');
    const tasks = parseInlineTasks(content, 'note.md');
    expect(tasks).toHaveLength(4);
    const bare = tasks.find(t => t.text.includes('Bare at-time'))!;
    const paren = tasks.find(t => t.text.includes('Paren at-time'))!;
    const parenDateOnly = tasks.find(t => t.text.includes('Paren date-only'))!;
    const plain = tasks.find(t => t.text.includes('Plain date'))!;
    expect(bare.deadline!.type).toBe('datetime');
    expect(bare.timeString).toBe('09:30');
    expect(paren.deadline!.type).toBe('datetime');
    expect(paren.timeString).toBe('09:30');
    expect(parenDateOnly.deadline).toEqual({ type: 'date-only', year: 2026, month: 8, day: 2 });
    expect(plain.deadline).toEqual({ type: 'date-only', year: 2026, month: 8, day: 3 });
  });

  it('skips reminder syntax only when parseInlineTasks is told to', () => {
    const content = '- [ ] Call Grandma @2026-08-01 09:30';
    const enabled = parseInlineTasks(content, 'note.md', 0, { reminderSyntaxEnabled: true });
    const disabled = parseInlineTasks(content, 'note.md', 0, { reminderSyntaxEnabled: false, kanbanSyntaxEnabled: false });
    expect(enabled).toHaveLength(1);
    expect(disabled).toHaveLength(0);
  });
});

// ===========================================================================
// Kanban-plugin inline syntax (issue #97)
// ===========================================================================

describe('Kanban-plugin inline syntax (issue #97)', () => {
  // AC1: @YYYY-MM-DD @@HH:MM
  it('parses @YYYY-MM-DD @@HH:MM as datetime', () => {
    const result = parseTaskLine('- [ ] Call Grandma @2026-07-22 @@14:30', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline).not.toBeNull();
    expect(result!.deadline!.type).toBe('datetime');
    expect(result!.timeString).toBe('14:30');
    expect(result!.isAtTime).toBe(true);
    expect(result!.deadlineString).toBe('@2026-07-22 @@14:30');
  });

  // AC2: @YYYY-MM-DD
  it('parses @YYYY-MM-DD as date-only', () => {
    const result = parseTaskLine('- [ ] Buy milk @2026-07-22', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline).toEqual({ type: 'date-only', year: 2026, month: 7, day: 22 });
    expect(result!.timeString).toBeNull();
    expect(result!.isAtTime).toBe(false);
    expect(result!.deadlineString).toBe('@2026-07-22');
  });

  it('honours kanbanSyntaxEnabled=false: both Kanban forms are ignored', () => {
    const atTime = parseTaskLine('- [ ] Call Grandma @2026-07-22 @@14:30', 'note.md', 1, { kanbanSyntaxEnabled: false });
    expect(atTime).not.toBeNull();
    expect(atTime!.deadline).toBeNull();

    const dateOnly = parseTaskLine('- [ ] Buy milk @2026-07-22', 'note.md', 1, { kanbanSyntaxEnabled: false });
    expect(dateOnly).not.toBeNull();
    expect(dateOnly!.deadline).toBeNull();
  });

  it('keeps Reminder-plugin @YYYY-MM-DD HH:MM winning when both syntaxes are enabled', () => {
    // Reminder syntax is authoritative for the space-separated time form;
    // Kanban must not downgrade it to date-only.
    const result = parseTaskLine('- [ ] Call Grandma @2026-07-22 12:30', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline!.type).toBe('datetime');
    expect(result!.timeString).toBe('12:30');
    expect(result!.isAtTime).toBe(true);
  });

  it('parses bare @ date as date-only when only Kanban syntax is enabled', () => {
    // Reminder disabled + Kanban enabled: `@date HH:MM` is not claimable by
    // Reminder, so Kanban owns the bare `@date` token (date-only; time ignored).
    const result = parseTaskLine(
      '- [ ] Call Grandma @2026-07-22 12:30',
      'note.md',
      1,
      { reminderSyntaxEnabled: false, kanbanSyntaxEnabled: true }
    );
    expect(result).not.toBeNull();
    expect(result!.deadline).toEqual({ type: 'date-only', year: 2026, month: 7, day: 22 });
    expect(result!.timeString).toBeNull();
  });

  it('ignores a bare @@HH:MM with no date', () => {
    const result = parseTaskLine('- [ ] Call Grandma @@14:30', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline).toBeNull();
  });

  it('does not treat @date with a malformed @@ time as a deadline', () => {
    const result = parseTaskLine('- [ ] Call Grandma @2026-07-22 @@25:99', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline).toBeNull();
  });

  it('does not treat @date with a non-time @@ suffix as a deadline', () => {
    const result = parseTaskLine('- [ ] Call Grandma @2026-07-22 @@tomorrow', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline).toBeNull();
  });

  it('keeps the generic fallback from swallowing unresolvable @ dates', () => {
    // Regression: @-prefixed non-ISO dates must not leak into the
    // bare-date fallback as date-only deadlines when Kanban is on.
    const result = parseTaskLine('- [ ] Buy milk @07/22/2026', 'note.md', 1);
    expect(result).not.toBeNull();
    expect(result!.deadline).toBeNull();
  });

  it('parses all Kanban variants via parseInlineTasks (end-to-end)', () => {
    const content = [
      '- [ ] Kanban at-time @2026-08-01 @@09:30',
      '- [ ] Kanban date-only @2026-08-02',
      '- [ ] Reminder at-time @2026-08-03 10:15',
      '- [ ] Obsidian date 📅 2026-08-04',
    ].join('\n');
    const tasks = parseInlineTasks(content, 'note.md');
    expect(tasks).toHaveLength(4);
    const kanbanAtTime = tasks.find(t => t.text.includes('Kanban at-time'))!;
    const kanbanDateOnly = tasks.find(t => t.text.includes('Kanban date-only'))!;
    const reminder = tasks.find(t => t.text.includes('Reminder at-time'))!;
    const obsidian = tasks.find(t => t.text.includes('Obsidian date'))!;
    expect(kanbanAtTime.deadline!.type).toBe('datetime');
    expect(kanbanAtTime.timeString).toBe('09:30');
    expect(kanbanAtTime.isAtTime).toBe(true);
    expect(kanbanDateOnly.deadline).toEqual({ type: 'date-only', year: 2026, month: 8, day: 2 });
    expect(kanbanDateOnly.isAtTime).toBe(false);
    expect(reminder.deadline!.type).toBe('datetime');
    expect(reminder.timeString).toBe('10:15');
    expect(obsidian.deadline).toEqual({ type: 'date-only', year: 2026, month: 8, day: 4 });
  });

  it('skips Kanban syntax only when parseInlineTasks is told to', () => {
    const content = '- [ ] Kanban at-time @2026-08-01 @@09:30\n- [ ] Kanban date-only @2026-08-02';
    const enabled = parseInlineTasks(content, 'note.md', 0, { kanbanSyntaxEnabled: true });
    const disabled = parseInlineTasks(content, 'note.md', 0, { kanbanSyntaxEnabled: false });
    expect(enabled).toHaveLength(2);
    expect(disabled).toHaveLength(0);
  });
});

// ===========================================================================
// Frontmatter datetime (issue #88)
// ===========================================================================

describe('Frontmatter datetime parsing (issue #88)', () => {
  // AC8
  it('parses frontmatter scheduled with ISO datetime and sets isAtTime=true', () => {
    const content = '---\nscheduled: 2026-07-22T12:30\nstatus: open\n---\n# Meeting\nBody';
    const result = parseFrontmatterTasksFromCache(
      { scheduled: '2026-07-22T12:30', status: 'open' },
      content,
      'note.md',
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.deadline!.type).toBe('datetime');
    expect(result[0]!.timeString).toBe('12:30');
    expect(result[0]!.isAtTime).toBe(true);
  });

  it('frontmatter date-only still yields isAtTime=false and timeString=null', () => {
    const content = '---\nscheduled: 2026-07-22\nstatus: open\n---\n# Plain\nBody';
    const result = parseFrontmatterTasksFromCache(
      { scheduled: '2026-07-22', status: 'open' },
      content,
      'note.md',
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.deadline!.type).toBe('date-only');
    expect(result[0]!.timeString).toBeNull();
    expect(result[0]!.isAtTime).toBe(false);
  });
});

// ===========================================================================
// parseFrontmatterTasksFromCache
// ===========================================================================

describe('parseFrontmatterTasksFromCache()', () => {
  it('returns empty array when frontmatter is undefined', () => {
    const result = parseFrontmatterTasksFromCache(undefined, '---\n---', 'test.md');
    expect(result).toEqual([]);
  });

  it('returns empty array when no scheduled/due field', () => {
    const result = parseFrontmatterTasksFromCache(
      { status: 'open' },
      '---\nstatus: open\n---\n# Heading\nContent',
      'test.md',
    );
    expect(result).toEqual([]);
  });

  it('parses a frontmatter task with scheduled date', () => {
    const content = '---\nscheduled: 2026-06-11\nstatus: open\n---\n# My Heading\nBody';
    const result = parseFrontmatterTasksFromCache(
      { scheduled: '2026-06-11', status: 'open' },
      content,
      'notes/test.md',
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe('My Heading');
    expect(result[0]!.deadline).toEqual({ type: 'date-only', year: 2026, month: 6, day: 11 });
    expect(result[0]!.source).toBe('frontmatter');
    expect(result[0]!.completed).toBe(false);
  });

  it('parses frontmatter with due field', () => {
    const content = '---\ndue: 2026-07-04\nstatus: open\n---\n# Independence Day\nBody';
    const result = parseFrontmatterTasksFromCache(
      { due: '2026-07-04', status: 'open' },
      content,
      'test.md',
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe('Independence Day');
  });

  it('marks task as completed for done/cancelled/archived status', () => {
    for (const status of ['done', 'completed', 'cancelled', 'archived']) {
      const content = `---\nscheduled: 2026-06-11\nstatus: ${status}\n---\n# Done Task\nBody`;
      const result = parseFrontmatterTasksFromCache(
        { scheduled: '2026-06-11', status },
        content,
        'test.md',
      );
      expect(result[0]!.completed).toBe(true);
    }
  });

  it('handles completedDate field as completed', () => {
    const content = '---\nscheduled: 2026-06-11\ncompletedDate: 2026-06-10\n---\n# Completed\nBody';
    const result = parseFrontmatterTasksFromCache(
      { scheduled: '2026-06-11', completedDate: '2026-06-10' },
      content,
      'test.md',
    );
    expect(result[0]!.completed).toBe(true);
  });

  it('falls back to filename when no heading exists', () => {
    const content = '---\nscheduled: 2026-06-11\nstatus: open\n---\nJust body text';
    const result = parseFrontmatterTasksFromCache(
      { scheduled: '2026-06-11', status: 'open' },
      content,
      'folder/my-note.md',
    );
    expect(result[0]!.text).toBe('my-note');
  });

  it('parses frontmatter tags as string array', () => {
    const content = '---\nscheduled: 2026-06-11\nstatus: open\ntags: [work, urgent]\n---\n# Tagged\nBody';
    const result = parseFrontmatterTasksFromCache(
      { scheduled: '2026-06-11', status: 'open', tags: ['work', 'urgent'] },
      content,
      'test.md',
    );
    expect(result[0]!.tags).toEqual(['work', 'urgent']);
  });

  it('parses frontmatter tags as comma-separated string', () => {
    const content = '---\nscheduled: 2026-06-11\nstatus: open\ntags: work, urgent\n---\n# Tags as String\nBody';
    const result = parseFrontmatterTasksFromCache(
      { scheduled: '2026-06-11', status: 'open', tags: 'work, urgent' as unknown as string[] },
      content,
      'test.md',
    );
    expect(result[0]!.tags).toEqual(['work', 'urgent']);
  });

  it('handles tags field as non-array, non-string gracefully', () => {
    const result = parseFrontmatterTasksFromCache(
      { scheduled: '2026-06-11', status: 'open', tags: 123 as unknown as string[] },
      '---\nscheduled: 2026-06-11\n---\n# Heading',
      'test.md',
    );
    expect(result[0]!.tags).toEqual([]);
  });

  it('finds heading within first 10 lines after frontmatter', () => {
    const content = '---\nscheduled: 2026-06-11\n---\n\n\n\n## Deep Heading\nContent';
    const result = parseFrontmatterTasksFromCache(
      { scheduled: '2026-06-11' },
      content,
      'test.md',
    );
    expect(result[0]!.text).toBe('Deep Heading');
  });
});

// ===========================================================================
// parseInlineTasks
// ===========================================================================

describe('parseInlineTasks()', () => {
  it('parses inline tasks with deadlines', () => {
    const content = '- [ ] First 📅 2026-06-11\n- [ ] Second 📅 2026-06-12\n- [ ] No date\n';
    const tasks = parseInlineTasks(content, 'note.md');
    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.text)).toEqual([
      'First 📅 2026-06-11',
      'Second 📅 2026-06-12',
    ]);
  });

  it('skips lines inside a fenced code block (```)', () => {
    const content = [
      'Some intro paragraph.',
      '```',
      '- [ ] Inside code block 📅 2026-06-11',
      '- [ ] Also inside 📅 2026-06-12',
      '```',
      '- [ ] After the block 📅 2026-06-13',
    ].join('\n');
    const tasks = parseInlineTasks(content, 'note.md');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.text).toBe('After the block 📅 2026-06-13');
  });

  it('skips lines inside a tilde-fenced code block (~~~)', () => {
    const content = [
      '~~~',
      '- [ ] Inside tilde block 📅 2026-06-11',
      '~~~',
      '- [ ] After tilde block 📅 2026-06-12',
    ].join('\n');
    const tasks = parseInlineTasks(content, 'note.md');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.text).toBe('After tilde block 📅 2026-06-12');
  });

  it('respects fence length when matching closing fences', () => {
    const content = [
      '````',
      '```',
      '- [ ] Inside four-backtick block 📅 2026-06-11',
      '```',
      '- [ ] Still inside (three backticks are not enough to close) 📅 2026-06-12',
      '````',
      '- [ ] After the block 📅 2026-06-13',
    ].join('\n');
    const tasks = parseInlineTasks(content, 'note.md');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.text).toBe('After the block 📅 2026-06-13');
  });

  it('skips lines inside a code block with an info string', () => {
    const content = [
      '```typescript',
      '- [ ] Inside TS block 📅 2026-06-11',
      '```',
      '- [ ] Outside block 📅 2026-06-12',
    ].join('\n');
    const tasks = parseInlineTasks(content, 'note.md');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.text).toBe('Outside block 📅 2026-06-12');
  });

  it('returns to scanning after multiple code blocks', () => {
    const content = [
      '- [ ] Real task 1 📅 2026-06-11',
      '```',
      '- [ ] Hidden 1 📅 2026-06-12',
      '```',
      '- [ ] Real task 2 📅 2026-06-13',
      '```',
      '- [ ] Hidden 2 📅 2026-06-14',
      '```',
    ].join('\n');
    const tasks = parseInlineTasks(content, 'note.md');
    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.text)).toEqual([
      'Real task 1 📅 2026-06-11',
      'Real task 2 📅 2026-06-13',
    ]);
  });

  it('honors the startLine argument to skip frontmatter region', () => {
    const content = [
      '---',
      'scheduled: 2026-06-11',
      'status: open',
      '---',
      '- [ ] Below frontmatter 📅 2026-06-11',
    ].join('\n');
    // startLine=4 skips the 4 frontmatter lines
    const tasks = parseInlineTasks(content, 'note.md', 4);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.text).toBe('Below frontmatter 📅 2026-06-11');
  });

  it('does not treat backticks inside list items as a fence', () => {
    const content = [
      '- [ ] Use the `code` button 📅 2026-06-11',
      '- [ ] Inline ` ``` ` literal 📅 2026-06-12',
    ].join('\n');
    const tasks = parseInlineTasks(content, 'note.md');
    expect(tasks).toHaveLength(2);
  });

  it('rejects closing fence with trailing text', () => {
    // A closing fence must be only the fence chars (with optional whitespace).
    // ``` end of paragraph should NOT close the block.
    const content = [
      '```',
      '- [ ] Still inside 📅 2026-06-11',
      '``` end of paragraph',
      '- [ ] Also still inside 📅 2026-06-12',
      '```',
      '- [ ] Finally outside 📅 2026-06-13',
    ].join('\n');
    const tasks = parseInlineTasks(content, 'note.md');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.text).toBe('Finally outside 📅 2026-06-13');
  });
});

// ===========================================================================
// scanVaultForTasks (with mocked App)
// ===========================================================================

describe('scanVaultForTasks()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createMockApp(files: Array<{ path: string; content: string; frontmatter?: Record<string, unknown> }>) {
    const app = new MockApp();

    const tfiles = files.map(f => {
      const tf = new MockTFile(f.path);
      return tf;
    });

    app.vault.getFiles.mockReturnValue(tfiles);
    app.vault.read.mockImplementation((file: { path: string }) => {
      const found = files.find(f => f.path === file.path);
      return Promise.resolve(found?.content ?? '');
    });
    app.metadataCache.getFileCache.mockImplementation((file: { path: string }) => {
      const found = files.find(f => f.path === file.path);
      if (!found?.frontmatter) return null;
      return { frontmatter: found.frontmatter, frontmatterPosition: { end: { line: 3 } } };
    });

    return app;
  }

  it('returns empty array for vault with no markdown files', async () => {
    const app = createMockApp([]);
    const tasks = await scanVaultForTasks(app);
    expect(tasks).toEqual([]);
  });

  it('scans inline tasks from vault files', async () => {
    const app = createMockApp([
      {
        path: 'inbox.md',
        content: '---\n---\n- [ ] Task one 📅 2026-06-11\n- [x] Task two 📅 2026-06-10\n- [ ] No date task',
        frontmatter: undefined,
      },
    ]);
    const tasks = await scanVaultForTasks(app);
    // Only the task with a deadline should appear (no-date inline tasks are filtered in scan)
    // Wait — scanVaultForTasks pushes tasks only if they have a deadline
    expect(tasks).toHaveLength(2);
    const texts = tasks.map(t => t.text);
    expect(texts).toContain('Task one 📅 2026-06-11');
    expect(texts).toContain('Task two 📅 2026-06-10');
  });

  it('scans frontmatter tasks', async () => {
    const app = createMockApp([
      {
        path: 'project.md',
        content: '---\nscheduled: 2026-06-11\nstatus: open\n---\n# Project\nBody',
        frontmatter: { scheduled: '2026-06-11', status: 'open' },
      },
    ]);
    const tasks = await scanVaultForTasks(app);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.text).toBe('Project');
    expect(tasks[0]!.source).toBe('frontmatter');
  });

  it('respects reminderSyntaxEnabled when scanning (issue #96)', async () => {
    const content = [
      '---',
      '---',
      '- [ ] At-time task @2026-08-01 09:30',
      '- [ ] Paren date-only (@2026-08-02)',
      '- [ ] Obsidian task 📅 2026-08-03',
    ].join('\n');
    const app = createMockApp([{ path: 'inbox.md', content, frontmatter: undefined }]);

    const enabled = await scanVaultForTasks(app, { scanMode: 'whole-vault', targetFolder: '', reminderSyntaxEnabled: true });
    expect(enabled).toHaveLength(3);
    const atTime = enabled.find(t => t.text.includes('At-time task'))!;
    expect(atTime.deadline!.type).toBe('datetime');
    expect(atTime.timeString).toBe('09:30');

    const disabled = await scanVaultForTasks(app, { scanMode: 'whole-vault', targetFolder: '', reminderSyntaxEnabled: false, kanbanSyntaxEnabled: false });
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.text).toBe('Obsidian task 📅 2026-08-03');
  });

  it('respects kanbanSyntaxEnabled when scanning (issue #97)', async () => {
    const content = [
      '---',
      '---',
      '- [ ] Kanban at-time @2026-08-01 @@09:30',
      '- [ ] Kanban date-only @2026-08-02',
      '- [ ] Reminder at-time @2026-08-03 10:15',
      '- [ ] Obsidian task 📅 2026-08-04',
    ].join('\n');
    const app = createMockApp([{ path: 'inbox.md', content, frontmatter: undefined }]);

    const enabled = await scanVaultForTasks(app, { scanMode: 'whole-vault', targetFolder: '', kanbanSyntaxEnabled: true });
    expect(enabled).toHaveLength(4);
    const kanbanAtTime = enabled.find(t => t.text.includes('Kanban at-time'))!;
    expect(kanbanAtTime.deadline!.type).toBe('datetime');
    expect(kanbanAtTime.timeString).toBe('09:30');
    const kanbanDateOnly = enabled.find(t => t.text.includes('Kanban date-only'))!;
    expect(kanbanDateOnly.deadline!.type).toBe('date-only');

    const disabled = await scanVaultForTasks(app, { scanMode: 'whole-vault', targetFolder: '', kanbanSyntaxEnabled: false });
    expect(disabled).toHaveLength(2);
    expect(disabled.map(t => t.text)).toEqual(
      expect.arrayContaining(['Reminder at-time @2026-08-03 10:15', 'Obsidian task 📅 2026-08-04'])
    );
  });

  it('filters by specific folder when scanMode is specific-folder', async () => {
    const app = createMockApp([
      {
        path: 'inbox/task.md',
        content: '---\n---\n- [ ] Inbox task 📅 2026-06-11',
        frontmatter: undefined,
      },
      {
        path: 'work/task.md',
        content: '---\n---\n- [ ] Work task 📅 2026-06-11',
        frontmatter: undefined,
      },
    ]);
    const tasks = await scanVaultForTasks(app, { scanMode: 'specific-folder', targetFolder: 'work' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.filePath).toBe('work/task.md');
  });

  it('handles file read errors gracefully', async () => {
    const app = new MockApp();
    const tf = new MockTFile('broken.md');
    app.vault.getFiles.mockReturnValue([tf]);
    app.vault.read.mockRejectedValue(new Error('Permission denied'));
    app.metadataCache.getFileCache.mockReturnValue(null);

    // Should not throw
    const tasks = await scanVaultForTasks(app);
    expect(tasks).toEqual([]);
  });

  it('skips non-md files', async () => {
    const app = new MockApp();
    const tf = new MockTFile('image.png');
    app.vault.getFiles.mockReturnValue([tf]);
    app.metadataCache.getFileCache.mockReturnValue(null);

    const tasks = await scanVaultForTasks(app);
    expect(tasks).toEqual([]);
  });

  it('skips tasks inside fenced code blocks', async () => {
    const app = createMockApp([
      {
        path: 'snippets.md',
        content: [
          '# Examples',
          '- [ ] Real task 📅 2026-06-11',
          '```',
          '- [ ] [[2026-07-28]]',
          '```',
          '- [ ] Another real task 📅 2026-07-15',
        ].join('\n'),
        frontmatter: undefined,
      },
    ]);
    const tasks = await scanVaultForTasks(app);
    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.text)).toEqual([
      'Real task 📅 2026-06-11',
      'Another real task 📅 2026-07-15',
    ]);
  });
});

// ===========================================================================
// getDueTasks
// ===========================================================================

describe('getDueTasks()', () => {
  const refDate = new Date('2026-06-11');

  it('returns tasks due today and overdue', () => {
    const tasks = [
      makeInlineTask({ id: 't1', deadline: makeDeadlineDateOnly(2026, 6, 11) }), // due today
      makeInlineTask({ id: 't2', deadline: makeDeadlineDateOnly(2026, 6, 10) }), // overdue
      makeInlineTask({ id: 't3', deadline: makeDeadlineDateOnly(2026, 6, 15) }), // upcoming
    ];
    const due = getDueTasks(tasks, refDate);
    expect(due).toHaveLength(2);
    expect(due.map(t => t.id)).toEqual(['t1', 't2']);
  });

  it('excludes completed tasks', () => {
    const tasks = [
      makeInlineTask({ id: 't1', deadline: makeDeadlineDateOnly(2026, 6, 11), completed: false }),
      makeInlineTask({ id: 't2', deadline: makeDeadlineDateOnly(2026, 6, 11), completed: true }),
    ];
    const due = getDueTasks(tasks, refDate);
    expect(due).toHaveLength(1);
    expect(due[0]!.id).toBe('t1');
  });

  it('excludes tasks without deadline', () => {
    const tasks = [
      makeInlineTask({ id: 't1', deadline: makeDeadlineDateOnly(2026, 6, 11) }),
      makeInlineTask({ id: 't2', deadline: null }),
    ];
    const due = getDueTasks(tasks, refDate);
    expect(due).toHaveLength(1);
  });

  it('returns empty array when no tasks due', () => {
    const tasks = [
      makeInlineTask({ id: 't1', deadline: makeDeadlineDateOnly(2026, 6, 15) }),
    ];
    const due = getDueTasks(tasks, refDate);
    expect(due).toEqual([]);
  });
});

// ===========================================================================
// filterDueTasksByCheckFlags
// ===========================================================================

describe('filterDueTasksByCheckFlags()', () => {
  const refDate = new Date('2026-06-11');
  const todayTask = makeInlineTask({ id: 'today', deadline: makeDeadlineDateOnly(2026, 6, 11) });
  const overdueTask = makeInlineTask({ id: 'overdue', deadline: makeDeadlineDateOnly(2026, 6, 10) });

  it('returns all tasks when both flags are true', () => {
    const result = filterDueTasksByCheckFlags([todayTask, overdueTask], refDate, true, true);
    expect(result).toHaveLength(2);
  });

  it('returns only today tasks when checkToday=true, checkOverdue=false', () => {
    const result = filterDueTasksByCheckFlags([todayTask, overdueTask], refDate, true, false);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('today');
  });

  it('returns only overdue when checkToday=false, checkOverdue=true', () => {
    const result = filterDueTasksByCheckFlags([todayTask, overdueTask], refDate, false, true);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('overdue');
  });

  it('returns empty when both flags are false', () => {
    const result = filterDueTasksByCheckFlags([todayTask, overdueTask], refDate, false, false);
    expect(result).toHaveLength(0);
  });
});

// ===========================================================================
// getUpcomingTasks
// ===========================================================================

describe('getUpcomingTasks()', () => {
  const refDate = new Date('2026-06-11');

  it('returns tasks within the next N days', () => {
    const tasks = [
      makeInlineTask({ id: 't1', deadline: makeDeadlineDateOnly(2026, 6, 12) }), // tomorrow
      makeInlineTask({ id: 't2', deadline: makeDeadlineDateOnly(2026, 6, 18) }), // 7 days ahead
      makeInlineTask({ id: 't3', deadline: makeDeadlineDateOnly(2026, 6, 19) }), // 8 days ahead — excluded
    ];
    const upcoming = getUpcomingTasks(tasks, refDate, 7);
    expect(upcoming).toHaveLength(2);
    expect(upcoming.map(t => t.id)).toEqual(['t1', 't2']);
  });

  it('excludes tasks due today', () => {
    const tasks = [
      makeInlineTask({ id: 'today', deadline: makeDeadlineDateOnly(2026, 6, 11) }),
      makeInlineTask({ id: 'tomorrow', deadline: makeDeadlineDateOnly(2026, 6, 12) }),
    ];
    const upcoming = getUpcomingTasks(tasks, refDate, 3);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]!.id).toBe('tomorrow');
  });

  it('excludes completed tasks', () => {
    const tasks = [
      makeInlineTask({ id: 't1', deadline: makeDeadlineDateOnly(2026, 6, 12), completed: true }),
      makeInlineTask({ id: 't2', deadline: makeDeadlineDateOnly(2026, 6, 12), completed: false }),
    ];
    const upcoming = getUpcomingTasks(tasks, refDate, 7);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]!.id).toBe('t2');
  });

  it('returns empty array when daysAhead <= 0', () => {
    const tasks = [
      makeInlineTask({ id: 't1', deadline: makeDeadlineDateOnly(2026, 6, 12) }),
    ];
    expect(getUpcomingTasks(tasks, refDate, 0)).toEqual([]);
    expect(getUpcomingTasks(tasks, refDate, -1)).toEqual([]);
  });

  it('returns empty when no upcoming tasks', () => {
    const tasks = [
      makeInlineTask({ id: 't1', deadline: makeDeadlineDateOnly(2026, 6, 11) }), // today
    ];
    expect(getUpcomingTasks(tasks, refDate, 7)).toEqual([]);
  });
});

// ===========================================================================
// getIncompleteTasksWithDeadlines
// ===========================================================================

describe('getIncompleteTasksWithDeadlines()', () => {
  it('filters out completed tasks and tasks without deadlines', () => {
    const tasks = [
      makeInlineTask({ id: 't1', deadline: makeDeadlineDateOnly(2026, 6, 11), completed: false }),
      makeInlineTask({ id: 't2', deadline: makeDeadlineDateOnly(2026, 6, 11), completed: true }),
      makeInlineTask({ id: 't3', deadline: null }),
      makeInlineTask({ id: 't4', deadline: makeDeadlineDateOnly(2026, 6, 12), completed: false }),
    ];
    const result = getIncompleteTasksWithDeadlines(tasks);
    expect(result).toHaveLength(2);
    expect(result.map(t => t.id)).toEqual(['t1', 't4']);
  });

  it('returns empty when all tasks are completed or have no deadline', () => {
    const tasks = [
      makeInlineTask({ id: 't1', deadline: makeDeadlineDateOnly(2026, 6, 11), completed: true }),
      makeInlineTask({ id: 't2', deadline: null }),
    ];
    expect(getIncompleteTasksWithDeadlines(tasks)).toEqual([]);
  });
});

// ===========================================================================
// getTaskNotificationKey
// ===========================================================================

describe('getTaskNotificationKey()', () => {
  it('returns a key with notified prefix, task id, and date', () => {
    const task = makeInlineTask({ id: 'inline:file.md:2026-06-11:abc', deadline: makeDeadlineDateOnly(2026, 6, 11) });
    expect(getTaskNotificationKey(task)).toBe('notified:inline:file.md:2026-06-11:abc:2026-06-11');
  });

  it('uses "unknown" for deadline-less tasks', () => {
    const task = makeInlineTask({ id: 'inline:file.md:unknown:abc', deadline: null });
    expect(getTaskNotificationKey(task)).toBe('notified:inline:file.md:unknown:abc:unknown');
  });
});

// ===========================================================================
// Integration-style: full pipeline via fixtures
// ===========================================================================

describe('Task lifecycle via fixtures', () => {
  const refDate = new Date('2026-06-11');

  it('getDueTasks works correctly with allSampleTasks from fixtures', () => {
    const due = getDueTasks(allSampleTasks, refDate);
    // Should include dueTodayTasks (3) + overdueTasks (3) = 6
    expect(due).toHaveLength(6);
    // None of the completed, upcoming, or no-deadline tasks should leak in
    const dueIds = new Set(due.map((t: VaultTask) => t.id));
    for (const task of allSampleTasks) {
      const taskDue = task.deadline !== null && !task.completed;
      if (taskDue) {
        // Only if deadline is on or before refDate
        const expectedDue = compareCalendarDays(
          { year: 2026, month: 6, day: 11 },
          { year: task.deadline!.type === 'date-only' ? task.deadline!.year : task.deadline!.date.getFullYear(),
            month: task.deadline!.type === 'date-only' ? task.deadline!.month : task.deadline!.date.getMonth() + 1,
            day: task.deadline!.type === 'date-only' ? task.deadline!.day : task.deadline!.date.getDate() }
        ) >= 0;
        expect(dueIds.has(task.id)).toBe(expectedDue);
      }
    }
  });

  it('getUpcomingTasks works correctly with allSampleTasks', () => {
    // refDate=2026-06-11, daysAhead=7 → range: 2026-06-12 to 2026-06-18
    // upcomingTasks fixture has: 2026-06-15 (in range), 2026-06-20 (out of range)
    const upcoming = getUpcomingTasks(allSampleTasks, refDate, 7);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]!.text).toContain('Prepare slides');
    expect(upcoming[0]!.completed).toBe(false);
    expect(upcoming[0]!.deadline).not.toBeNull();
  });
});
