import {App, TAbstractFile, TFile} from 'obsidian';

import {
	VaultTask,
	ScanSettings,
	scanVaultForTasks,
	parseFrontmatterTasksFromCache,
	parseInlineTasks,
} from './tasks';
import {sanitizeErrorMessage} from './utils';

/**
 * Incremental in-memory index of vault tasks.
 *
 * - On load: one full scan via scanVaultForTasks().
 * - After that: updates individual files via Obsidian vault events,
 *   avoiding full re-reads of the vault on every check interval.
 */
export class TaskIndex {
	private index = new Map<string, VaultTask[]>();
	private scanSettings: ScanSettings;

	constructor(
		private app: App,
		scanSettings?: ScanSettings
	) {
		this.scanSettings = scanSettings || {scanMode: 'whole-vault', targetFolder: ''};
	}

	async buildIndex(): Promise<void> {
		this.index.clear();
		const allTasks = await scanVaultForTasks(this.app, this.scanSettings);
		for (const task of allTasks) {
			const bucket = this.index.get(task.filePath) || [];
			bucket.push(task);
			this.index.set(task.filePath, bucket);
		}
	}

	updateScanSettings(scanSettings: ScanSettings): void {
		this.scanSettings = scanSettings;
		// Force a full rebuild when scope changes
		void this.buildIndex();
	}

	async updateFile(file: TFile): Promise<void> {
		if (!this.shouldTrack(file)) {
			this.index.delete(file.path);
			return;
		}

		try {
			const content = await this.app.vault.read(file);
			const fileCache = this.app.metadataCache.getFileCache(file);
			const frontmatter = fileCache?.frontmatter;

			const tasks: VaultTask[] = [];
			tasks.push(...parseFrontmatterTasksFromCache(frontmatter, content, file.path));

			const endLine =
				fileCache?.frontmatterPosition?.end?.line ??
				this.fallbackFrontmatterEndLine(content);
			tasks.push(...parseInlineTasks(content, file.path, endLine + 1));

			this.index.set(file.path, tasks);
		} catch (error) {
			console.error(
				`Error updating task index for ${file.path}:`,
				sanitizeErrorMessage(String(error))
			);
		}
	}

	removeFile(file: TAbstractFile): void {
		if (file instanceof TFile && file.extension === 'md') {
			this.index.delete(file.path);
		}
	}

	getAllTasks(): VaultTask[] {
		const result: VaultTask[] = [];
		for (const tasks of this.index.values()) {
			result.push(...tasks);
		}
		return result;
	}

	private shouldTrack(file: TFile): boolean {
		if (file.extension !== 'md') return false;
		if (this.scanSettings.scanMode === 'specific-folder') {
			return this.isFileInFolder(file.path, this.scanSettings.targetFolder);
		}
		return true;
	}

	private isFileInFolder(filePath: string, targetFolder: string): boolean {
		if (!targetFolder) return true;
		const normalizedTarget = targetFolder.replace(/^\/|\/$/g, '');
		const normalizedPath = filePath.replace(/^\/|\/$/g, '');
		return (
			normalizedPath.startsWith(normalizedTarget + '/') ||
			normalizedPath === normalizedTarget
		);
	}

	private fallbackFrontmatterEndLine(content: string): number {
		const lines = content.split('\n');
		if (lines[0]?.trim() !== '---') return 0;
		for (let i = 1; i < lines.length; i++) {
			if (lines[i]?.trim() === '---') return i;
		}
		return 0;
	}
}
