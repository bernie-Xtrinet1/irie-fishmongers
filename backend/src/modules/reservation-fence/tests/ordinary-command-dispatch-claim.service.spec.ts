import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('inactive first-dispatch claim source boundary', () => {
  const source = readFileSync(resolve(__dirname, '../repositories/ordinary-command-dispatch-claim.repository.ts'), 'utf8');
  it('has no physical, closure, issuance, scheduling or provider dependency', () => {
    expect(source).not.toMatch(/@Injectable|RedisService|OrdinaryCommandPhysicalService|OrdinaryCommandClosureService|setInterval|\.initialize\(|\.execute\(|\.recordDispatch\(|\.promote\(|\.issue\(/);
  });
  it('does not allocate identity or rearm uncertainty', () => {
    expect(source).not.toMatch(/randomUUID|\.create\(|decrement|state:\s*'UNCERTAIN'/);
    expect(source).toContain('attemptCount: 1');
  });
  it('documents the unprovable historical-membership boundary', () => {
    expect(source).toContain('Zero attempts does NOT prove');
    expect(source).toContain('production admission');
  });
});
