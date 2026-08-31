/**
 * Unit tests for src/settings.ts
 *
 * Covers Issue #89 — At-time settings:
 *   - atTimeNotificationsEnabled
 *   - leadTimeMinutes
 *   - atTimeCatchUpWindowMinutes
 *   - strictTimeMode
 *
 * Targets the pure validator helpers, the DEFAULT_SETTINGS shape, the
 * SettingTab rendering, and the save+load round-trip.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	DEFAULT_SETTINGS,
	ReminderTelegramSettings,
	ReminderTelegramSettingTab,
	validateAtTimeCatchUpWindowMinutes,
	validateAtTimeNotificationsEnabled,
	validateKanbanSyntaxEnabled,
	validateLeadTimeMinutes,
	validateRecurringTasksEnabled,
	validateReminderSyntaxEnabled,
	validateStrictTimeMode,
} from './settings';
import { _getSettingSnapshots, _resetSettingInstances } from '../__mocks__/obsidian';

// ---------------------------------------------------------------------------
// DEFAULT_SETTINGS shape — Acceptance criterion #1
// ---------------------------------------------------------------------------

describe('DEFAULT_SETTINGS — at-time keys (issue #89)', () => {
	it('exposes atTimeNotificationsEnabled = true', () => {
		expect(DEFAULT_SETTINGS.atTimeNotificationsEnabled).toBe(true);
	});

	it('exposes leadTimeMinutes = 0', () => {
		expect(DEFAULT_SETTINGS.leadTimeMinutes).toBe(0);
	});

	it('exposes atTimeCatchUpWindowMinutes = 60', () => {
		expect(DEFAULT_SETTINGS.atTimeCatchUpWindowMinutes).toBe(60);
	});

	it('exposes strictTimeMode = false', () => {
		expect(DEFAULT_SETTINGS.strictTimeMode).toBe(false);
	});

	it('exposes reminderSyntaxEnabled = true (issue #96)', () => {
		expect(DEFAULT_SETTINGS.reminderSyntaxEnabled).toBe(true);
	});

	it('exposes kanbanSyntaxEnabled = true (issue #97)', () => {
		expect(DEFAULT_SETTINGS.kanbanSyntaxEnabled).toBe(true);
	});

	it('keeps the new keys typed as required (not optional)', () => {
		// Compile-time guard: every key is non-optional on the interface.
		const probe: ReminderTelegramSettings = DEFAULT_SETTINGS;
		expect(probe.atTimeNotificationsEnabled).toBeDefined();
		expect(probe.leadTimeMinutes).toBeDefined();
		expect(probe.atTimeCatchUpWindowMinutes).toBeDefined();
		expect(probe.strictTimeMode).toBeDefined();
		expect(probe.reminderSyntaxEnabled).toBeDefined();
		expect(probe.kanbanSyntaxEnabled).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// validateLeadTimeMinutes — Acceptance criteria #4, #5, #6, #7
// ---------------------------------------------------------------------------

describe('validateLeadTimeMinutes()', () => {
	it('returns the parsed value for a typical in-range integer', () => {
		expect(validateLeadTimeMinutes('5')).toBe(5);
	});

	it('returns 0 for "0" (sharp)', () => {
		expect(validateLeadTimeMinutes('0')).toBe(0);
	});

	it('returns the value for the upper bound 1440 (24h)', () => {
		expect(validateLeadTimeMinutes('1440')).toBe(1440);
	});

	it('falls back to default for non-numeric text', () => {
		expect(validateLeadTimeMinutes('not a number')).toBe(DEFAULT_SETTINGS.leadTimeMinutes);
		expect(validateLeadTimeMinutes('')).toBe(DEFAULT_SETTINGS.leadTimeMinutes);
		expect(validateLeadTimeMinutes('abc123')).toBe(DEFAULT_SETTINGS.leadTimeMinutes);
	});

	it('falls back to default for negative numbers', () => {
		expect(validateLeadTimeMinutes('-5')).toBe(DEFAULT_SETTINGS.leadTimeMinutes);
		expect(validateLeadTimeMinutes('-1')).toBe(DEFAULT_SETTINGS.leadTimeMinutes);
	});

	it('falls back to default for values > 1440', () => {
		expect(validateLeadTimeMinutes('1441')).toBe(DEFAULT_SETTINGS.leadTimeMinutes);
		expect(validateLeadTimeMinutes('9999')).toBe(DEFAULT_SETTINGS.leadTimeMinutes);
	});

	it('falls back to default for NaN / Infinity / null / undefined', () => {
		expect(validateLeadTimeMinutes(NaN)).toBe(DEFAULT_SETTINGS.leadTimeMinutes);
		expect(validateLeadTimeMinutes(Infinity)).toBe(DEFAULT_SETTINGS.leadTimeMinutes);
		expect(validateLeadTimeMinutes(-Infinity)).toBe(DEFAULT_SETTINGS.leadTimeMinutes);
		expect(validateLeadTimeMinutes(null)).toBe(DEFAULT_SETTINGS.leadTimeMinutes);
		expect(validateLeadTimeMinutes(undefined)).toBe(DEFAULT_SETTINGS.leadTimeMinutes);
	});

	it('accepts a number directly (not just strings)', () => {
		expect(validateLeadTimeMinutes(5)).toBe(5);
		expect(validateLeadTimeMinutes(0)).toBe(0);
		expect(validateLeadTimeMinutes(1440)).toBe(1440);
	});

	it('falls back to default when given a number out of range', () => {
		expect(validateLeadTimeMinutes(-5)).toBe(DEFAULT_SETTINGS.leadTimeMinutes);
		expect(validateLeadTimeMinutes(1441)).toBe(DEFAULT_SETTINGS.leadTimeMinutes);
	});
});

// ---------------------------------------------------------------------------
// validateAtTimeCatchUpWindowMinutes
// ---------------------------------------------------------------------------

describe('validateAtTimeCatchUpWindowMinutes()', () => {
	it('returns the parsed value for a typical in-range integer', () => {
		expect(validateAtTimeCatchUpWindowMinutes('30')).toBe(30);
	});

	it('returns 60 for the default value', () => {
		expect(validateAtTimeCatchUpWindowMinutes('60')).toBe(60);
	});

	it('returns the value for the upper bound 10080 (7 days)', () => {
		expect(validateAtTimeCatchUpWindowMinutes('10080')).toBe(10080);
	});

	it('returns 0 when 0 is entered (disables catch-up)', () => {
		expect(validateAtTimeCatchUpWindowMinutes('0')).toBe(0);
	});

	it('falls back to default for non-numeric text', () => {
		expect(validateAtTimeCatchUpWindowMinutes('foo')).toBe(DEFAULT_SETTINGS.atTimeCatchUpWindowMinutes);
		expect(validateAtTimeCatchUpWindowMinutes('')).toBe(DEFAULT_SETTINGS.atTimeCatchUpWindowMinutes);
	});

	it('falls back to default for negative numbers', () => {
		expect(validateAtTimeCatchUpWindowMinutes('-1')).toBe(DEFAULT_SETTINGS.atTimeCatchUpWindowMinutes);
	});

	it('falls back to default for values > 10080', () => {
		expect(validateAtTimeCatchUpWindowMinutes('10081')).toBe(DEFAULT_SETTINGS.atTimeCatchUpWindowMinutes);
		expect(validateAtTimeCatchUpWindowMinutes('100000')).toBe(DEFAULT_SETTINGS.atTimeCatchUpWindowMinutes);
	});

	it('falls back to default for NaN / null / undefined', () => {
		expect(validateAtTimeCatchUpWindowMinutes(NaN)).toBe(DEFAULT_SETTINGS.atTimeCatchUpWindowMinutes);
		expect(validateAtTimeCatchUpWindowMinutes(null)).toBe(DEFAULT_SETTINGS.atTimeCatchUpWindowMinutes);
		expect(validateAtTimeCatchUpWindowMinutes(undefined)).toBe(DEFAULT_SETTINGS.atTimeCatchUpWindowMinutes);
	});

	it('accepts a number directly (not just strings)', () => {
		expect(validateAtTimeCatchUpWindowMinutes(120)).toBe(120);
		expect(validateAtTimeCatchUpWindowMinutes(0)).toBe(0);
		expect(validateAtTimeCatchUpWindowMinutes(10080)).toBe(10080);
	});

	it('falls back to default when given a number out of range', () => {
		expect(validateAtTimeCatchUpWindowMinutes(-5)).toBe(DEFAULT_SETTINGS.atTimeCatchUpWindowMinutes);
		expect(validateAtTimeCatchUpWindowMinutes(10081)).toBe(DEFAULT_SETTINGS.atTimeCatchUpWindowMinutes);
	});
});

// ---------------------------------------------------------------------------
// validateAtTimeNotificationsEnabled / validateStrictTimeMode
// ---------------------------------------------------------------------------

describe('validateAtTimeNotificationsEnabled()', () => {
	it('passes through true', () => {
		expect(validateAtTimeNotificationsEnabled(true)).toBe(true);
	});

	it('passes through false', () => {
		expect(validateAtTimeNotificationsEnabled(false)).toBe(false);
	});

	it('falls back to default for non-boolean values', () => {
		expect(validateAtTimeNotificationsEnabled('true')).toBe(DEFAULT_SETTINGS.atTimeNotificationsEnabled);
		expect(validateAtTimeNotificationsEnabled(0)).toBe(DEFAULT_SETTINGS.atTimeNotificationsEnabled);
		expect(validateAtTimeNotificationsEnabled(null)).toBe(DEFAULT_SETTINGS.atTimeNotificationsEnabled);
		expect(validateAtTimeNotificationsEnabled(undefined)).toBe(DEFAULT_SETTINGS.atTimeNotificationsEnabled);
	});
});

describe('validateStrictTimeMode()', () => {
	it('passes through true', () => {
		expect(validateStrictTimeMode(true)).toBe(true);
	});

	it('passes through false', () => {
		expect(validateStrictTimeMode(false)).toBe(false);
	});

	it('falls back to default for non-boolean values', () => {
		expect(validateStrictTimeMode('false')).toBe(DEFAULT_SETTINGS.strictTimeMode);
		expect(validateStrictTimeMode(1)).toBe(DEFAULT_SETTINGS.strictTimeMode);
		expect(validateStrictTimeMode(null)).toBe(DEFAULT_SETTINGS.strictTimeMode);
		expect(validateStrictTimeMode(undefined)).toBe(DEFAULT_SETTINGS.strictTimeMode);
	});
});

describe('validateReminderSyntaxEnabled() (issue #96)', () => {
	it('passes through true', () => {
		expect(validateReminderSyntaxEnabled(true)).toBe(true);
	});

	it('passes through false', () => {
		expect(validateReminderSyntaxEnabled(false)).toBe(false);
	});

	it('falls back to default for non-boolean values', () => {
		expect(validateReminderSyntaxEnabled(undefined)).toBe(DEFAULT_SETTINGS.reminderSyntaxEnabled);
		expect(validateReminderSyntaxEnabled('off')).toBe(DEFAULT_SETTINGS.reminderSyntaxEnabled);
		expect(validateReminderSyntaxEnabled(0)).toBe(DEFAULT_SETTINGS.reminderSyntaxEnabled);
	});
});

	describe('validateKanbanSyntaxEnabled() (issue #97)', () => {
	it('passes through true', () => {
		expect(validateKanbanSyntaxEnabled(true)).toBe(true);
	});

	it('passes through false', () => {
		expect(validateKanbanSyntaxEnabled(false)).toBe(false);
	});

	it('falls back to default for non-boolean values', () => {
		expect(validateKanbanSyntaxEnabled(undefined)).toBe(DEFAULT_SETTINGS.kanbanSyntaxEnabled);
		expect(validateKanbanSyntaxEnabled('off')).toBe(DEFAULT_SETTINGS.kanbanSyntaxEnabled);
		expect(validateKanbanSyntaxEnabled(0)).toBe(DEFAULT_SETTINGS.kanbanSyntaxEnabled);
	});
});

describe('validateRecurringTasksEnabled() (issue #98)', () => {
	it('passes through true', () => {
		expect(validateRecurringTasksEnabled(true)).toBe(true);
	});

	it('passes through false', () => {
		expect(validateRecurringTasksEnabled(false)).toBe(false);
	});

	it('falls back to default for non-boolean values', () => {
		expect(validateRecurringTasksEnabled(undefined)).toBe(DEFAULT_SETTINGS.recurringTasksEnabled);
		expect(validateRecurringTasksEnabled('yes')).toBe(DEFAULT_SETTINGS.recurringTasksEnabled);
		expect(validateRecurringTasksEnabled(1)).toBe(DEFAULT_SETTINGS.recurringTasksEnabled);
	});
});

// ---------------------------------------------------------------------------
// SettingTab rendering — Acceptance criteria #2 and #8
// ---------------------------------------------------------------------------

/**
 * Build a minimal plugin stub compatible with the SettingTab constructor.
 * The stub uses the obsidian mock, but provides a settable `loadData()`.
 */
function makePluginStub(initial: Partial<ReminderTelegramSettings> = {}) {
	const stored: Record<string, unknown> = { ...initial };
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, ...initial },
		loadData: vi.fn(async () => structuredClone(stored)),
		saveData: vi.fn(async (data: Record<string, unknown>) => {
			Object.assign(stored, data);
		}),
		// Methods the SettingTab or its helpers might call
		manualCheck: vi.fn(),
		startPeriodicChecking: vi.fn(),
		notifySidebarViews: vi.fn(),
	};
	// Minimal App stub: only setting tab opens need to be observable
	const app = {
		setting: { openTabById: vi.fn(), open: vi.fn() },
	};
	return { plugin, app, stored };
}

describe('ReminderTelegramSettingTab — at-time section', () => {
	let plugin: ReturnType<typeof makePluginStub>['plugin'];
	let app: ReturnType<typeof makePluginStub>['app'];
	let tab: ReminderTelegramSettingTab;
	let container: HTMLElement;

	beforeEach(() => {
		_resetSettingInstances();
		const stub = makePluginStub();
		plugin = stub.plugin;
		app = stub.app;
		tab = new ReminderTelegramSettingTab(app as never, plugin as never);
		// The mock PluginSettingTab constructor already wires containerEl with
		// Obsidian-style helpers (empty/createEl/createDiv/createSpan).
		container = tab.containerEl;
		// Deprecated on Obsidian 1.13+ but still the renderer for < 1.13
		// (minAppVersion 1.7.2) — the tab under test implements both paths.
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		tab.display();
	});

	it('renders an "At-time notifications" section heading', () => {
		const text = container.textContent ?? '';
		expect(text).toContain('At-time notifications');
		// The mock records each Setting's metadata; assert the heading setting
		// exists and is marked as a heading.
		const snapshots = _getSettingSnapshots();
		const headingInstance = snapshots.find(s => s.isHeading && s.name === 'At-time notifications');
		expect(headingInstance).toBeDefined();
	});

	it('renders the atTimeNotificationsEnabled toggle', () => {
		// Setting rows include the name; presence of the name + a toggle is enough.
		const text = container.textContent ?? '';
		expect(text).toContain('At-time notifications enabled');
	});

	it('renders the reminderSyntaxEnabled toggle (issue #96)', () => {
		const text = container.textContent ?? '';
		expect(text).toContain('Reminder syntax');
		expect(text).toContain('@2026-07-22 12:30');
	});

	it('renders the kanbanSyntaxEnabled toggle (issue #97)', () => {
		const text = container.textContent ?? '';
		expect(text).toContain('Kanban syntax');
		expect(text).toContain('@2026-07-22 @@14:30');
	});

	it('renders the leadTimeMinutes text input', () => {
		const text = container.textContent ?? '';
		expect(text).toContain('Lead time (minutes)');
	});

	it('renders the atTimeCatchUpWindowMinutes text input', () => {
		const text = container.textContent ?? '';
		expect(text).toContain('Catch-up window (minutes)');
	});

	it('renders the strictTimeMode toggle', () => {
		const text = container.textContent ?? '';
		expect(text).toContain('Strict time mode');
	});

	it('renders the strict-time notice text below the toggle (AC #8)', () => {
		// The notice is always visible; verify it appears in the rendered output
		// (the desc of the strictTimeMode toggle itself does NOT include the
		// phrase, so this asserts on the standalone notice Setting).
		const text = container.textContent ?? '';
		expect(text).toContain('Date-only tasks are unaffected');
		expect(text).toContain('only at-time tasks are gated by this setting');
	});
});

// ---------------------------------------------------------------------------
// Save + load round-trip — Acceptance criterion #3
// ---------------------------------------------------------------------------

describe('save+load round-trip for at-time settings (AC #3)', () => {
	it('persists atTimeNotificationsEnabled = false across reload', async () => {
		const stub = makePluginStub({ atTimeNotificationsEnabled: false });
		await stub.plugin.saveData({ atTimeNotificationsEnabled: false });
		const reloaded = await stub.plugin.loadData();
		// Simulate the loadSettings merge that lives in main.ts
		const merged = { ...DEFAULT_SETTINGS, ...(reloaded as Partial<ReminderTelegramSettings>) };
		expect(merged.atTimeNotificationsEnabled).toBe(false);
	});

	it('persists leadTimeMinutes = 5 across reload', async () => {
		const stub = makePluginStub({ leadTimeMinutes: 5 });
		await stub.plugin.saveData({ leadTimeMinutes: 5 });
		const reloaded = await stub.plugin.loadData();
		const merged = {
			...DEFAULT_SETTINGS,
			...(reloaded as Partial<ReminderTelegramSettings>),
		};
		merged.leadTimeMinutes = validateLeadTimeMinutes(merged.leadTimeMinutes);
		expect(merged.leadTimeMinutes).toBe(5);
	});

	it('fills in defaults for missing at-time keys (migration safety)', () => {
		// Simulate an old payload without the new keys.
		const oldPayload: Partial<ReminderTelegramSettings> = {
			telegramBotToken: 'token',
			notificationsEnabled: true,
		};
		const merged = { ...DEFAULT_SETTINGS, ...oldPayload };
		expect(merged.atTimeNotificationsEnabled).toBe(true);
		expect(merged.leadTimeMinutes).toBe(0);
		expect(merged.atTimeCatchUpWindowMinutes).toBe(60);
		expect(merged.strictTimeMode).toBe(false);
		expect(merged.reminderSyntaxEnabled).toBe(true);
		expect(merged.kanbanSyntaxEnabled).toBe(true);
	});
});
