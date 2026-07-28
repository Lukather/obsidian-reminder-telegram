import {
	VaultTask,
	Deadline,
	deadlineToCalendarDay,
	compareCalendarDays,
	addDaysToCalendarDay,
} from './tasks';

export type TimeScopeFilter = 'today' | 'week' | 'none';

export interface CategorizedTasks {
	overdue: VaultTask[];
	dueToday: VaultTask[];
	upcoming: VaultTask[];
}

export interface SidebarFilterState {
	timeScope: TimeScopeFilter;
	selectedTag: string | null;
}

/**
 * Categorize incomplete tasks with deadlines into Overdue, Due Today, and Upcoming buckets.
 */
export function categorizeTasks(
	tasks: VaultTask[],
	referenceDate: Date,
	daysAhead: number
): CategorizedTasks {
	const refDay = {
		year: referenceDate.getFullYear(),
		month: referenceDate.getMonth() + 1,
		day: referenceDate.getDate(),
	};
	const tomorrow = addDaysToCalendarDay(refDay, 1);
	const futureEnd = addDaysToCalendarDay(refDay, daysAhead);

	const overdue: VaultTask[] = [];
	const dueToday: VaultTask[] = [];
	const upcoming: VaultTask[] = [];

	for (const task of tasks) {
		if (task.completed || !task.deadline) continue;
		const dl = deadlineToCalendarDay(task.deadline);
		const cmpToday = compareCalendarDays(dl, refDay);

		if (cmpToday < 0) {
			overdue.push(task);
		} else if (cmpToday === 0) {
			dueToday.push(task);
		} else if (
			compareCalendarDays(dl, tomorrow) >= 0 &&
			compareCalendarDays(dl, futureEnd) <= 0
		) {
			upcoming.push(task);
		}
	}

	return {overdue, dueToday, upcoming};
}

/**
 * Apply the time-scope filter to a categorized result.
 * - 'today': hide upcoming entirely
 * - 'week': restrict upcoming to next 7 days (already handled by categorizeTasks if daysAhead==7)
 * - 'none': keep all sections as-is
 */
export function applyTimeScopeFilter(
	categorized: CategorizedTasks,
	scope: TimeScopeFilter,
	daysAhead: number
): CategorizedTasks {
	if (scope === 'none') return categorized;

	if (scope === 'today') {
		return {
			overdue: categorized.overdue,
			dueToday: categorized.dueToday,
			upcoming: [],
		};
	}

	// scope === 'week' — limit upcoming to 7 days regardless of daysAhead setting
	if (daysAhead <= 7) return categorized;

	const now = new Date();
	const refDay = {year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate()};
	const weekEnd = addDaysToCalendarDay(refDay, 7);

	return {
		overdue: categorized.overdue,
		dueToday: categorized.dueToday,
		upcoming: categorized.upcoming.filter(task => {
			if (!task.deadline) return false;
			return compareCalendarDays(deadlineToCalendarDay(task.deadline), weekEnd) <= 0;
		}),
	};
}

/**
 * Apply tag filter to a categorized result.
 */
export function applyTagFilter(
	categorized: CategorizedTasks,
	tag: string | null
): CategorizedTasks {
	if (!tag) return categorized;
	const matches = (task: VaultTask): boolean => task.tags.includes(tag);
	return {
		overdue: categorized.overdue.filter(matches),
		dueToday: categorized.dueToday.filter(matches),
		upcoming: categorized.upcoming.filter(matches),
	};
}

/**
 * Collect all unique frontmatter tags from a list of tasks.
 */
export function collectAllTags(tasks: VaultTask[]): string[] {
	const set = new Set<string>();
	for (const task of tasks) {
		for (const tag of task.tags) {
			set.add(tag);
		}
	}
	return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/**
 * Format a deadline as a friendly relative string.
 * Examples: "Today", "Yesterday", "Tue", "in 3 days"
 */
export function formatRelativeDate(deadline: Deadline, referenceDate: Date): string {
	const dl = deadlineToCalendarDay(deadline);
	const refDay = {
		year: referenceDate.getFullYear(),
		month: referenceDate.getMonth() + 1,
		day: referenceDate.getDate(),
	};

	const cmp = compareCalendarDays(dl, refDay);
	if (cmp === 0) return 'Today';
	if (cmp < 0) {
		const past = new Date(refDay.year, refDay.month - 1, refDay.day);
		const d = new Date(dl.year, dl.month - 1, dl.day);
		const diff = Math.round((past.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
		if (diff === 1) return 'Yesterday';
		return `${diff} days ago`;
	}

	// Future
	const future = new Date(dl.year, dl.month - 1, dl.day);
	const ref = new Date(refDay.year, refDay.month - 1, refDay.day);
	const diff = Math.round((future.getTime() - ref.getTime()) / (1000 * 60 * 60 * 24));
	if (diff === 1) return 'Tomorrow';
	if (diff <= 7) {
		const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
		return dayNames[future.getDay()]!;
	}
	return `in ${diff} days`;
}
