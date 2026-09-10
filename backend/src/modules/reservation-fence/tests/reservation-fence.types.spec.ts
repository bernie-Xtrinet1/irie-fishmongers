import { ReservationEngineMode } from '@prisma/client';
import { randomUUID } from 'crypto';
import { FENCE_PHASES, isFenceTuple, legalPair, phaseTransition } from '../types/reservation-fence.types';

describe('G.4b.1 closed state machine', () => {
  const stable: Record<ReservationEngineMode, string[]> = {
    LEGACY: ['RETIRED'], MIRROR: ['OPEN'], CART_SCOPED: ['OPEN'], DRAINING: ['DRAINING', 'FROZEN'],
  };
  const explained: Record<ReservationEngineMode, string[]> = {
    LEGACY: ['FROZEN', 'RETIRED'], MIRROR: ['OPEN', 'DRAINING', 'FROZEN'],
    CART_SCOPED: ['OPEN', 'DRAINING', 'FROZEN'], DRAINING: ['DRAINING', 'FROZEN'],
  };
  for (const mode of Object.values(ReservationEngineMode)) {
    for (const phase of FENCE_PHASES) {
      it(`${mode}/${phase}: unexplained pairs cannot fail open`, () => {
        expect(legalPair(mode, phase, false)).toBe(stable[mode].includes(phase));
        expect(legalPair(mode, phase, true)).toBe(explained[mode].includes(phase));
      });
    }
  }
  const edges = ['OPEN:DRAINING', 'OPEN:FROZEN', 'DRAINING:FROZEN', 'FROZEN:OPEN', 'FROZEN:DRAINING', 'FROZEN:RETIRED'];
  for (const from of FENCE_PHASES) for (const to of FENCE_PHASES) {
    it(`control ${from} -> ${to}`, () => expect(phaseTransition(from, to)).toBe(edges.includes(`${from}:${to}`)));
  }
  it.each([null, {}, { epoch: 1 }, [], 'OPEN'])('rejects malformed tuple %#', value => expect(isFenceTuple(value)).toBe(false));
  it('requires exact bounded tuple with no extra metadata', () => {
    const tuple = { incarnation: randomUUID(), transitionId: randomUUID(), epoch: 1, revision: 1, phase: 'FROZEN', protocol: 1 };
    expect(isFenceTuple(tuple)).toBe(true);
    expect(isFenceTuple({ ...tuple, epoch: 2147483648 })).toBe(false);
    expect(isFenceTuple({ ...tuple, revision: 1.5 })).toBe(false);
    expect(isFenceTuple({ ...tuple, secret: 'disallowed' })).toBe(false);
  });
});
