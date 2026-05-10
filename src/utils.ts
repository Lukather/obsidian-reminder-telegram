/**
 * Utility functions for security and helper operations
 */

/**
 * Masks sensitive information in strings (like Telegram tokens)
 * Shows first 4 and last 4 characters, with middle characters replaced by asterisks
 */
export function maskSensitiveInfo(value: string): string {
    if (!value || value.length <= 8) {
        return '****';
    }
    
    const firstPart = value.substring(0, 4);
    const lastPart = value.substring(value.length - 4);
    const middleLength = Math.max(0, value.length - 8);
    const maskedMiddle = '*'.repeat(Math.min(middleLength, 16)); // Max 16 asterisks for very long strings
    
    return `${firstPart}${maskedMiddle}${lastPart}`;
}

/**
 * Masks sensitive data in error messages and logs
 */
export function sanitizeErrorMessage(message: string, ...sensitiveValues: string[]): string {
    let result = message;
    
    for (const sensitiveValue of sensitiveValues) {
        if (sensitiveValue && sensitiveValue.length > 4) {
            const maskedValue = maskSensitiveInfo(sensitiveValue);
            result = result.replace(new RegExp(escapeRegExp(sensitiveValue), 'g'), maskedValue);
        }
    }
    
    return result;
}

/**
 * Escapes regex special characters for safe use in RegExp
 */
function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Creates a sanitized version of settings for logging/debugging
 */
export function getSanitizedSettingsForLogging(settings: {
    telegramBotToken?: string;
    telegramChatId?: string;
    [key: string]: unknown;
}): Record<string, unknown> {
    return {
        ...settings,
        telegramBotToken: settings.telegramBotToken ? maskSensitiveInfo(settings.telegramBotToken) : '',
        telegramChatId: settings.telegramChatId ? maskSensitiveInfo(settings.telegramChatId) : ''
    };
}