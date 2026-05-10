# Security Improvements - Credential Masking

## Summary

Implemented credential masking to prevent sensitive Telegram credentials (bot token and chat ID) from being exposed in logs and error messages.

## Changes Made

### 1. New Utility Functions (`src/utils.ts`)
- `maskSensitiveInfo(value: string): string` - Masks sensitive strings showing only first 4 and last 4 characters
- `sanitizeErrorMessage(message: string, ...sensitiveValues: string[]): string` - Removes sensitive values from error messages
- `getSanitizedSettingsForLogging(settings: object): object` - Creates safe versions of settings for debugging

### 2. Updated Error Logging

#### `src/main.ts`
- Added import for `sanitizeErrorMessage` from `./utils`
- Updated `manualCheck()` error logging to mask credentials
- Updated `startPeriodicChecking()` error logging to mask credentials

#### `src/checker.ts`
- Added import for `sanitizeErrorMessage` from `./utils`
- Updated error logging in `checkAndNotify()` to mask credentials
- Updated error logging in `checkDeadlines()` to mask credentials

#### `src/tasks.ts`
- Added import for `sanitizeErrorMessage` from `./utils`
- Updated file reading error logging to use sanitization

## How It Works

1. **Masking Algorithm**: Shows first 4 + last 4 characters, with middle characters replaced by asterisks
   - Example: `1234567890:ABC-DEF1234ghIkl-zyx57W2v1u123ew11` → `1234*************123ew11`
   - Short values (< 8 chars) are replaced with `****`

2. **Error Sanitization**: Removes sensitive credentials from error messages before logging
   - Prevents credentials from appearing in console logs
   - Maintains useful error context while protecting sensitive data

3. **Backward Compatibility**: All changes are additive and don't break existing functionality

## Testing

- ✅ TypeScript compilation passes (`npx tsc --noEmit`)
- ✅ ESLint passes with no errors or warnings
- ✅ Production build completes successfully (`npm run build`)

## Benefits

1. **Security**: Telegram bot tokens and chat IDs are no longer exposed in logs
2. **Compliance**: Better aligns with security best practices for handling credentials
3. **Debugging**: Still provides useful error information without sensitive data
4. **Privacy**: Protects user credentials even if logs are shared for troubleshooting

## Future Enhancements

- Consider adding logging level control (DEBUG vs PRODUCTION modes)
- Could extend to mask other sensitive data if added in future versions
- May add optional obfuscation for additional security layers