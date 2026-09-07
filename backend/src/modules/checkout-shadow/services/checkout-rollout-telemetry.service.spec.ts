import { Logger } from '@nestjs/common';

import { CheckoutShadowResult } from '../types/checkout-shadow.types';
import { ROLLOUT_EVENTS } from '../types/checkout-rollout-telemetry.types';
import { CheckoutRolloutTelemetryService } from './checkout-rollout-telemetry.service';

describe('Checkout rollout telemetry', () => {
  const result: CheckoutShadowResult = {
    status: 'MATCH',
    reasonCode: 'MATCH',
    engineMode: 'MIRROR',
    comparisons: [],
    checkoutEligibility: 'UNAVAILABLE',
  };
  let log: jest.SpyInstance;
  const service = new CheckoutRolloutTelemetryService();
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('defines exactly the five bounded shared event names; only shadow is emitted', () => {
    expect(ROLLOUT_EVENTS).toEqual([
      'checkout_shadow_comparison',
      'checkout_path_selected',
      'checkout_success',
      'checkout_failure',
      'reservation_conflict',
    ]);
    service.recordShadowComparison(result, 12.9);
    expect(log).toHaveBeenCalledWith('Checkout shadow observation', {
      event: 'checkout_shadow_comparison',
      schemaVersion: 1,
      timestamp: expect.any(String) as string,
      engineMode: 'MIRROR',
      outcome: 'MATCH',
      reasonCode: 'MATCH',
      durationMs: 12,
    });
    const envelope = (log.mock.calls as unknown[][])[0]![1] as { timestamp: string };
    expect(new Date(envelope.timestamp).toISOString()).toBe(envelope.timestamp);
  });
  it('omits correlation/route/policy fields with no established provider and drops all caller extras', () => {
    service.recordShadowComparison(
      {
        ...result,
        apiKey: 'secret',
        email: 'user@example.com',
        phone: '555',
        address: 'private',
        idempotencyKey: 'private',
        requestId: 'jwt',
        operationId: 'secret',
        selectedPath: 'CART_SCOPED',
        cohort: 'client',
        policyRevision: 4,
        comparisons: [{ secret: 'secret' }],
      } as unknown as CheckoutShadowResult,
      1,
    );
    const envelope = (log.mock.calls as unknown[][])[0]![1] as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual([
      'durationMs',
      'engineMode',
      'event',
      'outcome',
      'reasonCode',
      'schemaVersion',
      'timestamp',
    ]);
    expect(JSON.stringify(envelope)).not.toMatch(/secret|private|user@|jwt|555/);
  });
  it.each(['status', 'reasonCode'])('drops unknown %s', (field) => {
    service.recordShadowComparison({ ...result, [field]: 'secret' }, 0);
    expect(log).not.toHaveBeenCalled();
  });
  it('normalizes unknown mode and nonfinite duration without leaking raw input', () => {
    service.recordShadowComparison(
      { ...result, engineMode: 'secret' } as unknown as CheckoutShadowResult,
      NaN,
    );
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ engineMode: null, durationMs: 0 }),
    );
  });
  it.each([-10, 1e20])('bounds duration %s', (duration) => {
    service.recordShadowComparison(result, duration);
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ durationMs: duration < 0 ? 0 : 86400000 }),
    );
  });
  it('swallows log and serialization failures', () => {
    log.mockImplementation(() => {
      throw new Error('sink failure');
    });
    expect(() => service.recordShadowComparison(result, 0)).not.toThrow();
    const poisoned = Object.defineProperty({}, 'status', {
      get() {
        throw new Error('serialization');
      },
    });
    expect(() => service.recordShadowComparison(poisoned as CheckoutShadowResult, 0)).not.toThrow();
  });
});
