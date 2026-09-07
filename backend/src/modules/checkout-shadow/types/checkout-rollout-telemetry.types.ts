import { ReservationEngineMode } from '@prisma/client';
import { CheckoutShadowResult, ShadowReason } from './checkout-shadow.types';

export const ROLLOUT_EVENTS = [
  'checkout_shadow_comparison',
  'checkout_path_selected',
  'checkout_success',
  'checkout_failure',
  'reservation_conflict',
] as const;

// Future integration contracts. G.2a emits only checkout_shadow_comparison.
export interface CheckoutRolloutTelemetryEnvelope {
  event: (typeof ROLLOUT_EVENTS)[number];
  schemaVersion: 1;
  timestamp: string;
  engineMode: ReservationEngineMode | null;
  outcome: CheckoutShadowResult['status'];
  reasonCode: ShadowReason;
  durationMs: number;
}
