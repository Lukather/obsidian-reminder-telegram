import {App} from 'obsidian';

import {sanitizeErrorMessage} from './utils';





export interface VaultTask {
	id: string;
	text: string;
	filePath: string;
	fileName: string;
	lineNumber: number;
	completed: boolean;
	deadline: Date | null;
	deadlineString: string | null;
	originalLine: string;
	source: 'inline' | 'frontmatter';
}

export interface ScanSettings {
	scanMode: 'whole-vault' | 'specific-folder';
	targetFolder: string;
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

const DATE_REGEX = /\b(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/;

function hashTaskContent(text: string, deadlineMatch: string | null): string {
	// Create a simple hash of the task content for stable identification
	const contentToHash = `${text}:${deadlineMatch || ''}`;
	let hash = 0;
	for (let i = 0; i < contentToHash.length; i++) {
		const char = contentToHash.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash; // Convert to 32bit integer
	}
	return Math.abs(hash).toString(36).substring(0, 8);
}

const OBSIDIAN_DATE_PATTERNS = [
	/📅\s*(\d{4}-\d{2}-\d{2})/,
	/due::\s*(\d{4}-\d{2}-\d{2})/i,
	/scheduled::\s*(\d{4}-\d{2}-\d{2})/i,
	/starts::\s*(\d{4}-\d{2}-\d{2})/i,
];

function parseDate(dateString: string): Date | null {
	if (!dateString) return null;
	const cleanDate = dateString.replace(/[T+].*$/, '');
	if (/^\d{4}-\d{2}-\d{2}/.test(cleanDate)) {
		const date = new Date(cleanDate);
		if (!isNaN(date.getTime())) return date;
	}

	if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(cleanDate)) {
		const parts = cleanDate.split(/[/-]/);
		if (parts.length === 3) {
			let date = new Date(`${parts[2]}-${parts[0]}-${parts[1]}T00:00:00`);
			if (!isNaN(date.getTime())) return date;
			date = new Date(`${parts[2]}-${parts[1]}-${parts[0]}T00:00:00`);
			if (!isNaN(date.getTime())) return date;
		}
	}
	return null;
}

function extractDeadline(text: string): { date: Date | null; match: string | null } {
	for (const pattern of OBSIDIAN_DATE_PATTERNS) {
		const match = text.match(pattern);
		if (match && match[1]) {
			const date = parseDate(match[1]);
			if (date) return { date, match: match[0] };
		}
	}

	const dateMatch = text.match(DATE_REGEX);

	if (dateMatch && dateMatch[1]) {
		const date = parseDate(dateMatch[1]);
		if (date) return { date, match: dateMatch[0] };
	}
	return { date: null, match: null };
}

function isTaskLine(line: string): boolean {
	return /^\s*-\s*\[[ xX]\]\s/.test(line);
}

function parseTaskLine(line: string, filePath: string, lineNumber: number): VaultTask | null {
	if (!isTaskLine(line)) return null;
	const completed = line.includes('[x]') || line.includes('[X]');
	const textMatch = line.match(/^\s*-\s*\[[ xX]\]\s*(.*)/);
	const text = textMatch && textMatch[1] ? textMatch[1].trim() : '';
	const deadlineInfo = extractDeadline(text);
	const fileName = filePath.split('/').pop() || filePath;
	
	// Create a stable task ID that includes a hash of the task content
	const taskContentHash = hashTaskContent(text, deadlineInfo.match);
	const stableId = `${filePath}:${lineNumber}:${taskContentHash}`;
	
	return {
		id: stableId,
		text,
		filePath,
		fileName,
		lineNumber,
		completed,
		deadline: deadlineInfo.date,
		deadlineString: deadlineInfo.match,
		originalLine: line,
		source: 'inline'
	};
}


function parseFrontmatter(content: string): { data: FrontmatterData | null; endLine: number } {
	const lines = content.split('\n');
	if (lines[0]?.trim() !== '---') return { data: null, endLine: 0 };

	let endLine = 0;

	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trim() === '---') {
			endLine = i;
			break;
		}
	}

	if (endLine === 0) return { data: null, endLine: 0 };
	const frontmatterLines = lines.slice(1, endLine);
	const rawData: Record<string, unknown> = {};
	let currentKey: string | null = null;

	for (const line of frontmatterLines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		const colonMatch = trimmed.match(/^([\w-]+):\s*(.*)/);

		if (colonMatch && colonMatch[1] && colonMatch[2] !== undefined) {
			const key = colonMatch[1];
			let processedValue = colonMatch[2].trim();
			if ((processedValue.startsWith('"') && processedValue.endsWith('"')) ||
				(processedValue.startsWith("'") && processedValue.endsWith("'"))) {
				processedValue = processedValue.slice(1, -1);
			}
			if (processedValue === 'true') rawData[key] = true;
			else if (processedValue === 'false') rawData[key] = false;
			else if (processedValue === 'null' || processedValue === 'nil') rawData[key] = null;
			else rawData[key] = processedValue;
			currentKey = key;
		}

		const arrayMatch = trimmed.match(/^-\s+(.+)/);

		if (arrayMatch && arrayMatch[1] && currentKey) {
			if (rawData[currentKey] === undefined) {
				rawData[currentKey] = [];
			}
			if (!Array.isArray(rawData[currentKey])) {
				rawData[currentKey] = [rawData[currentKey]];
			}
			(rawData[currentKey] as unknown[]).push(arrayMatch[1].trim());
		}
	}

	return { data: rawData as FrontmatterData, endLine };

}

function formatFrontmatterForOriginalLine(frontmatter: FrontmatterData): string {
	return `---\n${Object.entries(frontmatter).map(([k, v]) => {
		if (Array.isArray(v)) {
			return `  ${k}:\n${(v as unknown[]).map(item => `    - ${String(item)}`).join('\n')}`;
		}
		return `  ${k}: ${String(v)}`;
	}).join('\n')}\n---`;
}

interface FrontmatterCache {
	status?: string;
	scheduled?: string;
	due?: string;
	completedDate?: string;
	[key: string]: unknown;
}

function parseFrontmatterTasksFromCache(frontmatter: FrontmatterCache | undefined, content: string, filePath: string): VaultTask[] {
	const tasks: VaultTask[] = [];
	if (!frontmatter) return tasks;
	
	const hasDeadline = frontmatter.scheduled || frontmatter.due;
	if (!hasDeadline) return tasks;
	
	const fileName = filePath.split('/').pop() || filePath;
	const baseName = fileName.replace(/\.md$/, '');
	let taskText = baseName;
	
	// Try to find a heading after frontmatter for better task text
	const fileLines = content.split('\n');
	let endLine = 0;
	
	// Find where frontmatter ends
	for (let i = 0; i < fileLines.length; i++) {
		if (fileLines[i]?.trim() === '---') {
			endLine = i;
			break;
		}
	}
	
	for (let i = endLine + 1; i < Math.min(fileLines.length, endLine + 10); i++) {
		const line = fileLines[i]?.trim();
		if (line?.startsWith('#')) {
			taskText = line.replace(/^#+\s*/, '').trim();
			break;
		}
	}

	const completedStatuses = ['done', 'completed', 'cancelled', 'archived'];
	const status = frontmatter?.status;
	const statusLower = status?.toLowerCase() || '';
	const isCompleted = completedStatuses.includes(statusLower) || !!frontmatter?.completedDate;

	const deadlineString = frontmatter?.scheduled || frontmatter?.due || null;
	const deadline = deadlineString ? parseDate(deadlineString) : null;

	if (deadline) {
		// Create a stable task ID that includes a hash of the task content
		const taskContentHash = hashTaskContent(taskText, deadlineString);
		const stableId = `${filePath}:frontmatter:${taskContentHash}`;
		
		tasks.push({
			id: stableId,
			text: taskText,
			filePath,
			fileName,
			lineNumber: 0,
			completed: isCompleted,
			deadline,
			deadlineString,
			originalLine: formatFrontmatterForOriginalLine(frontmatter),
			source: 'frontmatter'
		});
	}
	return tasks;
}

function isFileInFolder(filePath: string, targetFolder: string): boolean {
	if (!targetFolder) return true;
	const normalizedTarget = targetFolder.replace(/^\/|\/$/g, '');
	const normalizedPath = filePath.replace(/^\/|\/$/g, '');

	return normalizedPath.startsWith(normalizedTarget + '/') ||
		normalizedPath === normalizedTarget;
}

export async function scanVaultForTasks(
	app: App,
	scanSettings?: ScanSettings
): Promise<VaultTask[]> {
	const tasks: VaultTask[] = [];
	const settings = scanSettings || { scanMode: 'whole-vault', targetFolder: '' };
	const files = app.vault.getFiles().filter(file => file.extension === 'md');
	for (const file of files) {
		if (settings.scanMode === 'specific-folder' && !isFileInFolder(file.path, settings.targetFolder)) {
			continue;
		}

		try {
			const content = await app.vault.read(file);
			const fileCache = app.metadataCache.getFileCache(file);
			const frontmatter = fileCache?.frontmatter;

			// Use the new frontmatter-based parsing
			tasks.push(...parseFrontmatterTasksFromCache(frontmatter, content, file.path));

			// Determine where the frontmatter ends
			const { endLine } = parseFrontmatter(content);

			const startLine = endLine + 1;

			const lines = content.split('\n');

			for (let i = startLine; i < lines.length; i++) {
				const line = lines[i];
				if (!line) continue;
				const task = parseTaskLine(line, file.path, i + 1);
				if (task?.deadline) tasks.push(task);
			}
		} catch (error) {
			console.error(`Error reading file ${file.path}:`, sanitizeErrorMessage(String(error)));
		}
	}
	return tasks;
}

export function getDueTasks(tasks: VaultTask[], date: Date): VaultTask[] {
	const startOfDay = new Date(date);
	startOfDay.setHours(0, 0, 0, 0);
	const endOfDay = new Date(date);
	endOfDay.setHours(23, 59, 59, 999);
	const now = new Date();
	return tasks.filter(task => {
		if (!task.deadline) return false;
		if (task.completed) return false;
		const deadline = task.deadline;
		return (deadline >= startOfDay && deadline <= endOfDay) || deadline < now;
	});
}

function calendarDayBounds(referenceDate: Date): { startOfDay: Date; endOfDay: Date } {
	const startOfDay = new Date(referenceDate);
	startOfDay.setHours(0, 0, 0, 0);
	const endOfDay = new Date(referenceDate);
	endOfDay.setHours(23, 59, 59, 999);
	return { startOfDay, endOfDay };
}

/** True if the deadline falls on the same calendar day as referenceDate (local). */
export function taskDeadlineOnCalendarDay(deadline: Date, referenceDate: Date): boolean {
	const { startOfDay, endOfDay } = calendarDayBounds(referenceDate);
	return deadline >= startOfDay && deadline <= endOfDay;
}

/** True if the deadline is strictly before the calendar start of referenceDate (local). */
export function taskDeadlineOverdueBeforeDay(deadline: Date, referenceDate: Date): boolean {
	const { startOfDay } = calendarDayBounds(referenceDate);
	return deadline < startOfDay;
}

/**
 * Narrows a list of already-due tasks by today vs overdue flags.
 * When both flags are true, returns tasks unchanged.
 */
export function filterDueTasksByCheckFlags(
	tasks: VaultTask[],
	referenceDate: Date,
	checkToday: boolean,
	checkOverdue: boolean
): VaultTask[] {
	if (checkToday && checkOverdue) {
		return tasks;
	}
	return tasks.filter(task => {
		if (!task.deadline) return false;
		const d = task.deadline;
		const onToday = taskDeadlineOnCalendarDay(d, referenceDate);
		const overdue = taskDeadlineOverdueBeforeDay(d, referenceDate);
		return (checkToday && onToday) || (checkOverdue && overdue);
	});
}


/**
 * Tasks due after today within the next N calendar days (excludes today and overdue).
 * daysAhead=1 notifies only tasks due tomorrow; daysAhead=7 covers tomorrow through seven days out.
 */
export function getUpcomingTasks(tasks: VaultTask[], date: Date, daysAhead: number = 7): VaultTask[] {
	if (daysAhead <= 0) {
		return [];
	}
	const { startOfDay } = calendarDayBounds(date);
	const startOfTomorrow = new Date(startOfDay);
	startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
	const endDate = new Date(startOfDay);
	endDate.setDate(endDate.getDate() + daysAhead);
	endDate.setHours(23, 59, 59, 999);
	return tasks.filter(task => {
		if (!task.deadline) return false;
		if (task.completed) return false;
		const deadline = task.deadline;
		return deadline >= startOfTomorrow && deadline <= endDate;
	});
}

export function getIncompleteTasksWithDeadlines(tasks: VaultTask[]): VaultTask[] {
	return tasks.filter(task => !task.completed && task.deadline !== null);
}

export function getTaskNotificationKey(task: VaultTask): string {
	return `notified:${task.id}:${task.deadline?.toISOString().split('T')[0]}`;
}