import {App} from 'obsidian';

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
	return {
		id: `${filePath}:${lineNumber}`,
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

function parseFrontmatterTasks(content: string, filePath: string): VaultTask[] {
	const tasks: VaultTask[] = [];
	const { data: frontmatter, endLine } = parseFrontmatter(content);
	if (!frontmatter) return tasks;

	const hasDeadline = frontmatter.scheduled || frontmatter.due;
	if (!hasDeadline) return tasks;

	const fileName = filePath.split('/').pop() || filePath;
	const baseName = fileName.replace(/\.md$/, '');

	let taskText = baseName;
	const fileLines = content.split('\n');
	for (let i = endLine + 1; i < Math.min(fileLines.length, endLine + 10); i++) {
		const line = fileLines[i]?.trim();
		if (line?.startsWith('#')) {
			taskText = line.replace(/^#+\s*/, '').trim();
			break;
		}
	}

	const completedStatuses = ['done', 'completed', 'cancelled', 'archived'];
	const status = frontmatter.status;
	const statusLower = status?.toLowerCase() || '';
	const isCompleted = completedStatuses.includes(statusLower) || !!frontmatter.completedDate;

	const deadlineString = frontmatter.scheduled || frontmatter.due || null;
	const deadline = deadlineString ? parseDate(deadlineString) : null;

	if (deadline) {
		tasks.push({
			id: `${filePath}:frontmatter`,
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

	const files = app.vault.getMarkdownFiles();

	for (const file of files) {
		if (settings.scanMode === 'specific-folder' && !isFileInFolder(file.path, settings.targetFolder)) {
			continue;
		}

		try {
			const content = await app.vault.read(file);
			tasks.push(...parseFrontmatterTasks(content, file.path));

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
			console.error(`Error reading file ${file.path}:`, error);
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

export function getUpcomingTasks(tasks: VaultTask[], date: Date, daysAhead: number = 7): VaultTask[] {
	const now = new Date(date);
	now.setHours(0, 0, 0, 0);
	const futureDate = new Date(now);
	futureDate.setDate(futureDate.getDate() + daysAhead);
	futureDate.setHours(23, 59, 59, 999);
	return tasks.filter(task => {
		if (!task.deadline) return false;
		if (task.completed) return false;
		const deadline = task.deadline;
		return deadline >= now && deadline <= futureDate;
	});
}

export function getIncompleteTasksWithDeadlines(tasks: VaultTask[]): VaultTask[] {
	return tasks.filter(task => !task.completed && task.deadline !== null);
}

export function getTaskNotificationKey(task: VaultTask): string {
	return `notified:${task.id}:${task.deadline?.toISOString().split('T')[0]}`;
}
