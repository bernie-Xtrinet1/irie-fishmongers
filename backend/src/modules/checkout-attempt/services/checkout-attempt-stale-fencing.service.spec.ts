import { CheckoutAttempt } from '@prisma/client';
import { CheckoutAttemptRepository } from '../repositories/checkout-attempt.repository';
import { CheckoutAttemptStaleFencingService } from './checkout-attempt-stale-fencing.service';

describe('CheckoutAttempt stale fencing contract', () => {
  const input = {
    attemptId: 'attempt',
    customerId: 'customer',
    selectedPath: 'CART_SCOPED' as const,
    observedHeartbeatAt: new Date(1000),
    staleBefore: new Date(2000),
    now: new Date(3000),
  };
  let repository: jest.Mocked<Pick<CheckoutAttemptRepository, 'fenceStaleProcessing' | 'findById'>>;
  let service: CheckoutAttemptStaleFencingService;
  beforeEach(() => {
    repository = {
      fenceStaleProcessing: jest.fn().mockResolvedValue({ count: 0 }),
      findById: jest.fn(),
    };
    service = new CheckoutAttemptStaleFencingService(
      repository as unknown as CheckoutAttemptRepository,
    );
  });
  it('returns FENCED only for an atomic successful mutation, without re-reading', async () => {
    repository.fenceStaleProcessing.mockResolvedValue({ count: 1 });
    expect(await service.fence(input)).toEqual({ ok: true, outcome: 'FENCED' });
    expect(repository.findById).not.toHaveBeenCalled();
  });
  it.each([
    [null, 'NOT_FOUND'],
    [{ customerId: 'other' }, 'OWNERSHIP_MISMATCH'],
    [{ customerId: 'customer', selectedPath: null }, 'UNKNOWN_PATH'],
    [{ customerId: 'customer', selectedPath: 'LEGACY' }, 'PATH_MISMATCH'],
    [
      { customerId: 'customer', selectedPath: 'CART_SCOPED', status: 'COMMITTED' },
      'ALREADY_COMMITTED',
    ],
    [{ customerId: 'customer', selectedPath: 'CART_SCOPED', status: 'FAILED' }, 'ALREADY_FAILED'],
    [
      { customerId: 'customer', selectedPath: 'CART_SCOPED', status: 'PROCESSING' },
      'STALE_OBSERVATION',
    ],
  ])('classifies a lost CAS without retry: %j', async (row, code) => {
    repository.findById.mockResolvedValue(row as CheckoutAttempt | null);
    expect(await service.fence(input)).toEqual({ ok: false, code });
    expect(repository.fenceStaleProcessing).toHaveBeenCalledTimes(1);
    expect(repository.fenceStaleProcessing).toHaveBeenCalledWith(input);
  });
  it.each([
    { observedHeartbeatAt: new Date('invalid') },
    { observedHeartbeatAt: new Date(2000) },
    { staleBefore: new Date(4000) },
    { selectedPath: null },
    { selectedPath: 'SHADOW' },
    { customerId: '' },
    { now: null },
    { observedHeartbeatAt: null },
  ])('rejects invalid/unknown input before any database access: %j', async (override) => {
    expect(await service.fence({ ...input, ...override } as typeof input)).toMatchObject({
      ok: false,
      code: 'INVALID_INPUT',
    });
    expect(repository.fenceStaleProcessing).not.toHaveBeenCalled();
    expect(repository.findById).not.toHaveBeenCalled();
  });
});
