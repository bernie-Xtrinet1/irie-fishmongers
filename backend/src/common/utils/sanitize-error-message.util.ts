// Strips Node/V8 stack-trace frame lines, redacts the most common
// credential/token shapes (JWT-shaped strings, `Bearer` tokens,
// password/secret/token/api-key key-value pairs), trims, and caps the
// result to maxLength. A message that sanitizes down to nothing is
// returned as null rather than an empty string.
//
// Extracted from CheckoutAttemptService.sanitizeFailureMessage (Phase
// 16A.0-A) so later callers (Phase 16A.0-C4's compensation `lastError`)
// never re-derive the same regexes. Behavior is unchanged from the
// original - CheckoutAttemptService now calls this instead of its own
// private copy.
export function sanitizeErrorMessage(message: string | null, maxLength: number): string | null {
  if (message === null) {
    return null;
  }

  const withoutStackLines = message
    .split('\n')
    .filter((line) => !/^\s*at\s/.test(line))
    .join('\n');

  const withoutSecrets = withoutStackLines
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(password|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');

  const trimmed = withoutSecrets.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}
