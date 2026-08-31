import {App} from 'obsidian';
import {sanitizeErrorMessage} from './utils';

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
const DATE_REGEX = /(?<!@)\b(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/;

export function parseDate(dateString: string): Deadline | null {
	if (!dateString) return null;

	if (/^\d{4}-\d{2}-\d{2}[ T]\d/.test(dateString)) {
		// Normalize "YYYY-MM-DD HH:MM[:SS]" → "YYYY-MM-DDTHH:MM[:SS]" for the Date constructor.
		const isoString = dateString.replace(/^(\d{4}-\d{2}-\d{2}) (\d{1,2}:\d{2}(?::\d{2})?)/, '$1T$2');
		const date = new Date(isoString);
		if (!isNaN(date.getTime())) {
			return {type: 'datetime', date};
		}
	}

	if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
		const [year, month, day] = dateString.split('-').map(Number) as [number, number, number];
		return {type: 'date-only', year, month, day};
	}

	if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(dateString)) {
		const parts = dateString.split(/[/-]/);
		if (parts.length === 3) {
			let year = Number(parts[2]);
			if (year < 100) year += 2000;

			const month = Number(parts[0]);
			const day = Number(parts[1]);
			if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
				return {type: 'date-only', year, month, day};
			}

			const day2 = Number(parts[0]);
			const month2 = Number(parts[1]);
			if (month2 >= 1 && month2 <= 12 && day2 >= 1 && day2 <= 31) {
				return {type: 'date-only', year, month: month2, day: day2};
			}
		}
	}

	return null;
}

// Deadline helpers

export function deadlineToCalendarDay(deadline: Deadline): {year: number; month: number; day: number} {
	if (deadline.type === 'date-only') {
		return {year: deadline.year, month: deadline.month, day: deadline.day};
	}
	const d = deadline.date;
	return {year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate()};
}

export function deadlineToDateString(deadline: Deadline | null): string | null {
	if (!deadline) return null;
	const cd = deadlineToCalendarDay(deadline);
	const month = cd.month.toString().padStart(2, '0');
	const day = cd.day.toString().padStart(2, '0');
	return `${cd.year}-${month}-${day}`;
}

export function compareCalendarDays(a: {year: number; month: number; day: number}, b: {year: number; month: number; day: number}): number {
	if (a.year !== b.year) return a.year - b.year;
	if (a.month !== b.month) return a.month - b.month;
	return a.day - b.day;
}

export function addDaysToCalendarDay(day: {year: number; month: number; day: number}, days: number): {year: number; month: number; day: number} {
	const d = new Date(day.year, day.month - 1, day.day);
	d.setDate(d.getDate() + days);
	return {year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate()};
}

export function taskDeadlineOnCalendarDay(deadline: Deadline, referenceDate: Date): boolean {
	const dl = deadlineToCalendarDay(deadline);
	return dl.year === referenceDate.getFullYear()
		&& dl.month === referenceDate.getMonth() + 1
		&& dl.day === referenceDate.getDate();
}

export function taskDeadlineOverdueBeforeDay(deadline: Deadline, referenceDate: Date): boolean {
	const dl = deadlineToCalendarDay(deadline);
	return compareCalendarDays(dl, {
		year: referenceDate.getFullYear(),
		month: referenceDate.getMonth() + 1,
		day: referenceDate.getDate(),
	}) < 0;
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
}

function timeStringFromDate(date: Date): string {
	const hours = date.getHours().toString().padStart(2, '0');
	const minutes = date.getMinutes().toString().padStart(2, '0');
	return `${hours}:${minutes}`;
}

function extractDeadline(text: string, options?: DeadlineParseOptions): {deadline: Deadline | null; match: string | null; timeString: string | null} {
	for (const pattern of OBSIDIAN_DATE_PATTERNS) {
		const match = text.match(pattern);
		if (match && match[1]) {
			const deadline = parseDate(match[1]);
			if (deadline) {
				const timeString = deadline.type === 'datetime' ? timeStringFromDate(deadline.date) : null;
				return {deadline, match: match[0], timeString};
			}
		}
	}
	if (options?.reminderSyntaxEnabled !== false) {
		for (const pattern of REMINDER_DATE_PATTERNS) {
			const match = text.match(pattern);
			if (match && match[1]) {
				const deadline = parseDate(match[1]);
				if (deadline) {
					const timeString = deadline.type === 'datetime' ? timeStringFromDate(deadline.date) : null;
					return {deadline, match: match[0], timeString};
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
					const timeString = deadline.type === 'datetime' ? timeStringFromDate(deadline.date) : null;
					return {deadline, match: match[0], timeString};
				}
			}
		}
	}
	const dateMatch = text.match(DATE_REGEX);
	if (dateMatch && dateMatch[1]) {
		const deadline = parseDate(dateMatch[1]);
		if (deadline) return {deadline, match: dateMatch[0], timeString: null};
	}
	return {deadline: null, match: null, timeString: null};
}

function isTaskLine(line: string): boolean {
	return /^\s*-\s*\[[ xX]\]\s/.test(line);
}

function hashTaskContent(text: string, deadlineMatch: string | null): string {
	const contentToHash = `${text}:${deadlineMatch || ''}`;
	let hash = 0;
	for (let i = 0; i < contentToHash.length; i++) {
		const char = contentToHash.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash;
	}
	return Math.abs(hash).toString(36).substring(0, 8);
}

export function parseTaskLine(
	line: string,
	filePath: string,
	lineNumber: number,
	options?: DeadlineParseOptions
): VaultTask | null {
	if (!isTaskLine(line)) return null;
	const completed = line.includes('[x]') || line.includes('[X]');
	const textMatch = line.match(/^\s*-\s*\[[ xX]\]\s*(.*)/);
	const text = textMatch && textMatch[1] ? textMatch[1].trim() : '';
	const deadlineInfo = extractDeadline(text, options);
	const fileName = filePath.split('/').pop() || filePath;

	// Stable ID: file + deadline + content hash. Line number deliberately excluded
	// so that adding lines above the task does not trigger re-notification.
	const deadlinePart = deadlineInfo.deadline ? deadlineToDateString(deadlineInfo.deadline) : '';
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
	const entries: string[] = Object.entries(obj).map(([k, v]) => {
		if (Array.isArray(v)) {
			const items = v.map(item => `    - ${String(item)}`);
			return `  ${k}:\n${items.join('\n')}`;
		}
		return `  ${k}: ${String(v)}`;
	});
	return `---\n${entries.join('\n')}\n---`;
}

export function parseFrontmatterTasksFromCache(
	frontmatter: FrontmatterData | undefined,
	content: string,
	filePath: string
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
	for (let i = endLine + 1; i < Math.min(fileLines.length, endLine + 10); i++) {
		const line = fileLines[i]?.trim();
		if (line?.startsWith('#')) {
			taskText = line.replace(/^#+\s*/, '').trim();
			firstHeadingLine = i + 1; // 1-based line number
			break;
		}
	}

	const completedStatuses = ['done', 'completed', 'cancelled', 'archived'];
	const isCompleted = completedStatuses.includes(frontmatter.status?.toLowerCase() || '') || !!frontmatter.completedDate;

	const deadlineString = frontmatter.scheduled || frontmatter.due || null;
	const deadline = deadlineString ? parseDate(deadlineString) : null;

	if (deadline) {
		const deadlinePart = deadlineToDateString(deadline) || '';
		const stableId = `frontmatter:${filePath}:${deadlinePart}`;
		const rawTags = frontmatter.tags as unknown;
		const tags: string[] = Array.isArray(rawTags)
			? rawTags.filter((t): t is string => typeof t === 'string')
			: typeof rawTags === 'string'
				? rawTags.split(',').map((t: string) => t.trim()).filter(Boolean)
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
			timeString: deadline?.type === 'datetime' ? timeStringFromDate(deadline.date) : null,
			isAtTime: deadline?.type === 'datetime',
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
		normalizedPath.startsWith(normalizedTarget + '/') || normalizedPath === normalizedTarget
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

		const trimmed: string = line.trimStart();
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
		} else if (firstChar === fenceChar && len >= fenceLength && trailing === '') {
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
	options?: DeadlineParseOptions
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
	scanSettings?: ScanSettings
): Promise<VaultTask[]> {
	const tasks: VaultTask[] = [];
	const settings = scanSettings || {scanMode: 'whole-vault', targetFolder: ''};
	const files = app.vault.getFiles().filter(file => file.extension === 'md');

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

			tasks.push(...parseFrontmatterTasksFromCache(frontmatter, content, file.path));

			const endLine = fileCache?.frontmatterPosition?.end?.line ?? findFrontmatterEndLine(content);
			tasks.push(...parseInlineTasks(content, file.path, endLine + 1, {
				reminderSyntaxEnabled: settings.reminderSyntaxEnabled,
				kanbanSyntaxEnabled: settings.kanbanSyntaxEnabled,
			}));
		} catch (error) {
			console.error(
				`Error reading file ${file.path}:`,
				sanitizeErrorMessage(String(error))
			);
		}
	}
	return tasks;
}

// Filtering

export function getDueTasks(tasks: VaultTask[], date: Date): VaultTask[] {
	return tasks.filter(task => {
		if (!task.deadline || task.completed) return false;
		return taskDeadlineOnCalendarDay(task.deadline, date) || taskDeadlineOverdueBeforeDay(task.deadline, date);
	});
}

export function filterDueTasksByCheckFlags(
	tasks: VaultTask[],
	referenceDate: Date,
	checkToday: boolean,
	checkOverdue: boolean
): VaultTask[] {
	if (checkToday && checkOverdue) return tasks;
	return tasks.filter(task => {
		if (!task.deadline) return false;
		return (checkToday && taskDeadlineOnCalendarDay(task.deadline, referenceDate))
			|| (checkOverdue && taskDeadlineOverdueBeforeDay(task.deadline, referenceDate));
	});
}

export function getUpcomingTasks(tasks: VaultTask[], date: Date, daysAhead: number = 7): VaultTask[] {
	if (daysAhead <= 0) return [];

	const refDay = {
		year: date.getFullYear(),
		month: date.getMonth() + 1,
		day: date.getDate(),
	};
	const tomorrow = addDaysToCalendarDay(refDay, 1);
	const futureEnd = addDaysToCalendarDay(refDay, daysAhead);

	return tasks.filter(task => {
		if (!task.deadline || task.completed) return false;
		const dl = deadlineToCalendarDay(task.deadline);
		return compareCalendarDays(dl, tomorrow) >= 0 && compareCalendarDays(dl, futureEnd) <= 0;
	});
}

export function getIncompleteTasksWithDeadlines(tasks: VaultTask[]): VaultTask[] {
	return tasks.filter(task => !task.completed && task.deadline !== null);
}

// Notification key

export function getTaskNotificationKey(task: VaultTask): string {
	const datePart = deadlineToDateString(task.deadline) || 'unknown';
	return `notified:${task.id}:${datePart}`;
}
