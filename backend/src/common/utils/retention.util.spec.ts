import { computeRetentionExpiresAt } from './retention.util';

describe('computeRetentionExpiresAt', () => {
  it('adds 7 years to the given date', () => {
    const result = computeRetentionExpiresAt(new Date('2026-01-15T00:00:00.000Z'));
    expect(result.toISOString()).toBe('2033-01-15T00:00:00.000Z');
  });

  it('does not mutate the input date', () => {
    const input = new Date('2026-01-15T00:00:00.000Z');
    computeRetentionExpiresAt(input);
    expect(input.toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });
});
