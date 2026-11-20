import { CutoverFreshnessResetAudit } from '@prisma/client';

import { MAX_RESERVATION_LIFETIME_SECONDS, RESERVATION_TTL_SECONDS } from '../../inventory/constants/inventory.constants';
import { UUID_PATTERN } from '../../reservation-fence/types/reservation-fence.types';
import { MAX_LEASE_CEILING_MS, ResourceAuthority } from '../../reservation-fence/types/reservation-mutation.types';
import {
  AuthorizedFreshnessResetInput,
  AuthorizedFreshnessResetResult,
  FreshnessFailureCategory,
} from '../types/cart-scoped-backfill.types';

export interface ParsedReceipt {
  version: number;
  effect: string;
  status: string;
  requestId: string;
  cutoverRunId: string;
  barrierRevision: number;
  tuple: {
    incarnation: string;
    epoch: number;
    revision: number;
    phase: string;
    protocol: number;
    transitionId: string;
  };
  target: ResourceAuthority;
  quantity: number;
  anchorNowMs: number;
  priorCreatedAtMs: number;
  priorLastRenewedAtMs: number | null;
  priorExpiresAtMs: number | null;
  priorAbsoluteExpiresAtMs: number;
  newCreatedAtMs: number;
  newLastRenewedAtMs: number;
  newExpiresAtMs: number;
  newAbsoluteExpiresAtMs: number;
}

const SUSPECT_CODES = new Set([
  'RESERVATION_PRODUCT_SUSPENDED',
  'CAPABILITY_REVOKED',
  'ACCOUNTING_UNDERFLOW',
  'ACCOUNTING_CORRUPTION',
  'MALFORMED_RESOURCE',
  'MALFORMED_RESOURCE_GUARD',
  'PRODUCT_RESTRICTED',
]);

const ESCALATION_CODES = new Set([
  'MISSING_EXECUTION_EVIDENCE',
  'AMBIGUOUS_EXECUTION_EVIDENCE',
  'AUDIT_EVIDENCE_CORRUPTED',
  'UNCERTAIN_EXECUTION_EVIDENCE',
  'CONCURRENT_FRESHNESS_IN_FLIGHT',
  'POST_REDIS_AUDIT_COMPLETION_FAILED',
]);

export function classifyFreshnessFailureCode(code: string | null | undefined): FreshnessFailureCategory {
  if (!code) return 'INFRA';
  if (ESCALATION_CODES.has(code)) return 'ESCALATED';
  if (SUSPECT_CODES.has(code)) return 'SUSPECT';
  if (code === 'CHECKOUT_IN_PROGRESS') return 'CHECKOUT_IN_PROGRESS';
  if (
    code.includes('UNAUTHORIZED') ||
    code.includes('BARRIER') ||
    code.includes('REQUEST_ID') ||
    code.includes('SCOPE') ||
    code === 'STALE_GENERATION'
  ) {
    return 'UNAUTHORIZED';
  }
  return 'FENCE_REJECTED';
}

export function freshnessFailure(
  category: FreshnessFailureCategory,
  code: string,
  detail: string,
  auditId: string | null = null,
  requestId: string | null = null,
): AuthorizedFreshnessResetResult {
  return { ok: false, category, code, detail, auditId, requestId, escalated: category === 'ESCALATED' };
}

export function validateFreshnessResetInput(input: AuthorizedFreshnessResetInput): AuthorizedFreshnessResetResult | null {
  if (
    !input ||
    !UUID_PATTERN.test(input.cutoverRunId ?? '') ||
    !UUID_PATTERN.test(input.operatorId ?? '') ||
    !UUID_PATTERN.test(input.cartId ?? '') ||
    !UUID_PATTERN.test(input.productId ?? '') ||
    !UUID_PATTERN.test(input.customerId ?? '')
  ) {
    return freshnessFailure(
      'UNAUTHORIZED',
      'UNAUTHORIZED_FRESHNESS_SWEEP',
      'Valid cutoverRunId, operatorId, cartId, productId, and customerId UUIDs are required',
    );
  }
  if (input.requestId !== undefined && !UUID_PATTERN.test(input.requestId)) {
    return freshnessFailure('UNAUTHORIZED', 'UNAUTHORIZED_FRESHNESS_SWEEP', 'requestId must be a valid UUID');
  }
  if (
    !Number.isSafeInteger(input.barrierRevision) ||
    input.barrierRevision <= 0 ||
    !Number.isSafeInteger(input.quantity) ||
    input.quantity <= 0 ||
    input.quantity > 2147483647
  ) {
    return freshnessFailure('UNAUTHORIZED', 'UNAUTHORIZED_FRESHNESS_SWEEP', 'barrierRevision and quantity must be positive safe integers');
  }
  if (
    input.expectedGeneration !== undefined &&
    (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0 || input.expectedGeneration > 2147483647)
  ) {
    return freshnessFailure('UNAUTHORIZED', 'STALE_GENERATION', 'expectedGeneration must be a non-negative integer');
  }
  const reason = (input.reason ?? 'CUTOVER_FRESHNESS_SWEEP').trim();
  if (reason.length < 1 || reason.length > 128) {
    return freshnessFailure('UNAUTHORIZED', 'UNAUTHORIZED_FRESHNESS_SWEEP', 'reason length must be between 1 and 128 characters');
  }
  if (input.nowMs !== undefined && (!Number.isSafeInteger(input.nowMs) || input.nowMs <= 0 || input.nowMs > MAX_LEASE_CEILING_MS)) {
    return freshnessFailure('UNAUTHORIZED', 'UNAUTHORIZED_FRESHNESS_SWEEP', 'nowMs anchor out of valid range');
  }
  return null;
}

function validBoundedMs(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= MAX_LEASE_CEILING_MS;
}

export function parseVerifiedFreshnessReceipt(rawReceipt: string, row: CutoverFreshnessResetAudit): ParsedReceipt | null {
  try {
    const p = JSON.parse(rawReceipt) as Partial<ParsedReceipt>;
    if (!p || p.version !== 1 || p.effect !== 'FRESHNESS_SWEEP' || p.status !== 'APPLIED') return null;
    if (p.requestId !== row.requestId || p.cutoverRunId !== row.cutoverRunId || p.barrierRevision !== row.barrierRevision) return null;
    if (p.quantity !== row.quantity || p.anchorNowMs !== Number(row.anchorNowMs)) return null;
    if (
      !p.tuple ||
      p.tuple.incarnation !== row.incarnation ||
      p.tuple.epoch !== row.fenceEpoch ||
      p.tuple.revision !== row.fenceRevision ||
      p.tuple.transitionId !== row.fenceTransitionId ||
      p.tuple.phase !== 'OPEN' ||
      p.tuple.protocol !== 1
    ) {
      return null;
    }
    if (
      !p.target ||
      p.target.markerId !== row.markerId ||
      p.target.generation !== row.generation ||
      p.target.cartId !== row.cartId ||
      p.target.productId !== row.productId ||
      p.target.customerId !== row.customerId ||
      p.target.holdInstanceId !== row.holdInstanceId
    ) {
      return null;
    }
    if (
      !validBoundedMs(p.priorCreatedAtMs) ||
      !validBoundedMs(p.priorAbsoluteExpiresAtMs) ||
      !validBoundedMs(p.newCreatedAtMs) ||
      !validBoundedMs(p.newLastRenewedAtMs) ||
      !validBoundedMs(p.newExpiresAtMs) ||
      !validBoundedMs(p.newAbsoluteExpiresAtMs)
    ) {
      return null;
    }
    const anchor = p.anchorNowMs;
    if (
      p.newCreatedAtMs !== anchor ||
      p.newLastRenewedAtMs !== anchor ||
      p.newExpiresAtMs <= anchor ||
      p.newExpiresAtMs > anchor + RESERVATION_TTL_SECONDS * 1000 ||
      p.newAbsoluteExpiresAtMs <= anchor ||
      p.newAbsoluteExpiresAtMs > anchor + MAX_RESERVATION_LIFETIME_SECONDS * 1000 ||
      p.newExpiresAtMs > p.newAbsoluteExpiresAtMs ||
      p.priorAbsoluteExpiresAtMs < p.priorCreatedAtMs
    ) {
      return null;
    }
    if (p.priorExpiresAtMs !== null && (!validBoundedMs(p.priorExpiresAtMs) || p.priorExpiresAtMs > p.priorAbsoluteExpiresAtMs)) {
      return null;
    }
    if (
      p.priorLastRenewedAtMs !== null &&
      (!validBoundedMs(p.priorLastRenewedAtMs) || p.priorLastRenewedAtMs < p.priorCreatedAtMs || p.priorLastRenewedAtMs > p.priorAbsoluteExpiresAtMs)
    ) {
      return null;
    }
    return p as ParsedReceipt;
  } catch {
    return null;
  }
}
