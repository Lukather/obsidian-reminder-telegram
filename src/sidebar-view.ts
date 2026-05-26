import {ItemView, WorkspaceLeaf} from 'obsidian';
import {VaultTask} from './tasks';
import {
	SidebarFilterState,
	TimeScopeFilter,
	categorizeTasks,
	applyTimeScopeFilter,
	applyTagFilter,
	collectAllTags,
	formatRelativeDate,
} from './sidebar-filter';

export const SIDEBAR_VIEW_TYPE = 'reminder-telegram-sidebar';

export interface SidebarDataProvider {
	getTasksForSidebar(): VaultTask[];
	getUpcomingDaysAhead(): number;
	openTask(task: VaultTask): Promise<void>;
}

export class ReminderTelegramSidebarView extends ItemView {
	private provider: SidebarDataProvider;
	private container: HTMLElement | null = null;
	private filterState: SidebarFilterState = {timeScope: 'none', selectedTag: null};
	private refreshTimer: number | null = null;
	private readonly DEBOUNCE_MS = 400;

	constructor(leaf: WorkspaceLeaf, provider: SidebarDataProvider) {
		super(leaf);
		this.provider = provider;
	}

	getViewType(): string {
		return SIDEBAR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Reminder Telegram';
	}

	getIcon(): string {
		return 'bell';
	}

	async onOpen(): Promise<void> {
		this.container = this.contentEl.createDiv({cls: 'reminder-telegram-sidebar'});
		this.render();
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.container = null;
	}

	/**
	 * Called by the plugin when the task index changes. Debounced to avoid re-rendering
	 * on every keystroke during active editing.
	 */
	refresh(): void {
		if (this.refreshTimer) {
			window.clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.render();
		}, this.DEBOUNCE_MS);
	}

	private render(): void {
		if (!this.container) return;
		this.container.empty();

		const allTasks = this.provider.getTasksForSidebar();
		const daysAhead = this.provider.getUpcomingDaysAhead();

		this.renderFilterBar(this.container, allTasks);

		const categorized = categorizeTasks(allTasks, new Date(), daysAhead);
		let filtered = applyTimeScopeFilter(categorized, this.filterState.timeScope, daysAhead);
		filtered = applyTagFilter(filtered, this.filterState.selectedTag);

		const hasAnyTasks =
			filtered.overdue.length > 0 ||
			filtered.dueToday.length > 0 ||
			filtered.upcoming.length > 0;

		if (!hasAnyTasks) {
			this.renderEmptyState(this.container);
			return;
		}

		this.renderSection(this.container, 'Overdue', filtered.overdue, true);
		this.renderSection(this.container, 'Due Today', filtered.dueToday, false);
		this.renderSection(this.container, 'Upcoming', filtered.upcoming, false);
	}

	private renderFilterBar(container: HTMLElement, allTasks: VaultTask[]): void {
		const bar = container.createDiv({cls: 'reminder-telegram-sidebar-filter-bar'});

		const timeGroup = bar.createDiv({cls: 'reminder-telegram-sidebar-filter-group'});
		this.renderScopeButton(timeGroup, 'Today', 'today');
		this.renderScopeButton(timeGroup, 'Week', 'week');

		const tags = collectAllTags(allTasks);
		if (tags.length > 0) {
			const tagWrapper = bar.createDiv({cls: 'reminder-telegram-sidebar-tag-wrapper'});
			const select = tagWrapper.createEl('select', {
				cls: 'reminder-telegram-sidebar-tag-select dropdown',
			});
			select.createEl('option', {text: 'All tags', value: ''});
			for (const tag of tags) {
				select.createEl('option', {text: tag, value: tag});
			}
			select.value = this.filterState.selectedTag ?? '';
			select.addEventListener('change', () => {
				this.filterState.selectedTag = select.value || null;
				this.render();
			});
		}

		// Clear filters button (only shown when a filter is active)
		if (this.filterState.timeScope !== 'none' || this.filterState.selectedTag) {
			const clearBtn = bar.createEl('button', {
				cls: 'reminder-telegram-sidebar-clear-btn',
				text: 'Clear',
			});
			clearBtn.addEventListener('click', () => {
				this.filterState = {timeScope: 'none', selectedTag: null};
				this.render();
			});
		}
	}

	private renderScopeButton(container: HTMLElement, label: string, scope: TimeScopeFilter): void {
		const active = this.filterState.timeScope === scope;
		const btn = container.createEl('button', {
			cls: `reminder-telegram-sidebar-scope-btn${active ? ' is-active' : ''}`,
			text: label,
		});
		btn.addEventListener('click', () => {
			// Toggle: if already active, reset to 'none'
			this.filterState.timeScope = active ? 'none' : scope;
			this.render();
		});
	}

	private renderSection(
		container: HTMLElement,
		title: string,
		tasks: VaultTask[],
		isOverdue: boolean
	): void {
		if (tasks.length === 0) return;

		const section = container.createDiv({
			cls: `reminder-telegram-sidebar-section${isOverdue ? ' is-overdue' : ''}`,
		});
		const header = section.createDiv({cls: 'reminder-telegram-sidebar-section-header'});
		header.createSpan({cls: 'reminder-telegram-sidebar-section-title', text: title});
		header.createSpan({
			cls: 'reminder-telegram-sidebar-section-count',
			text: String(tasks.length),
		});

		const list = section.createDiv({cls: 'reminder-telegram-sidebar-task-list'});
		for (const task of tasks) {
			this.renderTaskRow(list, task, isOverdue);
		}
	}

	private renderTaskRow(container: HTMLElement, task: VaultTask, isOverdue: boolean): void {
		const row = container.createDiv({
			cls: `reminder-telegram-sidebar-task-row${isOverdue ? ' is-overdue' : ''}`,
		});

		const main = row.createDiv({cls: 'reminder-telegram-sidebar-task-main'});
		main.createSpan({cls: 'reminder-telegram-sidebar-task-text', text: task.text || '(no text)'});

		const meta = row.createDiv({cls: 'reminder-telegram-sidebar-task-meta'});
		meta.createSpan({cls: 'reminder-telegram-sidebar-task-file', text: task.fileName});

		if (task.deadline) {
			const relative = formatRelativeDate(task.deadline, new Date());
			meta.createSpan({cls: 'reminder-telegram-sidebar-task-date', text: relative});
		}

		row.addEventListener('click', () => {
			void this.provider.openTask(task);
		});
	}

	private renderEmptyState(container: HTMLElement): void {
		const empty = container.createDiv({cls: 'reminder-telegram-sidebar-empty'});
		empty.createSpan({
			cls: 'reminder-telegram-sidebar-empty-text',
			text: 'No tasks match the current filters.',
		});
	}
}
