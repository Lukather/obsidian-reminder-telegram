/**
 * Telegram API client for sending notifications
 */

const TELEGRAM_API_URL = 'https://api.telegram.org';

export interface TelegramSendResult {
	success: boolean;
	message?: string;
	error?: string;
}

export interface TelegramError {
	ok: boolean;
	description: string;
	error_code: number;
}

/**
 * Sends a message via Telegram Bot API
 * @param botToken - Telegram bot token from @BotFather
 * @param chatId - Chat ID to send the message to
 * @param text - Message text to send
 * @param parseMode - Optional parse mode (markdown, html, etc.)
 * @returns Promise with result of the operation
 */
export async function sendTelegramMessage(
	botToken: string,
	chatId: string,
	text: string,
	parseMode: 'Markdown' | 'HTML' | null = null
): Promise<TelegramSendResult> {
	try {
		// Validate inputs
		if (!botToken || botToken.trim() === '') {
			return { success: false, error: 'Bot token is required' };
		}
		if (!chatId || chatId.trim() === '') {
			return { success: false, error: 'Chat ID is required' };
		}
		if (!text || text.trim() === '') {
			return { success: false, error: 'Message text is required' };
		}

		// Build URL
		const url = `${TELEGRAM_API_URL}/bot${botToken}/sendMessage`;

		// Build request body
		const body: Record<string, string> = {
			chat_id: chatId,
			text: text
		};
		if (parseMode) {
			body.parse_mode = parseMode;
		}

		// Send request
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body)
		});

		// Check if request failed
		if (!response.ok) {
			const error: TelegramError = await response.json();
			return {
				success: false,
				error: error.description || `HTTP ${response.status}`
			};
		}

		const data = await response.json();
		
		if (!data.ok) {
			return {
				success: false,
				error: data.description || 'Unknown error'
			};
		}

		return { success: true, message: 'Message sent successfully' };
	} catch (error) {
		// Network errors or other exceptions
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return { success: false, error: errorMessage };
	}
}

/**
 * Sends a test notification to verify configuration
 * @param botToken - Telegram bot token
 * @param chatId - Chat ID
 * @returns Promise with result
 */
export async function sendTestNotification(
	botToken: string,
	chatId: string
): Promise<TelegramSendResult> {
	return sendTelegramMessage(
		botToken,
		chatId,
		'✅ Reminder Telegram plugin is working!\n\nThis is a test notification from your Obsidian vault.'
	);
}

/**
 * Sends a notification about a due task
 * @param botToken - Telegram bot token
 * @param chatId - Chat ID
 * @param taskName - Name of the task
 * @param fileName - Name of the file containing the task
 * @param deadline - Deadline date
 * @returns Promise with result
 */
export async function sendTaskReminder(
	botToken: string,
	chatId: string,
	taskName: string,
	fileName: string,
	deadline: string
): Promise<TelegramSendResult> {
	const message = `⏰ Task Reminder\n\n📝 Task: ${taskName}\n📁 File: ${fileName}\n📅 Deadline: ${deadline}`;
	
	return sendTelegramMessage(botToken, chatId, message);
}

/**
 * Sends multiple task reminders in a single message
 * @param botToken - Telegram bot token
 * @param chatId - Chat ID
 * @param tasks - Array of tasks with their details
 * @returns Promise with result
 */
export async function sendBulkReminders(
	botToken: string,
	chatId: string,
	tasks: Array<{taskName: string; fileName: string; deadline: string}>
): Promise<TelegramSendResult> {
	if (tasks.length === 0) {
		return { success: false, error: 'No tasks to send' };
	}

	const taskList = tasks.map(t => `• ${t.taskName} (${t.deadline}) - ${t.fileName}`).join('\n');
	const message = `⏰ You have ${tasks.length} task(s) due:\n\n${taskList}`;
	
	return sendTelegramMessage(botToken, chatId, message);
}
