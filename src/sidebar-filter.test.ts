/**
 * Unit tests for src/sidebar-filter.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
	categorizeTasks,
	applyTimeScopeFilter,
	applyTagFilter,
	collectAllTags,
	formatRelativeDate,
	type TimeScopeFilter,
} from './sidebar-filter';
import {
	makeInlineTask,
	makeFrontmatterTask,
	makeDeadlineDateOnly,
	makeDeadlineDateTime,
	allSampleTasks,
	dueTodayTasks,
	overdueTasks,
	upcomingTasks,
	completedTasks,
	noDeadlineTasks,
} from './__fixtures__/tasks';

const REFERENCE_DATE = new Date('2026-06-11T12:00:00Z');

// ===========================================================================
// categorizeTasks
// ===========================================================================

describe('categorizeTasks()', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(REFERENCE_DATE);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('categorizes empty list', () => {
		const result = categorizeTasks([], new Date(), 7);
		expect(result.overdue).toEqual([]);
		expect(result.dueToday).toEqual([]);
		expect(result.upcoming).toEqual([]);
	});

	it('puts tasks due today into dueToday', () => {
		const result = categorizeTasks(dueTodayTasks, new Date(), 7);
		expect(result.dueToday).toHaveLength(3);
		expect(result.overdue).toEqual([]);
	});

	it('puts tasks before today into overdue', () => {
		const result = categorizeTasks(overdueTasks, new Date(), 7);
		expect(result.overdue).toHaveLength(3);
		expect(result.dueToday).toEqual([]);
	});

	it('puts tasks within daysAhead into upcoming', () => {
		const result = categorizeTasks(upcomingTasks, new Date(), 10);
		expect(result.upcoming).toHaveLength(2);
	});

	it('excludes tasks beyond daysAhead from upcoming', () => {
		// upcomingTasks: 2026-06-15 (4 days) and 2026-06-20 (9 days)
		const result = categorizeTasks(upcomingTasks, new Date(), 5);
		expect(result.upcoming).toHaveLength(1);
		expect(result.upcoming[0]!.text).toBe('Prepare slides');
	});

	it('excludes completed tasks', () => {
		const result = categorizeTasks(completedTasks, new Date(), 7);
		expect(result.overdue).toEqual([]);
		expect(result.dueToday).toEqual([]);
		expect(result.upcoming).toEqual([]);
	});

	it('excludes tasks without deadlines', () => {
		const result = categorizeTasks(noDeadlineTasks, new Date(), 7);
		expect(result.overdue).toEqual([]);
		expect(result.dueToday).toEqual([]);
		expect(result.upcoming).toEqual([]);
	});

	it('handles daysAhead=0 (no upcoming bucket)', () => {
		const result = categorizeTasks(upcomingTasks, new Date(), 0);
		expect(result.upcoming).toEqual([]);
	});

	it('categorizes the full sample mix correctly', () => {
		const result = categorizeTasks(allSampleTasks, new Date(), 10);
		expect(result.overdue).toHaveLength(3);
		expect(result.dueToday).toHaveLength(3);
		expect(result.upcoming).toHaveLength(2);
	});

	it('handles datetime deadlines', () => {
		const datetimeTask = makeInlineTask({
			id: 'inline:dt.md:2026-06-11:dt1',
			deadline: makeDeadlineDateTime('2026-06-11T15:00:00'),
		});
		const result = categorizeTasks([datetimeTask], new Date(), 7);
		expect(result.dueToday).toHaveLength(1);
	});
});

// ===========================================================================
// applyTimeScopeFilter
// ===========================================================================

describe('applyTimeScopeFilter()', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(REFERENCE_DATE);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const categorized = {
		overdue: overdueTasks,
		dueToday: dueTodayTasks,
		upcoming: upcomingTasks,
	};

	it('returns unchanged when scope is none', () => {
		const result = applyTimeScopeFilter(categorized, 'none', 10);
		expect(result).toBe(categorized);
	});

	it('hides upcoming when scope is today', () => {
		const result = applyTimeScopeFilter(categorized, 'today', 10);
		expect(result.overdue).toHaveLength(3);
		expect(result.dueToday).toHaveLength(3);
		expect(result.upcoming).toEqual([]);
	});

	it('limits upcoming to 7 days when scope is week and daysAhead > 7', () => {
		// upcomingTasks: 2026-06-15 (4 days) and 2026-06-20 (9 days)
		// With week scope, only 2026-06-15 should be included (within 7 days)
		const result = applyTimeScopeFilter(categorized, 'week', 10);
		expect(result.overdue).toHaveLength(3);
		expect(result.dueToday).toHaveLength(3);
		expect(result.upcoming).toHaveLength(1);
		expect(result.upcoming[0]!.text).toBe('Prepare slides');
	});

	it('keeps all upcoming when scope is week and daysAhead <= 7', () => {
		// With daysAhead=5, upcoming already only has tasks within 5 days
		const cat = {
			overdue: overdueTasks,
			dueToday: dueTodayTasks,
			upcoming: [upcomingTasks[0]!], // only the 4-day one
		};
		const result = applyTimeScopeFilter(cat, 'week', 5);
		expect(result.upcoming).toHaveLength(1);
	});
});

// ===========================================================================
// applyTagFilter
// ===========================================================================

describe('applyTagFilter()', () => {
	const tasksWithTags = [
		makeFrontmatterTask({ tags: ['work', 'urgent'] }),
		makeFrontmatterTask({ tags: ['personal'] }),
		makeFrontmatterTask({ tags: ['work', 'report'] }),
	];

	const categorized = {
		overdue: tasksWithTags,
		dueToday: [],
		upcoming: [],
	};

	it('returns unchanged when tag is null', () => {
		const result = applyTagFilter(categorized, null);
		expect(result).toBe(categorized);
	});

	it('returns unchanged when tag is empty string', () => {
		const result = applyTagFilter(categorized, '');
		expect(result).toBe(categorized);
	});

	it('filters to tasks matching the tag', () => {
		const result = applyTagFilter(categorized, 'work');
		expect(result.overdue).toHaveLength(2);
		expect(result.overdue.every(t => t.tags.includes('work'))).toBe(true);
	});

	it('filters to tasks matching a different tag', () => {
		const result = applyTagFilter(categorized, 'urgent');
		expect(result.overdue).toHaveLength(1);
	});

	it('returns empty when no tasks match the tag', () => {
		const result = applyTagFilter(categorized, 'nonexistent');
		expect(result.overdue).toEqual([]);
	});
});

// ===========================================================================
// collectAllTags
// ===========================================================================

describe('collectAllTags()', () => {
	it('returns empty array for tasks with no tags', () => {
		const tagless = [
			makeInlineTask({ tags: [] }),
			makeInlineTask({ tags: [] }),
		];
		expect(collectAllTags(tagless)).toEqual([]);
	});

	it('collects unique tags from all tasks', () => {
		const tasks = [
			makeFrontmatterTask({ tags: ['work', 'urgent'] }),
			makeFrontmatterTask({ tags: ['personal'] }),
			makeFrontmatterTask({ tags: ['work', 'report'] }),
		];
		const tags = collectAllTags(tasks);
		expect(tags).toContain('work');
		expect(tags).toContain('urgent');
		expect(tags).toContain('personal');
		expect(tags).toContain('report');
		expect(tags).toHaveLength(4);
	});

	it('deduplicates tags', () => {
		const tasks = [
			makeFrontmatterTask({ tags: ['work'] }),
			makeFrontmatterTask({ tags: ['work'] }),
		];
		expect(collectAllTags(tasks)).toEqual(['work']);
	});

	it('sorts tags alphabetically', () => {
		const tasks = [
			makeFrontmatterTask({ tags: ['zebra'] }),
			makeFrontmatterTask({ tags: ['apple'] }),
			makeFrontmatterTask({ tags: ['mango'] }),
		];
		expect(collectAllTags(tasks)).toEqual(['apple', 'mango', 'zebra']);
	});

	it('handles empty task list', () => {
		expect(collectAllTags([])).toEqual([]);
	});
});

// ===========================================================================
// formatRelativeDate
// ===========================================================================

describe('formatRelativeDate()', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(REFERENCE_DATE);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns "Today" for same-day deadline', () => {
		const dl = makeDeadlineDateOnly(2026, 6, 11);
		expect(formatRelativeDate(dl, new Date())).toBe('Today');
	});

	it('returns "Yesterday" for 1 day ago', () => {
		const dl = makeDeadlineDateOnly(2026, 6, 10);
		expect(formatRelativeDate(dl, new Date())).toBe('Yesterday');
	});

	it('returns "N days ago" for past deadlines', () => {
		const dl = makeDeadlineDateOnly(2026, 6, 8);
		expect(formatRelativeDate(dl, new Date())).toBe('3 days ago');
	});

	it('returns "Tomorrow" for 1 day ahead', () => {
		const dl = makeDeadlineDateOnly(2026, 6, 12);
		expect(formatRelativeDate(dl, new Date())).toBe('Tomorrow');
	});

	it('returns day name for 2-7 days ahead', () => {
		// 2026-06-13 is a Saturday
		const dl = makeDeadlineDateOnly(2026, 6, 13);
		expect(formatRelativeDate(dl, new Date())).toBe('Sat');
	});

	it('returns day name for 7 days ahead', () => {
		// 2026-06-18 is a Thursday
		const dl = makeDeadlineDateOnly(2026, 6, 18);
		expect(formatRelativeDate(dl, new Date())).toBe('Thu');
	});

	it('returns "in N days" for >7 days ahead', () => {
		const dl = makeDeadlineDateOnly(2026, 6, 21);
		expect(formatRelativeDate(dl, new Date())).toBe('in 10 days');
	});

	it('handles datetime deadlines', () => {
		const dl = makeDeadlineDateTime('2026-06-11T15:00:00');
		expect(formatRelativeDate(dl, new Date())).toBe('Today');
	});

	it('handles far past dates', () => {
		const dl = makeDeadlineDateOnly(2026, 5, 20);
		expect(formatRelativeDate(dl, new Date())).toBe('22 days ago');
	});

	it('handles year boundary (past)', () => {
		const dl = makeDeadlineDateOnly(2025, 12, 31);
		expect(formatRelativeDate(dl, new Date())).toContain('days ago');
	});
});
