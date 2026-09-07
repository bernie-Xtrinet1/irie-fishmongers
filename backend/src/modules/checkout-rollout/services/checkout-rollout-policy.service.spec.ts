import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { CheckoutRolloutParticipant } from '@prisma/client';

import { CheckoutRolloutParticipantsRepository } from '../repositories/checkout-rollout-participants.repository';
import { CheckoutRolloutPolicyService } from './checkout-rollout-policy.service';

describe('CheckoutRolloutPolicyService', () => {
  const customerId = randomUUID();
  const participant: CheckoutRolloutParticipant = {
    id: randomUUID(),
    customerId,
    actorId: randomUUID(),
    enabled: true,
    cohort: 'pilot',
    reason: 'Approved pilot',
    revision: 1,
    createdAt: new Date(),
  };
  const repository = { findCurrent: jest.fn() };
  const service = new CheckoutRolloutPolicyService(
    repository as unknown as CheckoutRolloutParticipantsRepository,
  );

  beforeEach(() => jest.resetAllMocks());

  it('reports absence without enabling membership', async () => {
    repository.findCurrent.mockResolvedValue(null);
    await expect(service.evaluateParticipation(customerId)).resolves.toEqual({
      status: 'NOT_FOUND',
      enabled: false,
      cohort: null,
      revision: null,
      participantId: null,
    });
  });

  it('reports enabled policy using only the server customer identity', async () => {
    repository.findCurrent.mockResolvedValue(participant);
    await expect(service.evaluateParticipation(customerId)).resolves.toEqual({
      status: 'ENABLED',
      enabled: true,
      cohort: 'pilot',
      revision: 1,
      participantId: participant.id,
    });
    expect(repository.findCurrent).toHaveBeenCalledWith(customerId);
  });

  it('a cohort does not enable a disabled member', async () => {
    repository.findCurrent.mockResolvedValue({ ...participant, enabled: false });
    await expect(service.evaluateParticipation(customerId)).resolves.toMatchObject({
      status: 'DISABLED',
      enabled: false,
      cohort: 'pilot',
    });
  });

  it('distinguishes lookup failure without leaking infrastructure details', async () => {
    repository.findCurrent.mockRejectedValue(new Error('private connection details'));
    await expect(service.evaluateParticipation(customerId)).resolves.toEqual({
      status: 'LOOKUP_FAILED',
      enabled: false,
      cohort: null,
      revision: null,
      participantId: null,
    });
  });

  it('re-reads on every evaluation so a disable is immediately visible', async () => {
    repository.findCurrent
      .mockResolvedValueOnce(participant)
      .mockResolvedValueOnce({ ...participant, enabled: false, revision: 2 });
    expect((await service.evaluateParticipation(customerId)).status).toBe('ENABLED');
    expect((await service.evaluateParticipation(customerId)).status).toBe('DISABLED');
    expect(repository.findCurrent).toHaveBeenCalledTimes(2);
  });

  it.each(['*', 'customer@example.com', '', 'not-a-uuid'])(
    'rejects malformed authority %s before lookup',
    async (id) => {
      await expect(service.evaluateParticipation(id)).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.findCurrent).not.toHaveBeenCalled();
    },
  );
});
