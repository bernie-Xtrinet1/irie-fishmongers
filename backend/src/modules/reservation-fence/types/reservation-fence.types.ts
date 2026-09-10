import { ReservationEngineMode } from '@prisma/client';
import type { MutationRejection } from './reservation-mutation.types';

export const FENCE_PHASES = ['OPEN', 'DRAINING', 'FROZEN', 'RETIRED'] as const;
export type FencePhase = (typeof FENCE_PHASES)[number];
export const FENCE_PROTOCOL = 1;
// Int32 counters are exact in PostgreSQL, JavaScript and Redis Lua. Exhaustion
// is an explicit failure, never wraparound or an implicit new execution era.
export const MAX_FENCE_COUNTER = 2147483647;
export interface FenceTuple {
  incarnation: string;
  epoch: number;
  revision: number;
  phase: FencePhase;
  protocol: number;
  transitionId: string;
}
export type FenceFailure =
  | MutationRejection
  | 'STALE_REVISION' | 'WRONG_INCARNATION' | 'ILLEGAL_PHASE_TRANSITION'
  | 'PREDECESSOR_MISMATCH' | 'PROTOCOL_MISMATCH' | 'MISSING_CONTROL'
  | 'MALFORMED_CONTROL' | 'DURABLE_REDIS_DISAGREEMENT' | 'CAPABILITY_REVOKED'
  | 'EPOCH_MISMATCH' | 'FUTURE_CERTIFICATE_REQUIRED' | 'MODE_BOUNDARY_REQUIRED'
  | 'INFRASTRUCTURE_ACK_REQUIRED' | 'COUNTER_EXHAUSTED' | 'UNKNOWN_CAPABILITY';
export type FenceResult<T = undefined> = { code: 'ACCEPTED'; value: T } | { code: FenceFailure };
export const accepted = <T>(value: T): FenceResult<T> => ({ code: 'ACCEPTED', value });
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isFenceTuple(value: unknown): value is FenceTuple {
  if (!value || typeof value !== 'object') return false;
  const t = value as FenceTuple;
  return UUID_PATTERN.test(t.incarnation ?? '') && UUID_PATTERN.test(t.transitionId ?? '') &&
    [t.epoch, t.revision, t.protocol].every(n => Number.isInteger(n) && n > 0 && n <= MAX_FENCE_COUNTER) &&
    FENCE_PHASES.includes(t.phase) && Object.keys(t).length === 6;
}
export function sameTuple(a: FenceTuple, b: FenceTuple): boolean {
  return a.incarnation === b.incarnation && a.epoch === b.epoch && a.revision === b.revision &&
    a.phase === b.phase && a.protocol === b.protocol && a.transitionId === b.transitionId;
}

// Transitional combinations are legal only with an exact durable transition
// explaining them. This function alone never authorizes physical mutation.
export function legalPair(mode: ReservationEngineMode, phase: FencePhase, explained: boolean): boolean {
  if (!Object.values(ReservationEngineMode).includes(mode) || !FENCE_PHASES.includes(phase)) return false;
  if (mode === 'LEGACY') return phase === 'RETIRED' || (phase === 'FROZEN' && explained);
  if (mode === 'DRAINING') return phase === 'DRAINING' || phase === 'FROZEN';
  return phase === 'OPEN' || (explained && (phase === 'DRAINING' || phase === 'FROZEN'));
}
export function phaseTransition(from: FencePhase, to: FencePhase): boolean {
  return ({ OPEN: ['DRAINING', 'FROZEN'], DRAINING: ['FROZEN'],
    FROZEN: ['OPEN', 'DRAINING', 'RETIRED'], RETIRED: [] } as Record<FencePhase, FencePhase[]>)[from].includes(to);
}
