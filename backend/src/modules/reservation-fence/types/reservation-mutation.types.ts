import { FenceTuple } from './reservation-fence.types';

export const MUTATION_EFFECTS = [
  'RESERVE', 'RENEW', 'REDUCTION_RECREATE', 'RELEASE', 'CHECKOUT_MARK',
  'CHECKOUT_REVERT_RESTORE_ACTIVE', 'CHECKOUT_REVERT_DELETE_ONLY', 'CHECKOUT_FINALIZE',
  'CHECKOUT_LEASE_EXTEND', 'RECONCILE_POSITIVE', 'RECONCILE_NONINCREASING',
  'MALFORMED_SUSPECT', 'CART_SYNC_RECOVERY', 'COMPENSATION', 'BACKFILL',
  'ORPHAN_CLEANUP', 'FRESHNESS_SWEEP', 'TERMINAL_CLEANUP', 'EXPIRED_ACTIVE_RELEASE',
] as const;
export type MutationEffect = typeof MUTATION_EFFECTS[number];
export type AuthorityFamily = 'PRE_CHECKOUT_CART' | 'CHECKOUT_EXECUTION_OR_SETTLEMENT' | 'ADMIN_OR_RECOVERY';
export type IssuerPurpose = 'CART_CONVERGENCE' | 'CHECKOUT_EXECUTION' | 'CHECKOUT_SETTLEMENT' | 'RESOURCE_REPAIR';
export type ExecutionGateState = 'ENABLED' | 'CLOSED' | 'REVOKED';
export const MAX_PERMIT_RESOURCES = 100;
export const MAX_PERMIT_TTL_MS = 5000;
// Thirteen decimal digits stay exact through Redis cjson's number encoding.
export const MAX_LEASE_CEILING_MS = 9999999999999;

// UUID identities only: never operationKey, retry keys, payloads or credentials.
export interface ResourceAuthority {
  customerId: string;
  cartId: string;
  productId: string;
  markerId: string;
  generation: number;
  holdInstanceId: string;
}
export interface ExecutionAuthority {
  operationId: string;
  attemptId: string;
  gateId: string;
}
export type MutationAuthorizationPhase = 'OPEN' | 'DRAINING';
export const DRAINING_MUTATION_EFFECTS: readonly MutationEffect[] = [
  'RELEASE', 'CHECKOUT_REVERT_DELETE_ONLY', 'CHECKOUT_FINALIZE',
  'CHECKOUT_LEASE_EXTEND', 'RECONCILE_NONINCREASING', 'MALFORMED_SUSPECT',
];
export type MutationEffectAuthorization =
  | { effect: 'CHECKOUT_LEASE_EXTEND'; constraint: { kind: 'LEASE_CEILING'; ceilingMs: number } }
  | { effect: Exclude<MutationEffect, 'CHECKOUT_LEASE_EXTEND'>; constraint: { kind: 'NONE' } };
export type MutationAuthorization = MutationEffectAuthorization & { authorizationPhase: MutationAuthorizationPhase };

interface MutationPermitIdentity {
  tuple: FenceTuple;
  family: AuthorityFamily;
  purpose: IssuerPurpose;
  resources: ResourceAuthority[];
  execution: ExecutionAuthority | null;
  permitId: string;
  replayId: string;
  expiresAt: number;
}
export type MutationPermit = MutationPermitIdentity & MutationAuthorization;
export const MUTATION_REJECTIONS = [
  'WRONG_INCARNATION', 'EPOCH_MISMATCH', 'STALE_REVISION', 'CAPABILITY_REVOKED',
  'PHASE_DENIED', 'MISSING_CONTROL', 'MALFORMED_CONTROL', 'PROTOCOL_MISMATCH',
  'DURABLE_REDIS_DISAGREEMENT', 'UNKNOWN_CAPABILITY', 'RESOURCE_GENERATION_MISMATCH',
  'MISSING_PERMIT', 'MALFORMED_PERMIT', 'EXPIRED_PERMIT', 'PERMIT_SCOPE_MISMATCH',
  'EFFECT_MISMATCH', 'REPLAY_MISMATCH', 'EXECUTION_GATE_CLOSED',
  'MISSING_RESOURCE_GUARD', 'MALFORMED_RESOURCE_GUARD', 'MISSING_EXECUTION_GATE',
  'MALFORMED_EXECUTION_GATE', 'MISSING_INITIALIZATION_HISTORY',
] as const;
export type MutationRejection = typeof MUTATION_REJECTIONS[number];
export type MutationResult<T> =
  | { code: 'ACCEPTED'; value: T }
  | { code: 'FENCE_REJECTED'; reason: MutationRejection }
  | { code: 'OWNERSHIP_CONFLICT' }
  | { code: 'DOMAIN_FAILURE'; reason: string }
  | { code: 'INFRASTRUCTURE_FAILURE'; outcome: 'UNCERTAIN' };
