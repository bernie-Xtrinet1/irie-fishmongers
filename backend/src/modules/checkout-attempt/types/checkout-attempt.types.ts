import { CheckoutAttemptStatus } from '@prisma/client';

// Public result/type contracts for CheckoutAttemptRepository/
// CheckoutAttemptService (Phase 16A.0-A - see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md).
// Additive and unwired: CheckoutAttemptModule is not imported by any
// production module yet.

// Shared across every CheckoutAttemptService public method that validates
// its own arguments before any database call.
export interface CheckoutAttemptInputValidationFailure {
  ok: false;
  code: 'INVALID_INPUT';
  field: string;
  reason: string;
}

// A deliberately narrow projection of the CheckoutAttempt row - never the
// raw Prisma type. failureCode is included (useful for coordinator
// classification, e.g. deciding whether a resumed FAILED attempt is
// retryable), but failureMessage is never included: no customer-safe
// message contract has been approved for it, and it may contain
// diagnostic detail even after sanitization for storage (see
// sanitizeErrorMessage in common/utils/sanitize-error-message.util.ts).
// Callers that need the raw stored failureMessage for internal/operational purposes must read
// it through a dedicated, explicitly-scoped method - none exists yet.
export interface CheckoutAttemptSummary {
  id: string;
  idempotencyKey: string;
  cartId: string;
  customerId: string;
  status: CheckoutAttemptStatus;
  orderId: string | null;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastHeartbeatAt: Date;
}

// createOrResume - see Decision 1: the unique idempotencyKey constraint is
// the concurrency authority (P2002-then-reread), never a timestamp
// heuristic. IDEMPOTENCY_KEY_CONFLICT deliberately carries no detail about
// which field mismatched or what the stored values are - see Decision 1's
// privacy requirement. Structured logs, not this result, may distinguish
// the mismatch type.
export interface CreateOrResumeCheckoutAttemptInput {
  idempotencyKey: string;
  cartId: string;
  customerId: string;
  now: Date;
}

export type CreateOrResumeCheckoutAttemptResult =
  | { ok: true; action: 'CREATED'; attempt: CheckoutAttemptSummary }
  | { ok: true; action: 'RESUMED_PROCESSING'; attempt: CheckoutAttemptSummary }
  | { ok: true; action: 'ALREADY_COMMITTED'; attempt: CheckoutAttemptSummary }
  | { ok: true; action: 'ALREADY_FAILED'; attempt: CheckoutAttemptSummary }
  | { ok: false; code: 'IDEMPOTENCY_KEY_CONFLICT' };

// updateHeartbeat - one conditional update; a zero-match result is
// classified by a same-shape re-read, never inferred structurally.
export type UpdateCheckoutHeartbeatResult =
  | { ok: true }
  | {
      ok: false;
      code: 'NOT_FOUND' | 'OWNERSHIP_MISMATCH' | 'NOT_PROCESSING' | 'HEARTBEAT_NOT_MONOTONIC';
    }
  | CheckoutAttemptInputValidationFailure;

// markCommittedInTransaction - PROCESSING -> COMMITTED only, requires a
// caller-owned Prisma.TransactionClient (see Decision 2 - never defaulted).
export type MarkCheckoutAttemptCommittedResult =
  | { ok: true; alreadyCommitted: boolean }
  | { ok: false; code: 'ORDER_CONFLICT'; existingOrderId: string }
  | { ok: false; code: 'INVALID_TRANSITION' | 'OWNERSHIP_MISMATCH' | 'NOT_FOUND' };

// markFailed - PROCESSING -> FAILED only; first write wins, see Decision 6.
export type MarkCheckoutAttemptFailedResult =
  | { ok: true; alreadyFailed: boolean; detailsMatched: boolean }
  | { ok: false; code: 'INVALID_TRANSITION' | 'OWNERSHIP_MISMATCH' | 'NOT_FOUND' }
  | CheckoutAttemptInputValidationFailure;

// findStalePage - keyset-paginated PROCESSING candidates for the future
// scheduler (Phase F, not built here). No scheduler locking or cron
// behavior is implemented in this unit - this is a pure, stateless query.
export interface StaleCheckoutAttemptCursor {
  lastHeartbeatAt: Date;
  id: string;
}

export interface FindStaleCheckoutAttemptsInput {
  heartbeatBefore: Date;
  cursor: StaleCheckoutAttemptCursor | null;
  limit?: number;
}

// Only the fields a scheduler needs to act - never failureCode/
// failureMessage, keeping the bulk-scan payload lean.
export interface CheckoutAttemptStaleCandidate {
  id: string;
  idempotencyKey: string;
  cartId: string;
  customerId: string;
  lastHeartbeatAt: Date;
}

export interface StaleCheckoutAttemptPage {
  items: CheckoutAttemptStaleCandidate[];
  nextCursor: StaleCheckoutAttemptCursor | null;
}

export type FindStaleCheckoutAttemptsResult =
  | { ok: true; page: StaleCheckoutAttemptPage }
  | CheckoutAttemptInputValidationFailure;
