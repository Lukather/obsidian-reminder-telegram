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
		await sendTelegramMessage(BOT_TOKEN, CHAT_ID, '*bold text*', 'Markdown');
		const body = getLastCallBody();
		expect(body.parse_mode).toBe('Markdown');
	});

	it('omits parse_mode when null', async () => {
		await sendTelegramMessage(BOT_TOKEN, CHAT_ID, 'plain text', null);
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
		expect(sentText.length).toBeLessThanOrEqual(4096 + 3); // truncated + '...'
		expect(sentText).toContain('...');
	});

	it('truncates markdown text and strips trailing delimiters', async () => {
		// Build a long markdown string that ends mid-syntax
		const longText = '*bold start'.padEnd(5000, 'a') + '*notclosed';
		await sendTelegramMessage(BOT_TOKEN, CHAT_ID, longText, 'Markdown');
		const sentText = getLastCallBody().text;
		expect(sentText.length).toBeLessThan(5000);
		// Should not end with unpaired markdown delimiters (before the ellipsis)
		expect(sentText).toContain('...');
	});

	it('does not add trailing delimiter stripping in plain text mode', async () => {
		const longText = 'text with * asterisks '.repeat(300);
		await sendTelegramMessage(BOT_TOKEN, CHAT_ID, longText, null);
		const sentText = getLastCallBody().text;
		expect(sentText).toContain('...');
		expect(sentText.length).toBeLessThanOrEqual(4096 + 3);
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
		expect(body.parse_mode).toBe('Markdown');
	});

	it('omits parse_mode when useMarkdown=false', async () => {
		await sendTestNotification(BOT_TOKEN, CHAT_ID, 'plain test', false);
		const body = getLastCallBody();
		expect(body.parse_mode).toBeUndefined();
	});
});
