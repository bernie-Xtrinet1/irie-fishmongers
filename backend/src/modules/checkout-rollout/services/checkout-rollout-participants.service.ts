import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CheckoutRolloutParticipant } from '@prisma/client';
import { isUUID } from 'class-validator';

import { CheckoutRolloutParticipantsRepository } from '../repositories/checkout-rollout-participants.repository';
import { SetParticipationInput } from '../types/checkout-rollout.types';

export function assertRolloutUserId(value: string): void {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new BadRequestException('A valid user UUID is required');
  }
}

@Injectable()
export class CheckoutRolloutParticipantsService {
  constructor(private readonly repository: CheckoutRolloutParticipantsRepository) {}

  // Future G.3 caller must authorize the actor. This inactive service does not
  // authenticate request payloads or perform checkout/account authorization.
  async setParticipation(
    customerId: string,
    actorId: string,
    input: SetParticipationInput,
  ): Promise<CheckoutRolloutParticipant> {
    assertRolloutUserId(customerId);
    assertRolloutUserId(actorId);
    if (typeof input.enabled !== 'boolean')
      throw new BadRequestException('enabled must be boolean');
    if (
      input.cohort !== null &&
      (typeof input.cohort !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.cohort))
    ) {
      throw new BadRequestException('cohort must be null or a 1-64 character diagnostic label');
    }
    if (
      typeof input.reason !== 'string' ||
      input.reason.trim().length < 3 ||
      input.reason.trim().length > 500
    ) {
      throw new BadRequestException('reason must contain 3-500 characters');
    }
    if (
      input.expectedRevision !== null &&
      (!Number.isInteger(input.expectedRevision) ||
        input.expectedRevision < 1 ||
        input.expectedRevision >= 2147483647)
    ) {
      throw new BadRequestException(
        'expectedRevision must be null or a positive incrementable database integer',
      );
    }
    const result = await this.repository.appendIfCurrent(customerId, actorId, {
      enabled: input.enabled,
      cohort: input.cohort,
      reason: input.reason.trim(),
      expectedRevision: input.expectedRevision,
    });
    if (!result.ok) {
      if (result.code === 'STALE_REVISION')
        throw new ConflictException('Participation revision changed; reload before retrying');
      throw new NotFoundException(
        result.code === 'CUSTOMER_NOT_FOUND' ? 'Customer not found' : 'Actor not found',
      );
    }
    return result.participant;
  }

  getParticipant(customerId: string): Promise<CheckoutRolloutParticipant | null> {
    assertRolloutUserId(customerId);
    return this.repository.findCurrent(customerId);
  }

  listHistory(
    customerId: string,
    afterRevision = 0,
    limit = 50,
  ): Promise<CheckoutRolloutParticipant[]> {
    assertRolloutUserId(customerId);
    if (
      !Number.isInteger(afterRevision) ||
      afterRevision < 0 ||
      afterRevision > 2147483647 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    ) {
      throw new BadRequestException('Invalid history cursor or page size (maximum 200)');
    }
    return this.repository.listHistory(customerId, afterRevision, limit);
  }
}
