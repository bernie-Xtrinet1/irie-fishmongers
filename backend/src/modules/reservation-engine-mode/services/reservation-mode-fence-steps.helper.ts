import { ReservationEngineMode } from '@prisma/client';

import { FencePhase } from '../../reservation-fence/types/reservation-fence.types';

export type FenceTransitionReason = 'BOOTSTRAP' | 'RESTRICT' | 'OPEN' | 'ABORT_FREEZE' | 'RETIRE';

export const VALID_COORDINATED_TRANSITIONS: ReadonlySet<string> = new Set([
  'LEGACY->MIRROR',
  'MIRROR->LEGACY',
  'MIRROR->CART_SCOPED',
  'CART_SCOPED->DRAINING',
  'DRAINING->CART_SCOPED',
  'DRAINING->LEGACY',
]);

export interface ModeFenceStepSpec {
  targetPhase: FencePhase;
  targetMode: ReservationEngineMode;
  reason: FenceTransitionReason;
  advanceMode: boolean;
  bootstrap: boolean;
  evidenceId: string | null;
}

export function nextCoordinatedFenceStep(
  currentMode: ReservationEngineMode,
  targetMode: ReservationEngineMode,
  currentPhase: FencePhase | null,
  evidenceId: string,
): ModeFenceStepSpec {
  if (currentMode === 'LEGACY' && targetMode === 'MIRROR') {
    if (!currentPhase || currentPhase === 'RETIRED') {
      return {
        targetPhase: 'FROZEN',
        targetMode: 'LEGACY',
        reason: 'BOOTSTRAP',
        advanceMode: false,
        bootstrap: true,
        evidenceId,
      };
    }
    return { targetPhase: 'OPEN', targetMode: 'MIRROR', reason: 'OPEN', advanceMode: true, bootstrap: false, evidenceId: null };
  }
  if (currentMode === 'MIRROR' && targetMode === 'LEGACY') {
    if (currentPhase === 'FROZEN') {
      return {
        targetPhase: 'DRAINING',
        targetMode: 'MIRROR',
        reason: 'RESTRICT',
        advanceMode: false,
        bootstrap: false,
        evidenceId: null,
      };
    }
    return {
      targetPhase: 'FROZEN',
      targetMode: 'LEGACY',
      reason: 'ABORT_FREEZE',
      advanceMode: true,
      bootstrap: false,
      evidenceId: null,
    };
  }
  if (currentMode === 'MIRROR' && targetMode === 'CART_SCOPED') {
    if (currentPhase !== 'FROZEN') {
      return {
        targetPhase: 'FROZEN',
        targetMode: 'MIRROR',
        reason: 'RESTRICT',
        advanceMode: false,
        bootstrap: false,
        evidenceId: null,
      };
    }
    return {
      targetPhase: 'OPEN',
      targetMode: 'CART_SCOPED',
      reason: 'OPEN',
      advanceMode: true,
      bootstrap: false,
      evidenceId: null,
    };
  }
  if (currentMode === 'CART_SCOPED' && targetMode === 'DRAINING') {
    if (currentPhase === 'DRAINING') {
      return {
        targetPhase: 'FROZEN',
        targetMode: 'CART_SCOPED',
        reason: 'RESTRICT',
        advanceMode: false,
        bootstrap: false,
        evidenceId: null,
      };
    }
    return {
      targetPhase: 'DRAINING',
      targetMode: 'DRAINING',
      reason: currentPhase === 'FROZEN' ? 'ABORT_FREEZE' : 'RESTRICT',
      advanceMode: true,
      bootstrap: false,
      evidenceId: null,
    };
  }
  if (currentMode === 'DRAINING' && targetMode === 'CART_SCOPED') {
    if (currentPhase === 'DRAINING') {
      return {
        targetPhase: 'FROZEN',
        targetMode: 'DRAINING',
        reason: 'RESTRICT',
        advanceMode: false,
        bootstrap: false,
        evidenceId: null,
      };
    }
    return {
      targetPhase: 'OPEN',
      targetMode: 'CART_SCOPED',
      reason: 'OPEN',
      advanceMode: true,
      bootstrap: false,
      evidenceId: null,
    };
  }
  if (currentPhase !== 'FROZEN') {
    return { targetPhase: 'FROZEN', targetMode: 'DRAINING', reason: 'RESTRICT', advanceMode: false, bootstrap: false, evidenceId };
  }
  return { targetPhase: 'RETIRED', targetMode: 'LEGACY', reason: 'RETIRE', advanceMode: true, bootstrap: false, evidenceId };
}
