/**
 * Unit tests for src/utils.ts
 *
 * Target: 100% coverage (lines, functions, branches, statements)
 */

import { describe, it, expect } from 'vitest';
import {
  maskSensitiveInfo,
  sanitizeErrorMessage,
  getSanitizedSettingsForLogging,
} from './utils';

// ---------------------------------------------------------------------------
// maskSensitiveInfo
// ---------------------------------------------------------------------------

describe('maskSensitiveInfo()', () => {
  it('returns "****" for empty string', () => {
    expect(maskSensitiveInfo('')).toBe('****');
  });

  it('returns "****" for string with length <= 8', () => {
    expect(maskSensitiveInfo('12345678')).toBe('****');
    expect(maskSensitiveInfo('short')).toBe('****');
    expect(maskSensitiveInfo('ab')).toBe('****');
  });

  it('shows first 4 and last 4 chars for a token of typical length', () => {
    // '1234' + '5678' + '90ab' + 'cdef' → last 4 are 'cdef'
    const result = maskSensitiveInfo('1234xxxxxxxxcdef'); // 16 chars
    expect(result).toBe('1234********cdef');
  });

  it('caps middle asterisks at 16 for very long strings', () => {
    const long = 'a'.repeat(4) + 'x'.repeat(50) + 'b'.repeat(4);
    const result = maskSensitiveInfo(long);
    expect(result).toBe('aaaa' + '*'.repeat(16) + 'bbbb');
    // Total length = 4 + 16 + 4 = 24 (not 58)
    expect(result.length).toBe(24);
  });

  it('handles exactly 9 characters', () => {
    // 'abcd' + 'e' + 'fghi' → last 4 are 'fghi'
    const result = maskSensitiveInfo('abcdefghi'); // 9 chars
    expect(result).toBe('abcd*fghi');
  });
});

// ---------------------------------------------------------------------------
// sanitizeErrorMessage
// ---------------------------------------------------------------------------

describe('sanitizeErrorMessage()', () => {
  it('returns message unchanged when no sensitive values supplied', () => {
    const msg = 'Something went wrong';
    expect(sanitizeErrorMessage(msg)).toBe(msg);
  });

  it('masks a single sensitive value in the message', () => {
    // last 4 chars of '1234xxxxxxxxcdef' are 'cdef'
    const msg = 'Error with token 1234xxxxxxxxcdef and more';
    const result = sanitizeErrorMessage(msg, '1234xxxxxxxxcdef');
    expect(result).toBe('Error with token 1234********cdef and more');
    expect(result).not.toContain('1234xxxxxxxxcdef');
  });

  it('masks multiple sensitive values', () => {
    const msg = 'Token: ABCDEFGHIJKL, Chat: 9876543210ABCDEF';
    const result = sanitizeErrorMessage(msg, 'ABCDEFGHIJKL', '9876543210ABCDEF');
    expect(result).toContain('ABCD****');
    expect(result).toContain('9876****');
    expect(result).not.toContain('ABCDEFGHIJKL');
    expect(result).not.toContain('9876543210ABCDEF');
  });

  it('does not mask values shorter than 5 chars', () => {
    const msg = 'Short value: abc';
    const result = sanitizeErrorMessage(msg, 'abc');
    expect(result).toBe('Short value: abc');
  });

  it('escapes special regex characters in sensitive values', () => {
    const msg = 'Error: $100.50 (charge)';
    const result = sanitizeErrorMessage(msg, '$100.50 (charge)');
    expect(result).not.toContain('$100.50 (charge)');
  });

  it('handles overlapping sensitive values without crashing', () => {
    const msg = 'Token: ABCDEFGHIJKL';
    const result = sanitizeErrorMessage(msg, 'ABCDEFGH', 'DEFGHIJKL');
    expect(result).not.toContain('ABCDEFGHIJKL');
  });

  it('returns original message if sensitiveValues contain empty string', () => {
    const msg = 'Some error';
    expect(sanitizeErrorMessage(msg, '')).toBe(msg);
  });
});

// ---------------------------------------------------------------------------
// getSanitizedSettingsForLogging
// ---------------------------------------------------------------------------

describe('getSanitizedSettingsForLogging()', () => {
  it('masks telegramBotToken and telegramChatId', () => {
    const result = getSanitizedSettingsForLogging({
      telegramBotToken: '1234567890abcdef',
      telegramChatId: '9876543210abcdef',
    });
    expect(result.telegramBotToken).toBe('1234********' + 'cdef'.slice(-4));
    expect(result.telegramChatId).toBe('9876********' + 'cdef'.slice(-4));
  });

  it('returns empty strings when token/chatId are missing', () => {
    const result = getSanitizedSettingsForLogging({});
    expect(result.telegramBotToken).toBe('');
    expect(result.telegramChatId).toBe('');
  });

  it('passes through other settings unchanged', () => {
    const result = getSanitizedSettingsForLogging({
      notificationsEnabled: true,
      checkIntervalMinutes: 30,
      telegramBotToken: 'secret123',
    });
    expect(result.notificationsEnabled).toBe(true);
    expect(result.checkIntervalMinutes).toBe(30);
  });

  it('handles undefined settings gracefully', () => {
    const settings: Record<string, unknown> = {
      telegramBotToken: undefined,
      telegramChatId: undefined,
    };
    const result = getSanitizedSettingsForLogging(settings as Parameters<typeof getSanitizedSettingsForLogging>[0]);
    expect(result.telegramBotToken).toBe('');
    expect(result.telegramChatId).toBe('');
  });
});
