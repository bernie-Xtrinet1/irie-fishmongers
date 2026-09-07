import { CheckoutRolloutParticipant } from '@prisma/client';

// Membership information only; ENABLED is not checkout admission authorization.
export type ParticipationResult =
  | {
      status: 'ENABLED';
      enabled: true;
      cohort: string | null;
      revision: number;
      participantId: string;
    }
  | {
      status: 'DISABLED';
      enabled: false;
      cohort: string | null;
      revision: number;
      participantId: string;
    }
  | {
      status: 'NOT_FOUND' | 'LOOKUP_FAILED';
      enabled: false;
      cohort: null;
      revision: null;
      participantId: null;
    };

export interface SetParticipationInput {
  enabled: boolean;
  cohort: string | null;
  reason: string;
  // null means create only if no revision exists; updates require the observed revision.
  expectedRevision: number | null;
}

export type AppendParticipationResult =
  | { ok: true; participant: CheckoutRolloutParticipant }
  | { ok: false; code: 'STALE_REVISION'; currentRevision: number | null }
  | { ok: false; code: 'CUSTOMER_NOT_FOUND' | 'ACTOR_NOT_FOUND' };
