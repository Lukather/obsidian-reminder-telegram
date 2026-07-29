/**
 * Telegram API client for sending notifications
 */
import {requestUrl} from 'obsidian';

import {logInfo, logWarn, logError} from './utils';

const TELEGRAM_API_URL = 'https://api.telegram.org';

/** The 18 characters that Telegram's MarkdownV2 parser treats as special
 *  outside of entities and therefore requires to be escaped with a leading
 *  backslash. See https://core.telegram.org/bots/api#markdownv2-style */
const MARKDOWN_V2_SPECIAL_CHARS_REGEX = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** Trailing unpaired MarkdownV2 delimiters (and bare escape characters) that
 *  must be stripped when truncating, otherwise Telegram returns
 *  "400 Bad Request: can't parse entities". */
const TRAILING_MARKDOWN_V2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]+$/;

/**
 * Escapes the characters that Telegram's MarkdownV2 parser treats as special,
 * so they are rendered as literal text. Apply this to user-controlled content
 * (task name, file name, file path, etc.) — NOT to the template structure,
 * so that intentional markup like `*bold*` in a template is preserved.
 *
 * Without this escaping, any `*`, `_`, `.`, `!`, `#`, `-`, `+`, `(`, `)`,
 * `[`, `]`, `{`, `}`, `>`, `=`, `|`, `~`, or `` ` `` appearing in a task
 * name, file name, or path will cause the entire message to be rejected by
 * Telegram (especially with non-ASCII / Cyrillic text, where the legacy
 * `Markdown` parse mode was even more brittle).
 */
export function escapeMarkdownV2(text: string): string {
	return text.replace(MARKDOWN_V2_SPECIAL_CHARS_REGEX, '\\$&');
}

interface TelegramResponse {
	ok: boolean;
	description?: string;
	error_code?: number;
	result?: unknown;
	parameters?: {
		retry_after?: number;
	};
}

/**
 * Renders a template string with variable substitution. When `escapeValues`
 * is true, each substituted value is escaped for Telegram's MarkdownV2
 * parser — use this when the rendered message will be sent with
 * `useMarkdown: true`. The template structure itself is never escaped, so
 * intentional markup (`*bold*`, `_italic_`, `` `code` ``, links) in the
 * template continues to work.
 */
function renderTemplate(
	template: string,
	variables: Record<string, string | number>,
	options: { escapeValues?: boolean } = {}
): string {
	const escapeValues = options.escapeValues ?? false;
	try {
		return template.replace(/\{(\w+)\}/g, (match, varName) => {
			const value = variables[varName as keyof typeof variables];
			if (value === undefined) return match;
			const str = String(value);
			return escapeValues ? escapeMarkdownV2(str) : str;
		});
	} catch (error) {
		logError('Template rendering failed', error);
		return template; // Return original template on error
	}
}

export interface TelegramSendResult {
	success: boolean;
	message?: string;
	error?: string;
}

/** Fields available for per-task templates (individual and bulk line templates). */
export interface TelegramTaskTemplateFields {
	taskName: string;
	fileName: string;
	deadline: string;
	filePath: string;
	taskId: string;
}

/**
 * Ensures message length doesn't exceed Telegram's 4096 character limit.
 * When truncating in MarkdownV2 mode, strips trailing unpaired delimiters
 * (and bare escape characters) to avoid Telegram "can't parse entities"
 * errors. Uses the Unicode ellipsis (`…`) as the truncation marker because
 * the three ASCII dots would themselves need to be escaped in MarkdownV2.
 */
function ensureMessageLength(text: string, useMarkdown: boolean): string {
	const maxLength = 4096;

	if (text.length <= maxLength) {
		return text;
	}

	// Truncate the message
	let truncated = text.substring(0, maxLength);

	// If using markdown, try to avoid breaking in the middle of markdown syntax
	if (useMarkdown) {
		// Find the last space or newline before the cutoff to avoid breaking words
		const lastSpace = truncated.lastIndexOf(' ');
		const lastNewline = truncated.lastIndexOf('\n');
		const lastBreak = Math.max(lastSpace, lastNewline);

		if (lastBreak > maxLength * 0.8) { // Only adjust if we're not too close to the limit
			truncated = truncated.substring(0, lastBreak);
		}

		// Strip trailing unpaired MarkdownV2 delimiters/escapes that would
		// break parsing. We strip the full set (not just `*`, `_`, `` ` ``,
		// `[`, `]`) because the broader entity syntax in MarkdownV2 makes
		// any of the 18 special characters a parse hazard at the end.
		truncated = truncated.replace(TRAILING_MARKDOWN_V2_SPECIAL, '');
	}

	// Add Unicode ellipsis to indicate truncation. Safe in MarkdownV2
	// because U+2026 is not in the special-character set.
	truncated += '…';

	return truncated;
}

/**
 * Sends a message via Telegram Bot API. When `useMarkdown` is true the
 * message is sent with `parse_mode: MarkdownV2`; the caller is responsible
 * for having already escaped user-controlled content (task names, file
 * names, paths) using {@link escapeMarkdownV2}. The template-level markup
 * (e.g. `*bold*`, `_italic_`, `` `code` ``, `[text](url)`) is preserved as
 * written by the user.
 */
export async function sendTelegramMessage(
	botToken: string,
	chatId: string,
	text: string,
	useMarkdown: boolean = false
): Promise<TelegramSendResult> {
	try {
		if (!botToken || botToken.trim() === '') {
			return { success: false, error: 'Bot token is required' };
		}
		if (!chatId || chatId.trim() === '') {
			return { success: false, error: 'Chat ID is required' };
		}
		if (!text || text.trim() === '') {
			return { success: false, error: 'Message text is required' };
		}

		const url = `${TELEGRAM_API_URL}/bot${botToken}/sendMessage`;

		// Ensure message length doesn't exceed Telegram's limit
		const safeText = ensureMessageLength(text, useMarkdown);

		const requestBody: Record<string, string> = {
			chat_id: chatId,
			text: safeText
		};
		if (useMarkdown) {
			requestBody.parse_mode = 'MarkdownV2';
		}

		const response = await requestUrl({
			url,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(requestBody)
		});

		let data: TelegramResponse;
		try {
			data = JSON.parse(response.text) as TelegramResponse;
		} catch {
			return {
				success: false,
				error: 'Failed to parse Telegram response'
			};
		}

		if (!data.ok) {
			// Retry on rate limit (429) — Telegram returns retry_after in seconds
			if (data.error_code === 429 && data.parameters?.retry_after && data.parameters.retry_after > 0) {
				logWarn(`Rate-limited by Telegram, retrying in ${data.parameters.retry_after}s`);
				await new Promise(resolve => window.setTimeout(resolve, data.parameters!.retry_after! * 1000));
				const retryResponse = await requestUrl({
					url,
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(requestBody)
				});
				let retryData: TelegramResponse;
				try {
					retryData = JSON.parse(retryResponse.text) as TelegramResponse;
				} catch {
					return { success: false, error: 'Failed to parse Telegram retry response' };
				}
				if (!retryData.ok) {
					logError(`Send failed after rate-limit retry: ${retryData.description ?? `code ${retryData.error_code}`}`);
					return { success: false, error: retryData.description || `Error code: ${retryData.error_code}` };
				}
				logInfo(`Message sent after rate-limit retry (${safeText.length} chars${useMarkdown ? ', MarkdownV2' : ''})`);
				return { success: true, message: 'Message sent successfully (after rate limit retry)' };
			}
			logError(`Telegram send failed: ${data.description ?? `code ${data.error_code}`}`);
			return {
				success: false,
				error: data.description || `Error code: ${data.error_code}`
			};
		}

		logInfo(`Message sent (${safeText.length} chars${useMarkdown ? ', MarkdownV2' : ''})`);
		return { success: true, message: 'Message sent successfully' };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		logError(`Telegram send threw: ${errorMessage}`, error);
		return { success: false, error: errorMessage };
	}
}

/**
 * Sends a test notification to verify configuration. The test template has
 * no variables, so its content is sent as-is — users typing characters that
 * are special in MarkdownV2 (`*`, `_`, `.`, `!`, `#`, etc.) are responsible
 * for escaping them themselves if they want literal output.
 */
export async function sendTestNotification(
	botToken: string,
	chatId: string,
	template: string = 'Test notification from reminder Telegram plugin',
	useMarkdown: boolean = false
): Promise<TelegramSendResult> {
	return sendTelegramMessage(botToken, chatId, template, useMarkdown);
}

/**
 * Sends a notification about a due task. Variable values are escaped for
 * MarkdownV2 when `useMarkdown` is true, so `*`, `_`, `.`, etc. in a task
 * name or file name do not break the message. The template structure
 * (including intentional `*bold*` markup) is left untouched.
 */
export async function sendTaskReminder(
	botToken: string,
	chatId: string,
	taskName: string,
	fileName: string,
	deadline: string,
	template: string = 'Task Reminder\n\nTask: {taskName}\nFile: {fileName}\nDeadline: {deadline}',
	useMarkdown: boolean = false,
	filePath: string = '',
	taskId: string = ''
): Promise<TelegramSendResult> {
	const message = renderTemplate(
		template,
		{taskName, fileName, deadline, filePath, taskId},
		{escapeValues: useMarkdown}
	);
	return sendTelegramMessage(botToken, chatId, message, useMarkdown);
}

/**
 * Sends multiple task reminders in a single message. Each task line is
 * rendered with the `individualTemplate` (with values escaped when
 * `useMarkdown` is true), then those escaped lines are joined and
 * substituted into `bulkTemplate`. The bulk template is rendered WITHOUT
 * re-escaping the `tasks` value — that would double-escape the lines and
 * the intentional markup in the bulk template would be lost.
 */
export async function sendBulkReminders(
	botToken: string,
	chatId: string,
	tasks: TelegramTaskTemplateFields[],
	bulkTemplate: string = 'You have {count} task(s) due:\n\n{tasks}',
	individualTemplate: string = 'Task: {taskName} ({deadline}) - {fileName}',
	useMarkdown: boolean = false
): Promise<TelegramSendResult> {
	if (tasks.length === 0) {
		return { success: false, error: 'No tasks to send' };
	}

	// Render individual task lines — values are escaped here so the joined
	// output is safe to drop into the bulk template as-is.
	const taskLines = tasks.map(task => {
		return renderTemplate(
			individualTemplate,
			{
				taskName: task.taskName,
				fileName: task.fileName,
				deadline: task.deadline,
				filePath: task.filePath,
				taskId: task.taskId
			},
			{escapeValues: useMarkdown}
		);
	});

	// Render bulk message. `count` is a non-negative integer (safe in
	// MarkdownV2), `tasks` is already escaped via the per-line rendering
	// above, so we deliberately do NOT escape again on this pass.
	const message = renderTemplate(bulkTemplate, {
		count: tasks.length,
		tasks: taskLines.join('\n')
	});

	return sendTelegramMessage(botToken, chatId, message, useMarkdown);
}
