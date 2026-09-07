import { Injectable, Logger } from '@nestjs/common';
import { ReservationEngineMode } from '@prisma/client';

import { CheckoutRolloutTelemetryEnvelope } from '../types/checkout-rollout-telemetry.types';
import { CheckoutShadowResult, SHADOW_REASONS } from '../types/checkout-shadow.types';

@Injectable()
export class CheckoutRolloutTelemetryService {
  private readonly logger = new Logger(CheckoutRolloutTelemetryService.name);

  recordShadowComparison(result: CheckoutShadowResult, durationMs: number): void {
    // Explicit allowlist: no result spreading, IDs, exceptions, or caller metadata.
    // There is no established request correlation provider to populate IDs here.
    try {
      if (
        !['MATCH', 'MISMATCH', 'UNAVAILABLE', 'ERROR'].includes(result.status) ||
        !SHADOW_REASONS.includes(result.reasonCode)
      )
        return;
      const envelope: CheckoutRolloutTelemetryEnvelope = {
        event: 'checkout_shadow_comparison',
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        engineMode: Object.values(ReservationEngineMode).includes(
          result.engineMode as ReservationEngineMode,
        )
          ? result.engineMode
          : null,
        outcome: result.status,
        reasonCode: result.reasonCode,
        durationMs: Number.isFinite(durationMs)
          ? Math.max(0, Math.min(86400000, Math.floor(durationMs)))
          : 0,
      };
      this.logger.log('Checkout shadow observation', envelope);
    } catch {
      // Diagnostics must not propagate logger/serialization failures.
    }
  }
}
