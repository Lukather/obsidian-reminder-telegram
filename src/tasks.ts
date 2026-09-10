import { App } from 'obsidian';
import { sanitizeErrorMessage } from './utils';

// Types

export interface DateOnlyDeadline {
	type: 'date-only';
	year: number;
	month: number;
	day: number;
}

export interface DateTimeDeadline {
	type: 'datetime';
	date: Date;
}

export type Deadline = DateOnlyDeadline | DateTimeDeadline;

export type RecurrencePeriod = 'day' | 'week' | 'month' | 'year';

/**
 * Recurrence metadata parsed from `🔁 every …` syntax (issue #98).
 * Only inline tasks can recur — frontmatter tasks have no line to reschedule.
 */
export interface Recurrence {
	/** How often the task repeats. */
	period: RecurrencePeriod;
	/**
	 * 0=Sunday … 6=Saturday. Only present for `week` when the user wrote
	 * `on <weekday>` AND the weekday name resolved; undefined means "every
	 * 7 days".
	 */
	weekday?: number;
	/** The raw matched suffix (e.g. "every week on Sunday") — kept verbatim. */
	raw: string;
}

export interface VaultTask {
	id: string;
	text: string;
	filePath: string;
	fileName: string;
	lineNumber: number;
	completed: boolean;
	deadline: Deadline | null;
	deadlineString: string | null;
	/** "HH:MM" when the deadline carries a time; null for date-only or missing deadlines. */
	timeString: string | null;
	/** True iff `deadline?.type === 'datetime'`. */
	isAtTime: boolean;
	recurrence: Recurrence | null;
	originalLine: string;
	source: 'inline' | 'frontmatter';
	/** Frontmatter tags extracted from the note (frontmatter only; inline hashtags not parsed). */
	tags: string[];
	/** For frontmatter tasks, the line number of the first heading in the note (used for scroll-to-heading). */
	headingLineNumber?: number;
}

export interface ScanSettings {
	scanMode: 'whole-vault' | 'specific-folder';
	targetFolder: string;
	/**
	 * Recognize Reminder-plugin inline syntax (`@YYYY-MM-DD HH:MM`,
	 * `(@YYYY-MM-DD HH:MM)`, `(@YYYY-MM-DD)`). Defaults to true when
	 * omitted (backwards compatible with direct callers).
	 */
	reminderSyntaxEnabled?: boolean;
	/**
	 * Recognize Kanban-plugin inline syntax (`@YYYY-MM-DD` date-only,
	 * `@YYYY-MM-DD @@HH:MM` datetime). Defaults to true when omitted
	 * (backwards compatible with direct callers).
	 */
	kanbanSyntaxEnabled?: boolean;
	/**
	 * Recognize recurring-task syntax (`🔁 every …`) and allow auto-reschedule
	 * on completion. Defaults to true when omitted (backwards compatible).
	 */
	recurringTasksEnabled?: boolean;
}

interface FrontmatterData {
	status?: string;
	scheduled?: string;
	due?: string;
	tags?: string[];
	priority?: string;
	completedDate?: string;
	dateCreated?: string;
	dateModified?: string;
	[key: string]: unknown;
}

// Date parsing

// Generic bare-date fallback. The `(?<!@)` guard keeps Reminder-plugin
// `@`-prefixed dates out of this generic path: `@` dates are owned by
// REMINDER_DATE_PATTERNS below (gated by the reminderSyntaxEnabled toggle),
// so they must never leak in as date-only deadlines when the feature is off.
const DATE_REGEX =
	/(?<!@)\b(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/;

export function parseDate(dateString: string): Deadline | null {
	if (!dateString) return null;

	if (/^\d{4}-\d{2}-\d{2}[ T]\d/.test(dateString)) {
		// Normalize "YYYY-MM-DD HH:MM[:SS]" → "YYYY-MM-DDTHH:MM[:SS]" for the Date constructor.
		const isoString = dateString.replace(
			/^(\d{4}-\d{2}-\d{2}) (\d{1,2}:\d{2}(?::\d{2})?)/,
			'$1T$2',
		);
		const date = new Date(isoString);
		if (!isNaN(date.getTime())) {
			return { type: 'datetime', date };
		}
	}

	if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
		const [year, month, day] = dateString.split('-').map(Number) as [
			number,
			number,
			number,
		];
		return { type: 'date-only', year, month, day };
	}

	if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(dateString)) {
		const parts = dateString.split(/[/-]/);
		if (parts.length === 3) {
			let year = Number(parts[2]);
			if (year < 100) year += 2000;

			const month = Number(parts[0]);
			const day = Number(parts[1]);
			if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
				return { type: 'date-only', year, month, day };
			}

			const day2 = Number(parts[0]);
			const month2 = Number(parts[1]);
			if (month2 >= 1 && month2 <= 12 && day2 >= 1 && day2 <= 31) {
				return { type: 'date-only', year, month: month2, day: day2 };
			}
		}
	}

	return null;
}

// Deadline helpers

export function deadlineToCalendarDay(deadline: Deadline): {
	year: number;
	month: number;
	day: number;
} {
	if (deadline.type === 'date-only') {
		return {
			year: deadline.year,
			month: deadline.month,
			day: deadline.day,
		};
	}
	const d = deadline.date;
	return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

export function deadlineToDateString(deadline: Deadline | null): string | null {
	if (!deadline) return null;
	const cd = deadlineToCalendarDay(deadline);
	const monthStr = String(cd.month);
	const dayStr = String(cd.day);
	return `${cd.year}-${monthStr.length < 2 ? '0' : ''}${monthStr}-${dayStr.length < 2 ? '0' : ''}${dayStr}`;
}

export function compareCalendarDays(
	a: { year: number; month: number; day: number },
	b: { year: number; month: number; day: number },
): number {
	if (a.year !== b.year) return a.year - b.year;
	if (a.month !== b.month) return a.month - b.month;
	return a.day - b.day;
}

export function addDaysToCalendarDay(
	day: { year: number; month: number; day: number },
	days: number,
): { year: number; month: number; day: number } {
	const d = new Date(day.year, day.month - 1, day.day);
	d.setDate(d.getDate() + days);
	return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

export function taskDeadlineOnCalendarDay(
	deadline: Deadline,
	referenceDate: Date,
): boolean {
	const dl = deadlineToCalendarDay(deadline);
	return (
		dl.year === referenceDate.getFullYear() &&
		dl.month === referenceDate.getMonth() + 1 &&
		dl.day === referenceDate.getDate()
	);
}

export function taskDeadlineOverdueBeforeDay(
	deadline: Deadline,
	referenceDate: Date,
): boolean {
	const dl = deadlineToCalendarDay(deadline);
	return (
		compareCalendarDays(dl, {
			year: referenceDate.getFullYear(),
			month: referenceDate.getMonth() + 1,
			day: referenceDate.getDate(),
		}) < 0
	);
}

// Inline task parsing

const OBSIDIAN_DATE_PATTERNS = [
	/📅\s*(\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)/,
	/due::\s*(\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)/i,
	/scheduled::\s*(\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)/i,
	/starts::\s*(\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)/i,
];

// Reminder-plugin inline syntax (issue #96). Parenthesized form first so
// `(@2026-07-22 12:30)` captures its full source span (parens included) and
// the date-only form `(@2026-07-22)` resolves before the bare-@ pattern.
// The Reminder-plugin bare form requires a time component — `@2026-07-22`
// without a time is not recognized by THIS pattern set (the Kanban
// patterns below own the bare date-only form, gated by kanbanSyntaxEnabled).
const REMINDER_DATE_PATTERNS = [
	/\(@(\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)\)/,
	/@(\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?)/,
];

// Kanban-plugin inline syntax (issue #97). `@YYYY-MM-DD` is the due-date
// form (date-only deadline, standard task interval behavior); appending a
// `@@HH:MM` time makes it a datetime deadline owned by the at-time
// scheduler. Order matters: the date+time form MUST be matched before the
// bare date form, and the bare form refuses dates followed by a `@@` token
// so a malformed time (e.g. `@@tomorrow`) can't degrade into date-only.
const KANBAN_DATE_PATTERNS = [
	/@(\d{4}-\d{2}-\d{2}) @@(\d{1,2}:\d{2})/,
	/@(\d{4}-\d{2}-\d{2})(?!\s*@@)/,
];

export interface DeadlineParseOptions {
	/**
	 * Recognize Reminder-plugin `@` syntax. Defaults to true when omitted —
	 * existing callers (tests, TaskIndex defaults) keep current behavior.
	 */
	reminderSyntaxEnabled?: boolean;
	/**
	 * Recognize Kanban-plugin `@`/`@@` syntax. Defaults to true when omitted.
	 */
	kanbanSyntaxEnabled?: boolean;
	/**
	 * Recognize recurring-task syntax (`🔁 every …`). Defaults to true when omitted.
	 */
	recurringTasksEnabled?: boolean;
}

function timeStringFromDate(date: Date): string {
	const h = String(date.getHours());
	const m = String(date.getMinutes());
	return `${h.length < 2 ? '0' : ''}${h}:${m.length < 2 ? '0' : ''}${m}`;
}

function extractDeadline(
	text: string,
	options?: DeadlineParseOptions,
): {
	deadline: Deadline | null;
	match: string | null;
	timeString: string | null;
} {
	for (const pattern of OBSIDIAN_DATE_PATTERNS) {
		const match = text.match(pattern);
		if (match && match[1]) {
			const deadline = parseDate(match[1]);
			if (deadline) {
				const timeString =
					deadline.type === 'datetime'
						? timeStringFromDate(deadline.date)
						: null;
				return { deadline, match: match[0], timeString };
			}
		}
	}
	if (options?.reminderSyntaxEnabled !== false) {
		for (const pattern of REMINDER_DATE_PATTERNS) {
			const match = text.match(pattern);
			if (match && match[1]) {
				const deadline = parseDate(match[1]);
				if (deadline) {
					const timeString =
						deadline.type === 'datetime'
							? timeStringFromDate(deadline.date)
							: null;
					return { deadline, match: match[0], timeString };
				}
			}
		}
	}
	if (options?.kanbanSyntaxEnabled !== false) {
		for (const pattern of KANBAN_DATE_PATTERNS) {
			const match = text.match(pattern);
			// The date+time form carries the time in capture group 2;
			// `parseDate` then normalizes "YYYY-MM-DD HH:MM" → datetime.
			if (match && match[1]) {
				const raw = match[2] ? `${match[1]} ${match[2]}` : match[1];
				const deadline = parseDate(raw);
				if (deadline) {
					const timeString =
						deadline.type === 'datetime'
							? timeStringFromDate(deadline.date)
							: null;
					return { deadline, match: match[0], timeString };
				}
			}
		}
	}
	const dateMatch = text.match(DATE_REGEX);
	if (dateMatch && dateMatch[1]) {
		const deadline = parseDate(dateMatch[1]);
		if (deadline)
			return { deadline, match: dateMatch[0], timeString: null };
	}
	return { deadline: null, match: null, timeString: null };
}

function isTaskLine(line: string): boolean {
	return /^\s*-\s*\[[ xX]\]\s/.test(line);
}

function hashTaskContent(text: string, deadlineMatch: string | null): string {
	const contentToHash = `${text}:${deadlineMatch || ''}`;
	let hash = 0;
	for (let i = 0; i < contentToHash.length; i++) {
		const char = contentToHash.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash;
	}
	return Math.abs(hash).toString(36).substring(0, 8);
}

export function parseTaskLine(
	line: string,
	filePath: string,
	lineNumber: number,
	options?: DeadlineParseOptions,
): VaultTask | null {
	if (!isTaskLine(line)) return null;
	const completed = line.includes('[x]') || line.includes('[X]');
	const textMatch = line.match(/^\s*-\s*\[[ xX]\]\s*(.*)/);
	const text = textMatch && textMatch[1] ? textMatch[1].trim() : '';
	const deadlineInfo = extractDeadline(text, options);
	const fileName = filePath.split('/').pop() || filePath;
	const recurrence =
		options?.recurringTasksEnabled === false ? null : parseRecurrence(text);

	// Stable ID: file + deadline + content hash. Line number deliberately excluded
	// so that adding lines above the task does not trigger re-notification.
	const deadlinePart = deadlineInfo.deadline
		? deadlineToDateString(deadlineInfo.deadline)
		: '';
	const contentHash = hashTaskContent(text, deadlineInfo.match);
	const stableId = `inline:${filePath}:${deadlinePart}:${contentHash}`;

	return {
		id: stableId,
		text,
		filePath,
		fileName,
		lineNumber,
		completed,
		deadline: deadlineInfo.deadline,
		deadlineString: deadlineInfo.match,
		timeString: deadlineInfo.timeString,
		isAtTime: deadlineInfo.deadline?.type === 'datetime',
		recurrence,
		originalLine: line,
		source: 'inline',
		tags: [],
	};
}

// Frontmatter helpers

function findFrontmatterEndLine(content: string): number {
	const lines = content.split('\n');
	if (lines[0]?.trim() !== '---') return 0;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trim() === '---') return i;
	}
	return 0;
}

function formatFrontmatterSummary(frontmatter: FrontmatterData): string {
	const obj: Record<string, unknown> = frontmatter;
	const entries: string[] = [];
	for (const k of Object.keys(obj)) {
		const v: unknown = obj[k];
		if (Array.isArray(v)) {
			const items: string[] = [];
			for (const item of v) {
				items.push(`    - ${String(item)}`);
			}
			entries.push(`  ${k}:\n${items.join('\n')}`);
		} else {
			entries.push(`  ${k}: ${String(v)}`);
		}
	}
	return `---\n${entries.join('\n')}\n---`;
}

export function parseFrontmatterTasksFromCache(
	frontmatter: FrontmatterData | undefined,
	content: string,
	filePath: string,
): VaultTask[] {
	const tasks: VaultTask[] = [];
	if (!frontmatter) return tasks;
	if (!frontmatter.scheduled && !frontmatter.due) return tasks;

	const fileName = filePath.split('/').pop() || filePath;
	const baseName = fileName.replace(/\.md$/, '');
	let taskText = baseName;
	let firstHeadingLine = 0;

	const fileLines = content.split('\n');
	const endLine = findFrontmatterEndLine(content);
	for (
		let i = endLine + 1;
		i < Math.min(fileLines.length, endLine + 10);
		i++
	) {
		const line = fileLines[i]?.trim();
		if (line?.startsWith('#')) {
			taskText = line.replace(/^#+\s*/, '').trim();
			firstHeadingLine = i + 1; // 1-based line number
			break;
		}
	}

	const completedStatuses = ['done', 'completed', 'cancelled', 'archived'];
	const isCompleted =
		completedStatuses.includes(frontmatter.status?.toLowerCase() || '') ||
		!!frontmatter.completedDate;

	const deadlineString = frontmatter.scheduled || frontmatter.due || null;
	const deadline = deadlineString ? parseDate(deadlineString) : null;

	if (deadline) {
		const deadlinePart = deadlineToDateString(deadline) || '';
		const stableId = `frontmatter:${filePath}:${deadlinePart}`;
		const rawTags = frontmatter.tags as unknown;
		const tags: string[] = Array.isArray(rawTags)
			? rawTags.filter((t): t is string => typeof t === 'string')
			: typeof rawTags === 'string'
				? rawTags
						.split(',')
						.map((t: string) => t.trim())
						.filter(Boolean)
				: [];

		tasks.push({
			id: stableId,
			text: taskText,
			filePath,
			fileName,
			lineNumber: 0,
			completed: isCompleted,
			deadline,
			deadlineString,
			timeString:
				deadline?.type === 'datetime'
					? timeStringFromDate(deadline.date)
					: null,
			isAtTime: deadline?.type === 'datetime',
			recurrence: null,
			originalLine: formatFrontmatterSummary(frontmatter),
			source: 'frontmatter',
			tags,
			headingLineNumber: firstHeadingLine || undefined,
		});
	}
	return tasks;
}

function isFileInFolder(filePath: string, targetFolder: string): boolean {
	if (!targetFolder) return true;
	const normalizedTarget = targetFolder.replace(/^\/|\/$/g, '');
	const normalizedPath = filePath.replace(/^\/|\/$/g, '');

	return (
		normalizedPath.startsWith(normalizedTarget + '/') ||
		normalizedPath === normalizedTarget
	);
}

/**
 * Build a parallel array marking which lines of the file are inside a fenced
 * code block (CommonMark ``` or ~~~ fences). Lines that are themselves a fence
 * are also marked, so callers can simply skip `inCodeBlock[i]` to ignore both
 * the fence and its content.
 */
function buildCodeBlockMap(lines: string[]): boolean[] {
	const inCodeBlock: boolean[] = [];
	let depth = 0;
	let fenceChar = '';
	let fenceLength = 0;
	for (let i = 0; i < lines.length; i++) {
		const line: string = lines[i] ?? '';
		if (depth > 0) inCodeBlock[i] = true;

		const trimmed: string = line.replace(/^[ \t]+/, '');
		if (trimmed.length < 3) continue;
		const firstChar: string = trimmed[0] ?? '';
		if (firstChar !== '`' && firstChar !== '~') continue;

		let len = 0;
		while (len < trimmed.length && trimmed[len] === firstChar) len++;
		if (len < 3) continue;

		const trailing: string = trimmed.slice(len).trim();

		if (depth === 0) {
			// Opening fence: trailing info string is allowed.
			depth = 1;
			fenceChar = firstChar;
			fenceLength = len;
		} else if (
			firstChar === fenceChar &&
			len >= fenceLength &&
			trailing === ''
		) {
			// Closing fence: same char, at least as long, no extra content.
			depth = 0;
		}
	}
	return inCodeBlock;
}

/**
 * Parse inline tasks from note content, skipping lines inside fenced code blocks.
 * `startLine` lets callers skip the frontmatter region.
 */
export function parseInlineTasks(
	content: string,
	filePath: string,
	startLine: number = 0,
	options?: DeadlineParseOptions,
): VaultTask[] {
	const tasks: VaultTask[] = [];
	const lines = content.split('\n');
	const inCodeBlock = buildCodeBlockMap(lines);
	for (let i = startLine; i < lines.length; i++) {
		if (inCodeBlock[i]) continue;
		const line = lines[i];
		if (!line) continue;
		const task = parseTaskLine(line, filePath, i + 1, options);
		if (task?.deadline) tasks.push(task);
	}
	return tasks;
}

// Vault scanning

export async function scanVaultForTasks(
	app: App,
	scanSettings?: ScanSettings,
): Promise<VaultTask[]> {
	const tasks: VaultTask[] = [];
	const settings = scanSettings || {
		scanMode: 'whole-vault',
		targetFolder: '',
	};
	const files = app.vault
		.getFiles()
		.filter((file) => file.extension === 'md');

	for (const file of files) {
		if (
			settings.scanMode === 'specific-folder' &&
			!isFileInFolder(file.path, settings.targetFolder)
		) {
			continue;
		}

		try {
			const content = await app.vault.read(file);
			const fileCache = app.metadataCache.getFileCache(file);
			const frontmatter = fileCache?.frontmatter;

			tasks.push(
				...parseFrontmatterTasksFromCache(
					frontmatter,
					content,
					file.path,
				),
			);

			const endLine =
				fileCache?.frontmatterPosition?.end?.line ??
				findFrontmatterEndLine(content);
			tasks.push(
				...parseInlineTasks(content, file.path, endLine + 1, {
					reminderSyntaxEnabled: settings.reminderSyntaxEnabled,
					kanbanSyntaxEnabled: settings.kanbanSyntaxEnabled,
					recurringTasksEnabled: settings.recurringTasksEnabled,
				}),
			);
		} catch (error) {
			console.error(
				`Error reading file ${file.path}:`,
				sanitizeErrorMessage(String(error)),
			);
		}
	}
	return tasks;
}

// Filtering

export function getDueTasks(tasks: VaultTask[], date: Date): VaultTask[] {
	return tasks.filter((task) => {
		if (!task.deadline || task.completed) return false;
		return (
			taskDeadlineOnCalendarDay(task.deadline, date) ||
			taskDeadlineOverdueBeforeDay(task.deadline, date)
		);
	});
}

export function filterDueTasksByCheckFlags(
	tasks: VaultTask[],
	referenceDate: Date,
	checkToday: boolean,
	checkOverdue: boolean,
): VaultTask[] {
	if (checkToday && checkOverdue) return tasks;
	return tasks.filter((task) => {
		if (!task.deadline) return false;
		return (
			(checkToday &&
				taskDeadlineOnCalendarDay(task.deadline, referenceDate)) ||
			(checkOverdue &&
				taskDeadlineOverdueBeforeDay(task.deadline, referenceDate))
		);
	});
}

/**
 * Apply the catch-up window (issue #99) to a list of due/overdue tasks.
 *
 * When Obsidian/PC is off, reminders can't be sent; on the next open we catch
 * up on tasks that were missed — but only if they became due recently enough.
 * Tasks overdue by more than `windowMinutes` are silently dropped (they never
 * fire for that missed window). Tasks due today (or later) are always kept.
 *
 * Overdue age is measured from the task's own deadline: exact timestamp for
 * datetime deadlines, end of the deadline's calendar day for date-only tasks
 * (a date-only task becomes "overdue" when its day is over).
 *
 * A window of 0 or less disables the gate entirely (backwards compatible).
 */
export function filterOverdueByCatchUpWindow(
	tasks: VaultTask[],
	referenceDate: Date,
	windowMinutes: number,
): VaultTask[] {
	if (windowMinutes <= 0) return tasks;
	const windowMs = windowMinutes * 60 * 1000;
	const refMs = referenceDate.getTime();
	const today: { year: number; month: number; day: number } = {
		year: referenceDate.getFullYear(),
		month: referenceDate.getMonth() + 1,
		day: referenceDate.getDate(),
	};
	return tasks.filter((task) => {
		if (!task.deadline) return true;
		const dl = deadlineToCalendarDay(task.deadline);
		// Due today or later → never gated by the catch-up window.
		if (compareCalendarDays(dl, today) >= 0) return true;
		const missedAt =
			task.deadline.type === 'datetime'
				? task.deadline.date.getTime()
				: // Date-only: the task becomes overdue when its day ends.
					new Date(dl.year, dl.month - 1, dl.day + 1).getTime();
		return refMs - missedAt <= windowMs;
	});
}

export function getUpcomingTasks(
	tasks: VaultTask[],
	date: Date,
	daysAhead: number = 7,
): VaultTask[] {
	if (daysAhead <= 0) return [];

	const refDay = {
		year: date.getFullYear(),
		month: date.getMonth() + 1,
		day: date.getDate(),
	};
	const tomorrow = addDaysToCalendarDay(refDay, 1);
	const futureEnd = addDaysToCalendarDay(refDay, daysAhead);

	return tasks.filter((task) => {
		if (!task.deadline || task.completed) return false;
		const dl = deadlineToCalendarDay(task.deadline);
		return (
			compareCalendarDays(dl, tomorrow) >= 0 &&
			compareCalendarDays(dl, futureEnd) <= 0
		);
	});
}

export function getIncompleteTasksWithDeadlines(
	tasks: VaultTask[],
): VaultTask[] {
	return tasks.filter((task) => !task.completed && task.deadline !== null);
}

// Notification key

export function getTaskNotificationKey(task: VaultTask): string {
	const datePart = deadlineToDateString(task.deadline) || 'unknown';
	return `notified:${task.id}:${datePart}`;
}

// ---------------------------------------------------------------------------
// Recurring tasks (issue #98)
// ---------------------------------------------------------------------------

/** 0=Sunday … 6=Saturday. Full names + common abbreviations.**/
const WEEKDAY_NAMES: Record<string, number> = {
	sunday: 0,
	sun: 0,
	monday: 1,
	mon: 1,
	tuesday: 2,
	tue: 2,
	tues: 2,
	wednesday: 3,
	wed: 3,
	thursday: 4,
	thu: 4,
	thur: 4,
	thurs: 4,
	friday: 5,
	fri: 5,
	saturday: 6,
	sat: 6,
};

/** `🔁 every day | week [on <weekday>] | month | year` — case-insensitive keywords. */
const RECURRENCE_PATTERN =
	/🔁\s+every\s+(day|week|month|year)(?:\s+on\s+([A-Za-z]+))?/i;

/**
 * Parse `🔁 every …` recurrence syntax from a task line. Returns null when
 * absent. An unknown weekday name falls back to plain weekly (`on <weekday>`
 * is then just preserved verbatim in `raw`).
 */
export function parseRecurrence(text: string): Recurrence | null {
	const match = text.match(RECURRENCE_PATTERN);
	if (!match) return null;
	const period = match[1]!.toLowerCase() as RecurrencePeriod;
	const recurrence: Recurrence = {
		period,
		raw: match[0].replace(/^🔁\s+/i, ''),
	};
	if (period === 'week') {
		const weekdayName = match[2]?.toLowerCase();
		if (weekdayName) {
			const weekday = WEEKDAY_NAMES[weekdayName];
			if (weekday !== undefined) recurrence.weekday = weekday;
		}
	}
	return recurrence;
}

function daysInMonth(year: number, month: number): number {
	// month is 1-based; day 0 of the next month = last day of this month.
	return new Date(year, month, 0).getDate();
}

/** Min/max-safe calendar-day arithmetic for month/year steps. */
interface CalendarDay {
	year: number;
	month: number; // 1-based
	day: number;
}

/**
 * Compute the `k`-th occurrence of `recurrence` strictly after `base`, where
 * k ≥ 1. Computed from the BASE day each time (not from the previous clamped
 * result) so `every month` on the 31st stays on the 31st: Jan 31 → Feb 28 →
 * Mar 31 rather than drifting to the 28th.
 */
function nthOccurrence(
	base: CalendarDay,
	recurrence: Recurrence,
	k: number,
): CalendarDay {
	switch (recurrence.period) {
		case 'day':
			return addDaysToCalendarDay(base, k);
		case 'week': {
			if (recurrence.weekday === undefined) {
				return addDaysToCalendarDay(base, 7 * k);
			}
			// First matching weekday strictly after base, then every 7 days.
			const baseWeekday = new Date(
				base.year,
				base.month - 1,
				base.day,
			).getDay();
			let delta = recurrence.weekday - baseWeekday;
			if (delta <= 0) delta += 7;
			return addDaysToCalendarDay(base, delta + 7 * (k - 1));
		}
		case 'month': {
			const total = base.month - 1 + k; // 0-based
			const year = base.year + Math.floor(total / 12);
			const month = (total % 12) + 1;
			return {
				year,
				month,
				day: Math.min(base.day, daysInMonth(year, month)),
			};
		}
		case 'year': {
			const year = base.year + k;
			return {
				year,
				month: base.month,
				day: Math.min(base.day, daysInMonth(year, base.month)),
			};
		}
	}
}

function buildDeadlineForCalendarDay(
	original: Deadline,
	day: CalendarDay,
): Deadline {
	if (original.type === 'date-only') {
		return {
			type: 'date-only',
			year: day.year,
			month: day.month,
			day: day.day,
		};
	}
	const t = original.date;
	return {
		type: 'datetime',
		date: new Date(
			day.year,
			day.month - 1,
			day.day,
			t.getHours(),
			t.getMinutes(),
			t.getSeconds(),
			t.getMilliseconds(),
		),
	};
}

/**
 * Next occurrence of a recurring deadline. Stepping is anchored to the
 * ORIGINAL deadline and advances until the result is strictly after `now`, so
 * an overdue recurring task reschedules into the future rather than staying
 * stuck in the past. Returns null only if the recurrence cannot be satisfied
 * within a sane number of steps (should not happen in practice).
 */
export function computeNextOccurrence(
	deadline: Deadline,
	recurrence: Recurrence,
	now: Date = new Date(),
): Deadline | null {
	const base = deadlineToCalendarDay(deadline);
	const today: CalendarDay = {
		year: now.getFullYear(),
		month: now.getMonth() + 1,
		day: now.getDate(),
	};
	for (let k = 1; k <= 5000; k++) {
		const candidate = nthOccurrence(base, recurrence, k);
		if (compareCalendarDays(candidate, today) > 0) {
			return buildDeadlineForCalendarDay(deadline, candidate);
		}
	}
	return null;
}

/**
 * Replace the first date-like run inside a deadline token with an ISO
 * `YYYY-MM-DD` date (the rewrite normalizes exotic formats like `MM/DD/YYYY`
 * to ISO — the recurrence syntax itself is always canonical YYYY-MM-DD).
 * Any time component (`09:00`, `@@12:30`) is left untouched.
 */
function replaceDateInToken(token: string, isoDate: string): string {
	return token.replace(/\d{1,4}[-/]\d{1,2}[-/]\d{2,4}/, isoDate);
}

/** Flip a completed checkbox back to open. */
function uncheckLine(line: string): string {
	return line.replace(/\[[xX]\]/, '[ ]');
}

export interface NextOccurrenceLine {
	/** The full rewritten task line (box unchecked, deadline advanced). */
	line: string;
	/** The computed next deadline. */
	deadline: Deadline;
}

/**
 * Build the rescheduled line for a completed recurring task: same text and
 * metadata, checkbox flipped back to `[ ]`, deadline advanced to the next
 * occurrence. Returns null for non-recurring tasks or when no deadline exists.
 */
export function buildNextOccurrenceLine(
	task: VaultTask,
	now: Date = new Date(),
): NextOccurrenceLine | null {
	if (!task.deadline || !task.recurrence || !task.deadlineString) return null;
	const next = computeNextOccurrence(task.deadline, task.recurrence, now);
	if (!next) return null;
	const nextToken = replaceDateInToken(
		task.deadlineString,
		deadlineToDateString(next)!,
	);
	const line = uncheckLine(
		task.originalLine.replace(task.deadlineString, nextToken),
	);
	return { line, deadline: next };
}

export interface RescheduleEdit {
	/** 1-based line number of the task in the file. */
	lineNumber: number;
	/** The exact current line (the completed task). */
	oldLine: string;
	/** The replacement line (unchecked, deadline advanced). */
	newLine: string;
}

/**
 * Diff a file's tasks before/after a vault change and emit the lines to
 * rewrite for tasks that just transitioned open → completed AND carry a
 * recurrence. Pure — callers (e.g. the plugin's modify handler) apply the
 * edits via vault.process().
 */
export function computeCompletionReschedules(
	before: VaultTask[],
	after: VaultTask[],
	now: Date = new Date(),
): RescheduleEdit[] {
	const afterById = new Map(after.map((t) => [t.id, t]));
	const edits: RescheduleEdit[] = [];
	for (const oldTask of before) {
		if (oldTask.completed || !oldTask.recurrence) continue;
		// The stable id embeds deadline + content hash, so the same line after
		// the checkbox flip resolves to the same id (unless text changed).
		const newTask = afterById.get(oldTask.id);
		if (!newTask || !newTask.completed) continue;
		const built = buildNextOccurrenceLine(newTask, now);
		if (!built || built.line === newTask.originalLine) continue;
		edits.push({
			lineNumber: newTask.lineNumber,
			oldLine: newTask.originalLine,
			newLine: built.line,
		});
	}
	edits.sort((a, b) => a.lineNumber - b.lineNumber);
	return edits;
}

/**
 * Apply reschedule edits to file content. Edits whose line no longer matches
 * (concurrent edits shifting line numbers) are skipped defensively.
 */
export function applyRescheduleEdits(
	content: string,
	edits: RescheduleEdit[],
): string {
	const lines = content.split('\n');
	for (const edit of edits) {
		const index = edit.lineNumber - 1;
		if (
			index >= 0 &&
			index < lines.length &&
			lines[index] === edit.oldLine
		) {
			lines[index] = edit.newLine;
		}
	}
	return lines.join('\n');
}
