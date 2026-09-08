import { CheckoutRolloutBehavior } from '@prisma/client';
import { CheckoutRolloutPolicyService } from '../../checkout-rollout/services/checkout-rollout-policy.service';
import { RolloutControlsService } from './rollout-controls.service';
import { RolloutControlTelemetryService } from './rollout-control-telemetry.service';
import { InactiveRolloutPolicyService } from './inactive-rollout-policy.service';

describe('Inactive rollout evaluation', () => {
  const current = jest.fn();
  const evaluateParticipation = jest.fn();
  const record = jest.fn();
  const evaluator = new InactiveRolloutPolicyService(
    { current } as unknown as RolloutControlsService,
    { evaluateParticipation } as unknown as CheckoutRolloutPolicyService,
    { record } as unknown as RolloutControlTelemetryService,
  );
  beforeEach(() => {
    jest.clearAllMocks();
    current.mockResolvedValue({
      status: 'CONFIGURED',
      control: { newAdmissionStopped: false, behavior: 'CART_SCOPED', eligibleCohort: 'pilot' },
    });
    evaluateParticipation.mockResolvedValue({ status: 'ENABLED', enabled: true, cohort: 'pilot' });
  });
  it.each(['ABSENT', 'UNAVAILABLE'])(
    'fails closed on global %s without participant reads',
    async (status) => {
      current.mockResolvedValue({ status, control: null });
      expect(await evaluator.evaluate('customer')).toMatchObject({
        behavior: 'DENY',
        available: false,
        reason: `GLOBAL_${status}`,
      });
      expect(evaluateParticipation).not.toHaveBeenCalled();
    },
  );
  it.each([
    [true, 'CART_SCOPED', 'STOPPED'],
    [false, 'DENY', 'EXPLICIT_DENY'],
  ])('global precedence: stopped=%s behavior=%s', async (stopped, behavior, reason) => {
    current.mockResolvedValue({
      status: 'CONFIGURED',
      control: { newAdmissionStopped: stopped, behavior, eligibleCohort: null },
    });
    expect(await evaluator.evaluate('customer')).toMatchObject({ behavior: 'DENY', reason });
    expect(evaluateParticipation).not.toHaveBeenCalled();
  });
  it('distinguishes participant lookup failure', async () => {
    evaluateParticipation.mockResolvedValue({ status: 'LOOKUP_FAILED', enabled: false });
    expect(await evaluator.evaluate('customer')).toMatchObject({
      available: false,
      behavior: 'DENY',
      reason: 'PARTICIPANT_UNAVAILABLE',
    });
  });
  it.each(['NOT_FOUND', 'DISABLED'])('denies participant %s', async (status) => {
    evaluateParticipation.mockResolvedValue({ status, enabled: false });
    expect(await evaluator.evaluate('customer')).toMatchObject({
      behavior: 'DENY',
      reason: 'PARTICIPANT_INELIGIBLE',
    });
  });
  it.each(['other', null])('denies cohort mismatch %s', async (cohort) => {
    evaluateParticipation.mockResolvedValue({ status: 'ENABLED', enabled: true, cohort });
    expect(await evaluator.evaluate('customer')).toMatchObject({
      behavior: 'DENY',
      reason: 'COHORT_MISMATCH',
    });
  });
  it.each([
    CheckoutRolloutBehavior.CART_SCOPED,
    CheckoutRolloutBehavior.LEGACY,
    CheckoutRolloutBehavior.SHADOW,
  ])('returns %s only as advisory policy', async (behavior) => {
    current.mockResolvedValue({
      status: 'CONFIGURED',
      control: { newAdmissionStopped: false, behavior, eligibleCohort: null },
    });
    expect(await evaluator.evaluate('customer')).toEqual({
      advisoryOnly: true,
      productionDispatcherActive: false,
      available: true,
      behavior,
      reason: 'ELIGIBLE',
    });
    expect(current).toHaveBeenCalledTimes(1);
    expect(evaluateParticipation).toHaveBeenCalledWith('customer');
    expect(record).not.toHaveBeenCalled();
  });
  it('rereads policy on each evaluation without cached positive authority', async () => {
    expect((await evaluator.evaluate('customer')).behavior).toBe('CART_SCOPED');
    current.mockResolvedValue({ status: 'ABSENT', control: null });
    expect((await evaluator.evaluate('customer')).behavior).toBe('DENY');
    expect(current).toHaveBeenCalledTimes(2);
  });
});
