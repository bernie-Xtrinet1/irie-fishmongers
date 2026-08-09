import { CompensationOperation, CompensationReasonCode } from '@prisma/client';

// Phase 16A.0-C4.2 (see ADR-007). Additive and unwired - nothing outside
// this unit's own tests calls recordMirrorDivergence yet.
//
// operation/reasonCode are typed against the Prisma enums this module
// already owns, not against checkout-reservation's MirrorFailureReasonCode
// - the two are structurally identical (same string values, same order),
// so a caller holding a MirrorFailureReasonCode value can pass it
// directly without conversion, but mirror-compensation never imports
// checkout-reservation's types to preserve the module boundary.
export interface RecordMirrorDivergenceInput {
  operation: CompensationOperation;
  cartId: string;
  productId: string;
  // Present for RESERVE_MIRROR (reserveForCart's own input); null for
  // RELEASE_MIRROR (releaseForCart never receives customerId) - matches
  // CreateCompensationInput exactly.
  customerId: string | null;
  // Required positive integer when operation is RESERVE_MIRROR (the
  // quantity being attempted at failure time, diagnostic only - recovery
  // never replays it); must be null when operation is RELEASE_MIRROR,
  // which has no desired-quantity concept of its own.
  desiredQuantity: number | null;
  reasonCode: CompensationReasonCode;
  // Raw, unsanitized input - sanitizeErrorMessage is applied internally
  // before persistence. Never stored or logged as given.
  lastError: string | null;
  now: Date;
}

// generation is not exposed here - it remains an internal concurrency
// mechanism (see CompensationRepository). A concurrent third divergence
// could advance it again before any read the service might otherwise
// perform, so no "this operation's generation" value can be reported
// meaningfully - tests that need to assert on generation read the
// persisted row directly rather than through this result.
export type RecordMirrorDivergenceResult =
  | { ok: true; outcome: 'CREATED' | 'GENERATION_ADVANCED'; compensationId: string }
  | { ok: false; code: 'INVALID_INPUT'; field: string; reason: string };
