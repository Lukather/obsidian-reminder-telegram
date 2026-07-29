/**
 * Unit tests for src/telegram.ts
 *
 * Tests renderTemplate (indirectly via sendTaskReminder/sendBulkReminders),
 * ensureMessageLength (indirectly via sendTelegramMessage with long input),
 * sendTelegramMessage error paths, and 429 retry logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestUrl } from 'obsidian';

import {
	sendTelegramMessage,
	sendTaskReminder,
	sendBulkReminders,
	sendTestNotification,
	escapeMarkdownV2,
	type TelegramTaskTemplateFields,
} from './telegram';

const BOT_TOKEN = 'test:bot-token-1234567890abcdef';
const CHAT_ID = '123456789';

function mockResponse(body: Record<string, unknown>): void {
	(requestUrl as ReturnType<typeof vi.fn>).mockResolvedValue({
		text: JSON.stringify(body),
		json: body,
		status: 200,
	});
}

function mockTelegramSuccess(): void {
	mockResponse({ ok: true, result: {} });
}

function mockTelegramError(errorCode: number, description: string, extra?: Record<string, unknown>): void {
	mockResponse({ ok: false, error_code: errorCode, description, ...extra });
}

function mockRequestThrow(error: Error): void {
	(requestUrl as ReturnType<typeof vi.fn>).mockRejectedValue(error);
}

function getLastCallBody(): Record<string, string> {
	const calls = (requestUrl as ReturnType<typeof vi.fn>).mock.calls;
	const lastCall = calls[calls.length - 1];
	const arg = lastCall?.[0] as { body?: string };
	return arg?.body ? JSON.parse(arg.body) : {};
}

function getLastCallUrl(): string {
	const calls = (requestUrl as ReturnType<typeof vi.fn>).mock.calls;
	const lastCall = calls[calls.length - 1];
	const arg = lastCall?.[0] as { url?: string };
	return arg?.url ?? '';
}

// ===========================================================================
// sendTelegramMessage — validation
// ===========================================================================

describe('sendTelegramMessage() — validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockTelegramSuccess();
	});

	it('fails on empty bot token', async () => {
		const result = await sendTelegramMessage('', CHAT_ID, 'hello');
		expect(result.success).toBe(false);
		expect(result.error).toContain('Bot token');
	});

	it('fails on whitespace-only bot token', async () => {
		const result = await sendTelegramMessage('   ', CHAT_ID, 'hello');
		expect(result.success).toBe(false);
		expect(result.error).toContain('Bot token');
	});

	it('fails on empty chat ID', async () => {
		const result = await sendTelegramMessage(BOT_TOKEN, '', 'hello');
		expect(result.success).toBe(false);
		expect(result.error).toContain('Chat ID');
	});

	it('fails on empty message text', async () => {
		const result = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, '');
		expect(result.success).toBe(false);
		expect(result.error).toContain('Message text');
	});

	it('fails on whitespace-only message text', async () => {
		const result = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, '   ');
		expect(result.success).toBe(false);
		expect(result.error).toContain('Message text');
	});
});

// ===========================================================================
// sendTelegramMessage — success
// ===========================================================================

describe('sendTelegramMessage() — success', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockTelegramSuccess();
	});

	it('sends a basic message', async () => {
		const result = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, 'Hello world');
		expect(result.success).toBe(true);
		expect(requestUrl).toHaveBeenCalledTimes(1);
		expect(getLastCallUrl()).toContain('api.telegram.org');
		expect(getLastCallUrl()).toContain('/sendMessage');
	});

	it('includes parse_mode when markdown is enabled', async () => {
		await sendTelegramMessage(BOT_TOKEN, CHAT_ID, '*bold text*', true);
		const body = getLastCallBody();
		expect(body.parse_mode).toBe('MarkdownV2');
	});

	it('omits parse_mode when markdown is disabled', async () => {
		await sendTelegramMessage(BOT_TOKEN, CHAT_ID, 'plain text', false);
		const body = getLastCallBody();
		expect(body.parse_mode).toBeUndefined();
	});

	it('omits parse_mode by default', async () => {
		await sendTelegramMessage(BOT_TOKEN, CHAT_ID, 'plain text');
		const body = getLastCallBody();
		expect(body.parse_mode).toBeUndefined();
	});

	it('includes chat_id and text in request body', async () => {
		await sendTelegramMessage(BOT_TOKEN, CHAT_ID, 'test message');
		const body = getLastCallBody();
		expect(body.chat_id).toBe(CHAT_ID);
		expect(body.text).toBe('test message');
	});
});

// ===========================================================================
// sendTelegramMessage — API errors
// ===========================================================================

describe('sendTelegramMessage() — API errors', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns error on API failure', async () => {
		mockTelegramError(400, 'Chat not found');
		const result = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, 'hello');
		expect(result.success).toBe(false);
		expect(result.error).toBe('Chat not found');
	});

	it('returns error code in description when no description', async () => {
		mockTelegramError(500, '');
		const result = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, 'hello');
		expect(result.success).toBe(false);
		expect(result.error).toContain('500');
	});

	it('handles network/transport errors', async () => {
		mockRequestThrow(new Error('Network timeout'));
		const result = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, 'hello');
		expect(result.success).toBe(false);
		expect(result.error).toBe('Network timeout');
	});

	it('handles non-Error thrown values', async () => {
		mockRequestThrow('string error' as unknown as Error);
		const result = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, 'hello');
		expect(result.success).toBe(false);
		expect(result.error).toBe('Unknown error');
	});

	it('handles unparseable JSON response', async () => {
		(requestUrl as ReturnType<typeof vi.fn>).mockResolvedValue({
			text: 'not json at all',
			json: null,
			status: 200,
		});
		const result = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, 'hello');
		expect(result.success).toBe(false);
		expect(result.error).toContain('Failed to parse');
	});
});

// ===========================================================================
// sendTelegramMessage — 429 rate limit retry
// ===========================================================================

describe('sendTelegramMessage() — 429 retry', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('retries once after retry_after and succeeds', async () => {
		// First call: 429 with retry_after=1
		// Second call: success
		(requestUrl as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				text: JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } }),
				json: { ok: false, error_code: 429 },
				status: 429,
			})
			.mockResolvedValueOnce({
				text: JSON.stringify({ ok: true }),
				json: { ok: true },
				status: 200,
			});

		const promise = sendTelegramMessage(BOT_TOKEN, CHAT_ID, 'hello');
		// Advance past the retry_after delay
		await vi.advanceTimersByTimeAsync(1500);
		const result = await promise;

		expect(result.success).toBe(true);
		expect(result.message).toContain('rate limit retry');
		expect(requestUrl).toHaveBeenCalledTimes(2);
	});

	it('retries and returns error if retry also fails', async () => {
		(requestUrl as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				text: JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } }),
				json: { ok: false, error_code: 429 },
				status: 429,
			})
			.mockResolvedValueOnce({
				text: JSON.stringify({ ok: false, error_code: 400, description: 'Still bad' }),
				json: { ok: false, error_code: 400 },
				status: 400,
			});

		const promise = sendTelegramMessage(BOT_TOKEN, CHAT_ID, 'hello');
		await vi.advanceTimersByTimeAsync(1500);
		const result = await promise;

		expect(result.success).toBe(false);
		expect(result.error).toBe('Still bad');
		expect(requestUrl).toHaveBeenCalledTimes(2);
	});

	it('does not retry when retry_after is missing', async () => {
		mockTelegramError(429, 'Too Many Requests');
		const result = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, 'hello');
		expect(result.success).toBe(false);
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});

	it('does not retry when retry_after is 0', async () => {
		mockTelegramError(429, 'Too Many Requests', { parameters: { retry_after: 0 } });
		const result = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, 'hello');
		expect(result.success).toBe(false);
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});
});

// ===========================================================================
// ensureMessageLength — tested indirectly via sendTelegramMessage
// ===========================================================================

describe('ensureMessageLength() — via sendTelegramMessage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockTelegramSuccess();
	});

	it('passes short messages unchanged', async () => {
		await sendTelegramMessage(BOT_TOKEN, CHAT_ID, 'short message');
		expect(getLastCallBody().text).toBe('short message');
	});

	it('truncates plain text over 4096 chars', async () => {
		const longText = 'a'.repeat(5000);
		await sendTelegramMessage(BOT_TOKEN, CHAT_ID, longText, null);
		const sentText = getLastCallBody().text;
		expect(sentText.length).toBeLessThan(5000);
		expect(sentText.length).toBeLessThanOrEqual(4096 + 1); // 4096 + Unicode ellipsis
		expect(sentText).toMatch(/…$/);
	});

	it('truncates markdown text and strips trailing delimiters', async () => {
		// Build a long markdown string that ends mid-syntax
		const longText = '*bold start'.padEnd(5000, 'a') + '*notclosed';
		await sendTelegramMessage(BOT_TOKEN, CHAT_ID, longText, true);
		const sentText = getLastCallBody().text;
		expect(sentText.length).toBeLessThan(5000);
		// Should not end with unpaired markdown delimiters (before the ellipsis).
		// The Unicode ellipsis U+2026 is used so it can be sent unescaped in MarkdownV2.
		expect(sentText).toMatch(/…$/);
	});

	it('strips a broad set of trailing MarkdownV2 delimiters on truncation', async () => {
		// End with the full set of characters that MarkdownV2 treats as
		// special outside of entities. Each of these at the end of a message
		// would cause "can't parse entities" on Telegram.
		const longText = 'filler '.repeat(700) + '_*[]()~`>#+-=|{}.!';
		await sendTelegramMessage(BOT_TOKEN, CHAT_ID, longText, true);
		const sentText = getLastCallBody().text;
		expect(sentText.length).toBeLessThanOrEqual(4096 + 1); // 4096 + Unicode ellipsis
		expect(sentText).toMatch(/…$/);
		// The character just before the ellipsis must NOT be a special char.
		// `substring(0, lastBreak)` cuts at the last space but excludes it,
		// so the last char is `r` from the trailing "filler" run.
		const lastCharBeforeEllipsis = sentText[sentText.length - 2];
		expect(lastCharBeforeEllipsis).toBe('r');
		expect(lastCharBeforeEllipsis).not.toMatch(/[_*[\]()~`>#+\-=|{}.!\\]/);
	});

	it('does not strip trailing delimiters in plain text mode', async () => {
		// Plain text mode must preserve `*` literally — no MarkdownV2 stripping.
		const longText = 'text with * asterisks '.repeat(300);
		await sendTelegramMessage(BOT_TOKEN, CHAT_ID, longText, false);
		const sentText = getLastCallBody().text;
		expect(sentText).toMatch(/…$/);
		expect(sentText.length).toBeLessThanOrEqual(4096 + 1);
		// The asterisks survive in plain-text mode (no escaping).
		expect(sentText).toContain('*');
	});
});

// ===========================================================================
// renderTemplate — via sendTaskReminder / sendBulkReminders
// ===========================================================================

describe('renderTemplate() — via sendTaskReminder', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockTelegramSuccess();
	});

	it('substitutes all variables', async () => {
		const template = 'Task: {taskName}\nFile: {fileName}\nDue: {deadline}\nPath: {filePath}\nID: {taskId}';
		await sendTaskReminder(BOT_TOKEN, CHAT_ID, 'My Task', 'note.md', '2026-06-11', template, false, 'notes/note.md', 'task-123');
		const body = getLastCallBody();
		expect(body.text).toContain('Task: My Task');
		expect(body.text).toContain('File: note.md');
		expect(body.text).toContain('Due: 2026-06-11');
		expect(body.text).toContain('Path: notes/note.md');
		expect(body.text).toContain('ID: task-123');
	});

	it('leaves unknown variables as literal {varName}', async () => {
		const template = 'Hello {unknownVar} and {taskName}';
		await sendTaskReminder(BOT_TOKEN, CHAT_ID, 'Task', 'f.md', '2026-01-01', template, false);
		const body = getLastCallBody();
		expect(body.text).toContain('{unknownVar}');
		expect(body.text).toContain('Task');
	});

	it('uses default template when none provided', async () => {
		await sendTaskReminder(BOT_TOKEN, CHAT_ID, 'My Task', 'file.md', '2026-06-11');
		const body = getLastCallBody();
		expect(body.text).toContain('Task: My Task');
		expect(body.text).toContain('File: file.md');
		expect(body.text).toContain('Deadline: 2026-06-11');
	});

	it('handles special characters in variable values', async () => {
		const template = '{taskName}';
		await sendTaskReminder(BOT_TOKEN, CHAT_ID, 'Task with $pecial [chars]', 'f.md', '2026-01-01', template, false);
		const body = getLastCallBody();
		expect(body.text).toBe('Task with $pecial [chars]');
	});
});

// ===========================================================================
// sendBulkReminders
// ===========================================================================

describe('sendBulkReminders()', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockTelegramSuccess();
	});

	it('returns error for empty task list', async () => {
		const result = await sendBulkReminders(BOT_TOKEN, CHAT_ID, []);
		expect(result.success).toBe(false);
		expect(result.error).toContain('No tasks');
	});

	it('renders bulk message with count and task lines', async () => {
		const tasks: TelegramTaskTemplateFields[] = [
			{ taskName: 'Task A', fileName: 'a.md', deadline: '2026-06-11', filePath: 'a.md', taskId: 'id-a' },
			{ taskName: 'Task B', fileName: 'b.md', deadline: '2026-06-12', filePath: 'b.md', taskId: 'id-b' },
		];
		await sendBulkReminders(BOT_TOKEN, CHAT_ID, tasks, 'You have {count} tasks:\n{tasks}', '• {taskName} ({deadline})');
		const body = getLastCallBody();
		expect(body.text).toContain('You have 2 tasks:');
		expect(body.text).toContain('• Task A (2026-06-11)');
		expect(body.text).toContain('• Task B (2026-06-12)');
	});

	it('uses default templates when none provided', async () => {
		const tasks: TelegramTaskTemplateFields[] = [
			{ taskName: 'Task', fileName: 'f.md', deadline: '2026-06-11', filePath: 'f.md', taskId: 'id' },
		];
		await sendBulkReminders(BOT_TOKEN, CHAT_ID, tasks);
		const body = getLastCallBody();
		expect(body.text).toContain('1 task(s) due');
		expect(body.text).toContain('Task: Task (2026-06-11) - f.md');
	});

	it('joins task lines with newlines', async () => {
		const tasks: TelegramTaskTemplateFields[] = [
			{ taskName: 'A', fileName: 'a.md', deadline: '2026-01-01', filePath: 'a.md', taskId: '1' },
			{ taskName: 'B', fileName: 'b.md', deadline: '2026-01-02', filePath: 'b.md', taskId: '2' },
		];
		await sendBulkReminders(BOT_TOKEN, CHAT_ID, tasks, '{tasks}', '{taskName}');
		const body = getLastCallBody();
		expect(body.text).toBe('A\nB');
	});
});

// ===========================================================================
// sendTestNotification
// ===========================================================================

describe('sendTestNotification()', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockTelegramSuccess();
	});

	it('sends with default template', async () => {
		const result = await sendTestNotification(BOT_TOKEN, CHAT_ID);
		expect(result.success).toBe(true);
		const body = getLastCallBody();
		expect(body.text).toContain('Test notification');
	});

	it('sends with custom template', async () => {
		await sendTestNotification(BOT_TOKEN, CHAT_ID, 'Custom test message', false);
		const body = getLastCallBody();
		expect(body.text).toBe('Custom test message');
	});

	it('enables markdown when useMarkdown=true', async () => {
		await sendTestNotification(BOT_TOKEN, CHAT_ID, '*bold test*', true);
		const body = getLastCallBody();
		expect(body.parse_mode).toBe('MarkdownV2');
	});

	it('omits parse_mode when useMarkdown=false', async () => {
		await sendTestNotification(BOT_TOKEN, CHAT_ID, 'plain test', false);
		const body = getLastCallBody();
		expect(body.parse_mode).toBeUndefined();
	});
});

// ===========================================================================
// escapeMarkdownV2 — Cyrillic + special characters regression (issue #79)
// ===========================================================================

describe('escapeMarkdownV2()', () => {
	it('escapes the full set of 18 special characters', () => {
		const specials = '_*[]()~`>#+-=|{}.!\\';
		const escaped = escapeMarkdownV2(specials);
		// Each of the 18 special chars is preceded by a backslash.
		expect(escaped).toBe('\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\');
	});

	it('leaves plain text unchanged', () => {
		expect(escapeMarkdownV2('Hello world')).toBe('Hello world');
	});

	it('leaves Cyrillic text unchanged (no special chars)', () => {
		const cyrillic = 'Сделать задачу';
		expect(escapeMarkdownV2(cyrillic)).toBe(cyrillic);
	});

	it('escapes special chars mixed with Cyrillic', () => {
		// This is the exact failure mode from issue #79 — Cyrillic task name
		// containing a `#` (or any of the MarkdownV2 special characters)
		// would cause Telegram to reject the message under legacy `Markdown`.
		expect(escapeMarkdownV2('Сделать #важно!')).toBe('Сделать \\#важно\\!');
	});

	it('escapes dashes in dates', () => {
		// `2024-01-15` — the `-` is special in MarkdownV2
		expect(escapeMarkdownV2('2024-01-15')).toBe('2024\\-01\\-15');
	});

	it('escapes dots in version numbers', () => {
		expect(escapeMarkdownV2('v1.0.0 release')).toBe('v1\\.0\\.0 release');
	});

	it('escapes file path separators and underscores (snake_case)', () => {
		expect(escapeMarkdownV2('folder/sub_file.md')).toBe('folder/sub\\_file\\.md');
	});

	it('escapes parentheses in task names', () => {
		expect(escapeMarkdownV2('Review (urgent)')).toBe('Review \\(urgent\\)');
	});

	it('escapes brackets in file names', () => {
		expect(escapeMarkdownV2('note [draft].md')).toBe('note \\[draft\\]\\.md');
	});

	it('handles an empty string', () => {
		expect(escapeMarkdownV2('')).toBe('');
	});

	it('escapes only the special chars, not surrounding text', () => {
		expect(escapeMarkdownV2('a*b')).toBe('a\\*b');
		expect(escapeMarkdownV2('a+b')).toBe('a\\+b');
		expect(escapeMarkdownV2('a.b')).toBe('a\\.b');
	});
});

// ===========================================================================
// MarkdownV2 escaping integrated with task templates
// ===========================================================================

describe('MarkdownV2 escaping in sendTaskReminder()', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockTelegramSuccess();
	});

	it('escapes special chars in taskName when useMarkdown=true', async () => {
		await sendTaskReminder(
			BOT_TOKEN, CHAT_ID,
			'Fix #urgent bug!', 'note.md', '2024-12-31',
			'Task: {taskName}', true
		);
		const body = getLastCallBody();
		expect(body.parse_mode).toBe('MarkdownV2');
		expect(body.text).toBe('Task: Fix \\#urgent bug\\!');
	});

	it('escapes Cyrillic with special chars when useMarkdown=true (regression for #79)', async () => {
		await sendTaskReminder(
			BOT_TOKEN, CHAT_ID,
			'Сделать задачу #1', 'Журнал.md', '2026-07-29',
			'📌 {taskName}\n📁 {fileName}\n📅 {deadline}', true
		);
		const body = getLastCallBody();
		expect(body.parse_mode).toBe('MarkdownV2');
		// Cyrillic letters pass through; `#` and the `-`s in the date are escaped.
		expect(body.text).toBe('📌 Сделать задачу \\#1\n📁 Журнал\\.md\n📅 2026\\-07\\-29');
	});

	it('does NOT escape template structure — *bold* markup is preserved', async () => {
		await sendTaskReminder(
			BOT_TOKEN, CHAT_ID,
			'My Task', 'note.md', '2024-12-31',
			'*Task:* {taskName}', true
		);
		const body = getLastCallBody();
		// The `*`s around "Task:" are intentional markup, not escaped.
		expect(body.text).toBe('*Task:* My Task');
	});

	it('does not escape when useMarkdown=false', async () => {
		await sendTaskReminder(
			BOT_TOKEN, CHAT_ID,
			'Fix #urgent bug!', 'note.md', '2024-12-31',
			'Task: {taskName}', false
		);
		const body = getLastCallBody();
		expect(body.parse_mode).toBeUndefined();
		expect(body.text).toBe('Task: Fix #urgent bug!');
	});

	it('escapes all variable values (taskName, fileName, filePath, deadline, taskId)', async () => {
		await sendTaskReminder(
			BOT_TOKEN, CHAT_ID,
			'A (B)', 'x.y.md', '2024-01-01',
			'{taskName}|{fileName}|{filePath}|{deadline}|{taskId}',
			true, 'x.y.md', 'id_1'
		);
		const body = getLastCallBody();
		// Data values escaped: `(` `)` `.` `-` `_` all get a `\` prefix.
		// The `|` between fields is template structure, so it stays literal
		// (the user is responsible for keeping template markup well-formed
		// for MarkdownV2 — that's why we don't escape template text).
		expect(body.text).toBe('A \\(B\\)|x\\.y\\.md|x\\.y\\.md|2024\\-01\\-01|id\\_1');
	});
});

describe('MarkdownV2 escaping in sendBulkReminders()', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockTelegramSuccess();
	});

	it('escapes each task line in the bulk message', async () => {
		const tasks: TelegramTaskTemplateFields[] = [
			{ taskName: 'Task #1!', fileName: 'a.md', deadline: '2024-01-01', filePath: 'a.md', taskId: '1' },
			{ taskName: 'Task #2!', fileName: 'b.md', deadline: '2024-01-02', filePath: 'b.md', taskId: '2' },
		];
		await sendBulkReminders(
			BOT_TOKEN, CHAT_ID, tasks,
			'You have {count}:\n{tasks}',
			'• {taskName} ({deadline}) - {fileName}',
			true
		);
		const body = getLastCallBody();
		expect(body.parse_mode).toBe('MarkdownV2');
		// Data values escaped: `#`, `!`, `-` in dates, `.` in filenames.
		// Template structure preserved: ` (`, `)`, ` - ` are literal.
		// `count` is a safe integer, no escaping applied.
		expect(body.text).toBe('You have 2:\n• Task \\#1\\! (2024\\-01\\-01) - a\\.md\n• Task \\#2\\! (2024\\-01\\-02) - b\\.md');
	});

	it('does not double-escape when the bulk template wraps the joined lines', async () => {
		const tasks: TelegramTaskTemplateFields[] = [
			{ taskName: 'A', fileName: 'a.md', deadline: '2024-01-01', filePath: 'a.md', taskId: '1' },
		];
		await sendBulkReminders(
			BOT_TOKEN, CHAT_ID, tasks,
			'*{tasks}*',
			'{taskName}',
			true
		);
		const body = getLastCallBody();
		// The `*`s come from the bulk template (intentional markup);
		// the substituted value is `A` (no special chars) — nothing to escape.
		expect(body.text).toBe('*A*');
	});

	it('renders correctly with Cyrillic content (regression for #79)', async () => {
		const tasks: TelegramTaskTemplateFields[] = [
			{ taskName: 'Сделать задачу', fileName: 'Журнал.md', deadline: '2026-07-29', filePath: 'Журнал.md', taskId: 'id-1' },
			{ taskName: 'Позвонить маме', fileName: 'Личное.md', deadline: '2026-07-30', filePath: 'Личное.md', taskId: 'id-2' },
		];
		await sendBulkReminders(
			BOT_TOKEN, CHAT_ID, tasks,
			'У вас {count} задач:\n\n{tasks}',
			'• {taskName} — {fileName} ({deadline})',
			true
		);
		const body = getLastCallBody();
		expect(body.parse_mode).toBe('MarkdownV2');
		// Cyrillic preserved verbatim; only `.` in filenames and `-` in dates
		// (data values) are escaped. The `(` and `)` around {deadline} are
		// part of the template structure, so they stay literal.
		expect(body.text).toBe('У вас 2 задач:\n\n• Сделать задачу — Журнал\\.md (2026\\-07\\-29)\n• Позвонить маме — Личное\\.md (2026\\-07\\-30)');
	});

	it('does not escape anything when useMarkdown=false', async () => {
		const tasks: TelegramTaskTemplateFields[] = [
			{ taskName: 'Task #1!', fileName: 'a.md', deadline: '2024-01-01', filePath: 'a.md', taskId: '1' },
		];
		await sendBulkReminders(
			BOT_TOKEN, CHAT_ID, tasks,
			'{count}: {tasks}',
			'• {taskName}',
			false
		);
		const body = getLastCallBody();
		expect(body.parse_mode).toBeUndefined();
		expect(body.text).toBe('1: • Task #1!');
	});
});
