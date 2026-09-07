import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { CheckoutRolloutParticipantsRepository } from '../repositories/checkout-rollout-participants.repository';
import { SetParticipationInput } from '../types/checkout-rollout.types';
import { CheckoutRolloutParticipantsService } from './checkout-rollout-participants.service';

describe('CheckoutRolloutParticipantsService', () => {
  const customerId = randomUUID();
  const actorId = randomUUID();
  const input: SetParticipationInput = {
    enabled: true,
    cohort: 'pilot-1',
    reason: 'Approve pilot',
    expectedRevision: null,
  };
  const repository = { appendIfCurrent: jest.fn(), findCurrent: jest.fn(), listHistory: jest.fn() };
  const service = new CheckoutRolloutParticipantsService(
    repository as unknown as CheckoutRolloutParticipantsRepository,
  );
  beforeEach(() => jest.resetAllMocks());

  it('uses explicit trusted IDs, discards extra payload fields and trims the audit reason', async () => {
    const participant = { id: randomUUID() };
    repository.appendIfCurrent.mockResolvedValue({ ok: true, participant });
    const payload = {
      ...input,
      customerId: randomUUID(),
      actorId: randomUUID(),
      revision: 500,
      reason: '  Approve pilot  ',
    };
    await expect(service.setParticipation(customerId, actorId, payload)).resolves.toBe(participant);
    expect(repository.appendIfCurrent).toHaveBeenCalledWith(customerId, actorId, input);
  });

  it.each([
    { enabled: 'true' },
    { cohort: '' },
    { cohort: '*' },
    { cohort: 'a'.repeat(65) },
    { cohort: 'private email@example.com' },
    { reason: '  ' },
    { reason: 'a'.repeat(501) },
    { expectedRevision: 0 },
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { expectedRevision: 2147483647 },
  ])('rejects invalid state %j without mutation', async (change) => {
    await expect(
      service.setParticipation(customerId, actorId, {
        ...input,
        ...change,
      } as SetParticipationInput),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.appendIfCurrent).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid', actorId],
    [customerId, 'invalid'],
  ])('rejects invalid identity', async (customer, actor) => {
    await expect(service.setParticipation(customer, actor, input)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repository.appendIfCurrent).not.toHaveBeenCalled();
  });

  it('rejects stale revision without retrying/overwriting', async () => {
    repository.appendIfCurrent.mockResolvedValue({
      ok: false,
      code: 'STALE_REVISION',
      currentRevision: 2,
    });
    await expect(service.setParticipation(customerId, actorId, input)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repository.appendIfCurrent).toHaveBeenCalledTimes(1);
  });

  it.each(['CUSTOMER_NOT_FOUND', 'ACTOR_NOT_FOUND'])('reports %s', async (code) => {
    repository.appendIfCurrent.mockResolvedValue({ ok: false, code });
    await expect(service.setParticipation(customerId, actorId, input)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('propagates failed writes instead of claiming success', async () => {
    repository.appendIfCurrent.mockRejectedValue(new Error('transaction failed'));
    await expect(service.setParticipation(customerId, actorId, input)).rejects.toThrow(
      'transaction failed',
    );
  });

  it('reads current membership and bounded history', async () => {
    repository.findCurrent.mockResolvedValue(null);
    repository.listHistory.mockResolvedValue([]);
    await expect(service.getParticipant(customerId)).resolves.toBeNull();
    await expect(service.listHistory(customerId)).resolves.toEqual([]);
    expect(repository.listHistory).toHaveBeenCalledWith(customerId, 0, 50);
    await service.listHistory(customerId, 2, 10);
    expect(repository.listHistory).toHaveBeenLastCalledWith(customerId, 2, 10);
  });

  it.each([
    [-1, 50],
    [0, 201],
    [0, 0],
    [0.5, 50],
    [2147483648, 1],
  ])('rejects invalid history pagination', (cursor, limit) => {
    expect(() => service.listHistory(customerId, cursor, limit)).toThrow(BadRequestException);
  });
});
