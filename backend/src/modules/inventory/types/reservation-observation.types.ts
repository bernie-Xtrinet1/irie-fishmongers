export type ObservationFinding = 'CONSISTENT' | 'MISSING' | 'EXTRA' | 'QUANTITY_MISMATCH' |
  'MEMBERSHIP_UNCERTAIN' | 'INFRASTRUCTURE_UNCERTAIN' | 'RESTRICTION_PREPARED' | 'RESTRICTION_ENFORCED' |
  'RESTRICTION_CLEARING' | 'RESTRICTION_CLEARED' | 'RECOVERY_ACTIVE' | 'RECOVERY_QUARANTINED';

export interface ReservationObservation {
  readonly authority: 'NONE';
  readonly physicalConvergenceProven: false;
  readonly scope: 'OBSERVED_RESOURCES_ONLY';
  readonly membershipCompleteness: 'UNPROVEN';
  findings: ObservationFinding[];
  accounting: { storedTotal: number | null; observedQuantityTotal: number | null; difference: number | null };
  restriction: {
    durableState: 'ABSENT' | 'PREPARED' | 'ENFORCED' | 'CLEARING' | 'CLEARED' | 'UNKNOWN';
    revision: number | null;
    observationDigest: string | null;
    physicalState: 'ABSENT' | 'ALLOW' | 'RESTRICTED' | 'CLEARANCE_STAGED' | 'UNKNOWN';
    installation: 'MATCHES_OBSERVED_TUPLE' | 'NOT_PROVEN';
    crossStoreConsistency: 'OBSERVED_MATCH' | 'UNPROVEN';
  };
}

export const OBSERVATION_LIMIT = 100;

interface RedisObservation {
  findings: ObservationFinding[];
  accounting: ReservationObservation['accounting'];
  control: string | null;
  fence: string | null;
}

export function parseRedisObservation(raw: unknown): RedisObservation {
  if (typeof raw !== 'string') throw new Error('Invalid observation');
  const value: unknown = JSON.parse(raw);
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const number = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isSafeInteger(v));
  const finding = (v: unknown): v is ObservationFinding => typeof v === 'string' &&
    ['CONSISTENT', 'MISSING', 'EXTRA', 'QUANTITY_MISMATCH', 'MEMBERSHIP_UNCERTAIN'].includes(v);
  if (!object(value) || !Array.isArray(value.findings) || value.findings.length === 0 ||
    !value.findings.every(finding) || !object(value.accounting) ||
    !(value.control === null || typeof value.control === 'string') || !(value.fence === null || typeof value.fence === 'string'))
    throw new Error('Invalid observation');
  const { storedTotal, observedQuantityTotal, difference } = value.accounting;
  if (!number(storedTotal) || !number(observedQuantityTotal) || !number(difference) ||
    (storedTotal !== null && storedTotal < 0) || (observedQuantityTotal !== null && observedQuantityTotal < 0) ||
    difference !== (storedTotal === null || observedQuantityTotal === null ? null : observedQuantityTotal - storedTotal))
    throw new Error('Invalid accounting');
  return { findings: value.findings, accounting: { storedTotal, observedQuantityTotal, difference },
  control: value.control, fence: value.fence };
}

export function parseObservedControlState(
  raw: string | null,
): 'ALLOW' | 'RESTRICTED' | 'CLEARANCE_STAGED' | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'state' in parsed) {
      const state = (parsed as { state?: unknown }).state;
      if (state === 'ALLOW' || state === 'RESTRICTED' || state === 'CLEARANCE_STAGED') return state;
    }
  } catch { /* fall through */ }
  return null;
}

export const RESTRICTION_STATE_FINDINGS: Record<string, ObservationFinding> = {
  PREPARED: 'RESTRICTION_PREPARED',
  ENFORCED: 'RESTRICTION_ENFORCED',
  CLEARING: 'RESTRICTION_CLEARING',
  CLEARED: 'RESTRICTION_CLEARED',
};

export function uncertainObservation(): ReservationObservation {
  return { authority: 'NONE', physicalConvergenceProven: false, scope: 'OBSERVED_RESOURCES_ONLY',
    membershipCompleteness: 'UNPROVEN', findings: ['INFRASTRUCTURE_UNCERTAIN'],
    accounting: { storedTotal: null, observedQuantityTotal: null, difference: null },
    restriction: { durableState: 'UNKNOWN', revision: null, observationDigest: null,
      physicalState: 'UNKNOWN', installation: 'NOT_PROVEN', crossStoreConsistency: 'UNPROVEN' } };
}
