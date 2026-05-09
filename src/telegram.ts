/**
 * Telegram API client for sending notifications
 */
import {requestUrl} from 'obsidian';

const TELEGRAM_API_URL = 'https://api.telegram.org';

interface TelegramResponse {
	ok: boolean;
	description?: string;
	error_code?: number;
	result?: unknown;
}

export interface TelegramSendResult {
	success: boolean;
	message?: string;
	error?: string;
}

/**
 * Sends a message via Telegram Bot API
 */
export async function sendTelegramMessage(
	botToken: string,
	chatId: string,
	text: string,
	parseMode: 'Markdown' | 'HTML' | null = null
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

		const requestBody: Record<string, string> = {
			chat_id: chatId,
			text: text
		};
		if (parseMode) {
			requestBody.parse_mode = parseMode;
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
			return {
				success: false,
				error: data.description || `Error code: ${data.error_code}`
			};
		}

		return { success: true, message: 'Message sent successfully' };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return { success: false, error: errorMessage };
	}
}

/**
 * Sends a test notification to verify configuration
 */
export async function sendTestNotification(
	botToken: string,
	chatId: string
): Promise<TelegramSendResult> {
	return sendTelegramMessage(
		botToken,
		chatId,
		'Test notification from reminder telegram plugin'
	);
}

/**
 * Sends a notification about a due task
 */
export async function sendTaskReminder(
	botToken: string,
	chatId: string,
	taskName: string,
	fileName: string,
	deadline: string
): Promise<TelegramSendResult> {
	const message = `Task Reminder\n\nTask: ${taskName}\nFile: ${fileName}\nDeadline: ${deadline}`;
	return sendTelegramMessage(botToken, chatId, message);
}

/**
 * Sends multiple task reminders in a single message
 */
export async function sendBulkReminders(
	botToken: string,
	chatId: string,
	tasks: Array<{taskName: string; fileName: string; deadline: string}>
): Promise<TelegramSendResult> {
	if (tasks.length === 0) {
		return { success: false, error: 'No tasks to send' };
	}

	const taskList = tasks.map(t => `Task: ${t.taskName} (${t.deadline}) - ${t.fileName}`).join('\n');
	const message = `You have ${tasks.length} task(s) due:\n\n${taskList}`;
	return sendTelegramMessage(botToken, chatId, message);
}
