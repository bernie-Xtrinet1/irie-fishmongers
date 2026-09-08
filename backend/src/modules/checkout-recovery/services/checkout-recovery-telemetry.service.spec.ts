import { Logger } from '@nestjs/common';
import { CheckoutRecoveryTelemetryService } from './checkout-recovery-telemetry.service';

describe('Checkout recovery bounded telemetry', () => {
  afterEach(() => jest.restoreAllMocks());
  it('emits only the bounded envelope and clamps durations', () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    new CheckoutRecoveryTelemetryService().record(
      'checkout_pending_recovered',
      'CLEANED',
      'CART_SCOPED',
      Infinity,
    );
    expect(log).toHaveBeenCalledWith('Checkout recovery', {
      event: 'checkout_pending_recovered',
      schemaVersion: 1,
      timestamp: expect.any(String) as string,
      reasonCode: 'CLEANED',
      outcome: 'SUCCEEDED',
      selectedPath: 'CART_SCOPED',
      durationMs: 0,
    });
  });
  it('logger failure cannot interrupt recovery', () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {
      throw new Error('private sink failure');
    });
    expect(() =>
      new CheckoutRecoveryTelemetryService().record('checkout_recovery_failed', 'ATTEMPT_FAILURE'),
    ).not.toThrow();
  });
});
