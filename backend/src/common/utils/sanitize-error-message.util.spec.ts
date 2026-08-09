import { sanitizeErrorMessage } from './sanitize-error-message.util';

describe('sanitizeErrorMessage', () => {
  it('returns null unchanged', () => {
    expect(sanitizeErrorMessage(null, 500)).toBeNull();
  });

  it('strips Node/V8 stack-trace frame lines', () => {
    const raw = 'Something failed\n    at Object.<anonymous> (/app/index.js:1:1)\n    at Module._compile';
    expect(sanitizeErrorMessage(raw, 500)).toBe('Something failed');
  });

  it('redacts JWT-shaped strings', () => {
    const raw = 'token was eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(sanitizeErrorMessage(raw, 500)).toBe('token was [REDACTED]');
  });

  it('redacts Bearer tokens', () => {
    expect(sanitizeErrorMessage('Authorization: Bearer abc123.def456', 500)).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });

  it('redacts password/secret/token/api-key key-value pairs case-insensitively', () => {
    expect(sanitizeErrorMessage('password=hunter2', 500)).toBe('password=[REDACTED]');
    expect(sanitizeErrorMessage('SECRET: abc123', 500)).toBe('SECRET=[REDACTED]');
    expect(sanitizeErrorMessage('api_key=xyz789', 500)).toBe('api_key=[REDACTED]');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeErrorMessage('  padded message  ', 500)).toBe('padded message');
  });

  it('returns null when sanitization leaves nothing', () => {
    expect(sanitizeErrorMessage('   \n  at only.stack.line  ', 500)).toBeNull();
  });

  it('truncates to maxLength after sanitization, never before', () => {
    const raw = 'x'.repeat(600);
    const result = sanitizeErrorMessage(raw, 500);
    expect(result).toHaveLength(500);
  });

  it('does not truncate a message shorter than maxLength', () => {
    expect(sanitizeErrorMessage('short', 500)).toBe('short');
  });
});
