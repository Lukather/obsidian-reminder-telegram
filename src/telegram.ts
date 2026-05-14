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

/**
 * Renders a template string with variable substitution
 */
function renderTemplate(template: string, variables: Record<string, string | number>): string {
	try {
		return template.replace(/\{(\w+)\}/g, (match, varName) => {
			const value = variables[varName as keyof typeof variables];
			return value !== undefined ? String(value) : match;
		});
	} catch (error) {
		console.error('Error rendering template:', error);
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
	chatId: string,
	template: string = 'Test notification from reminder Telegram plugin',
	useMarkdown: boolean = false
): Promise<TelegramSendResult> {
	return sendTelegramMessage(
		botToken,
		chatId,
		template,
		useMarkdown ? 'Markdown' : null
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
	deadline: string,
	template: string = 'Task Reminder\n\nTask: {taskName}\nFile: {fileName}\nDeadline: {deadline}',
	useMarkdown: boolean = false,
	filePath: string = '',
	taskId: string = ''
): Promise<TelegramSendResult> {
	const message = renderTemplate(template, {
		taskName,
		fileName,
		deadline,
		filePath,
		taskId
	});
	return sendTelegramMessage(
		botToken,
		chatId,
		message,
		useMarkdown ? 'Markdown' : null
	);
}

/**
 * Sends multiple task reminders in a single message
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

	// Render individual task lines
	const taskLines = tasks.map(task => {
		return renderTemplate(individualTemplate, {
			taskName: task.taskName,
			fileName: task.fileName,
			deadline: task.deadline,
			filePath: task.filePath,
			taskId: task.taskId
		});
	});

	// Render bulk message
	const message = renderTemplate(bulkTemplate, {
		count: tasks.length,
		tasks: taskLines.join('\n')
	});

	return sendTelegramMessage(
		botToken,
		chatId,
		message,
		useMarkdown ? 'Markdown' : null
	);
}
