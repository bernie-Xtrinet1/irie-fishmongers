import { ReservationEngineMode } from '@prisma/client';

export const SHADOW_REASONS = [
  'MATCH',
  'AVAILABILITY_DIFFERS',
  'PRICE_DIFFERS',
  'CART_MISSING',
  'OWNERSHIP_MISMATCH',
  'CART_EMPTY',
  'PRODUCT_MISSING',
  'PRODUCT_INACTIVE',
  'MISSING_REQUIRED_READ_DATA',
  'NO_COMPARABLE_CART_SCOPED_STATE',
  'RESERVATION_SUSPECT',
  'RESERVATION_STATE_INVALID',
  'RESERVATION_EXPIRED',
  'CHECKOUT_PENDING_NOT_COMPARED',
  'PRICE_LOCK_REQUIRED',
  'PRICE_LOCK_INVALID',
  'PRICE_LOCK_EXPIRED',
  'MODE_NOT_ADMITTING',
  'READ_FAILURE',
] as const;
export type ShadowReason = (typeof SHADOW_REASONS)[number];

// Ordinals refer to this observation's persisted cart lines, never client quantities.
export interface ShadowLineComparison {
  line: number;
  requested: number;
  stock: number;
  legacyAvailable: number;
  cartScopedAvailable: number;
  legacyAdmissible: boolean;
  cartScopedAdmissible: boolean;
  priceEqual: boolean;
}

interface ShadowObservation {
  engineMode: ReservationEngineMode | null;
  comparisons: ShadowLineComparison[];
  // MATCH covers only the listed observations, never full checkout eligibility.
  checkoutEligibility: 'UNAVAILABLE';
}
export type CheckoutShadowResult = ShadowObservation &
  (
    | { status: 'MATCH'; reasonCode: 'MATCH' }
    | { status: 'MISMATCH'; reasonCode: 'AVAILABILITY_DIFFERS' | 'PRICE_DIFFERS' }
    | {
        status: 'UNAVAILABLE';
        reasonCode: Exclude<
          ShadowReason,
          'MATCH' | 'AVAILABILITY_DIFFERS' | 'PRICE_DIFFERS' | 'READ_FAILURE'
        >;
      }
    | { status: 'ERROR'; reasonCode: 'READ_FAILURE' }
  );

// Internal server boundary only. Never accept this from a request DTO as authorization.
export interface ShadowReadContext {
  authenticatedCustomerId: string;
  cartId: string;
}
