import { Injectable } from '@nestjs/common';
import {
  ApprovalChallengeStatus,
  CustomerWeightApprovalChallenge,
  Prisma,
} from '@prisma/client';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../database/prisma.service';
import {
  AdjustmentNotFoundError,
  ChallengeAlreadyConsumedError,
  ChallengeExpiredError,
  ChallengeNotFoundError,
  ChallengeRevokedError,
  CustomerApprovalChallengeConflictError,
  CustomerApprovalMismatchError,
  CustomerApprovalRevisionMismatchError,
  ImmutableAuditMutationError,
} from './errors/weight-adjustment-repository.errors';
import {
  ConsumeApprovalChallengeInput,
  CreateApprovalChallengeInput,
  RenewApprovalChallengeInput,
} from './types/weight-adjustment-repository.types';
import { ClockFn } from '../services/weight-adjustment-approval-token.service';

@Injectable()
export class CustomerWeightApprovalChallengeRepository {
  private readonly clock: ClockFn;

  constructor(
    private readonly prisma: PrismaService,
    clock?: ClockFn,
  ) {
    this.clock = clock ?? (() => new Date());
  }

  /**
   * Creates a new durable approval challenge for a weight adjustment measurement revision.
   * - Acquires PostgreSQL row-level lock on the parent weight adjustment before reading or modifying.
   * - Restricts creation to the active measurement revision of the parent adjustment.
   * - Atomically revokes any pre-existing OPEN challenge for the same revision.
   * - Increments challengeSequence to preserve complete historical audit retention.
   * - Translates any unique constraint conflicts into typed CustomerApprovalChallengeConflictError.
   */
  async createChallenge(
    input: CreateApprovalChallengeInput,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomerWeightApprovalChallenge> {
    const executeInTransaction = async (txClient: Prisma.TransactionClient) => {
      // 1. Acquire PostgreSQL row-level lock on parent weight adjustment
      if (typeof (txClient as any).$queryRaw === 'function') {
        await txClient.$queryRaw`
          SELECT id, "activeMeasurementRevision"
          FROM "seafood_order_weight_adjustments"
          WHERE id = ${input.weightAdjustmentId}
          FOR UPDATE;
        `;
      }

      // 2. Verify parent adjustment and active revision
      const adjustment = await txClient.seafoodOrderWeightAdjustment.findUnique({
        where: { id: input.weightAdjustmentId },
        select: { id: true, activeMeasurementRevision: true },
      });

      if (!adjustment) {
        throw new AdjustmentNotFoundError(input.weightAdjustmentId);
      }

      const activeRev = adjustment.activeMeasurementRevision ?? 0;
      if (input.measurementRevision !== activeRev) {
        throw new CustomerApprovalRevisionMismatchError(
          input.weightAdjustmentId,
          input.measurementRevision,
          activeRev,
        );
      }

      // 3. Revoke any existing OPEN challenge for this revision
      const now = this.clock();
      await txClient.customerWeightApprovalChallenge.updateMany({
        where: {
          weightAdjustmentId: input.weightAdjustmentId,
          measurementRevision: input.measurementRevision,
          status: ApprovalChallengeStatus.OPEN,
        },
        data: {
          status: ApprovalChallengeStatus.REVOKED,
          revokedAt: now,
          revocationReason: 'SUPERSEDED_BY_NEW_CHALLENGE',
        },
      });

      // 4. Determine next challenge sequence
      const latest = await txClient.customerWeightApprovalChallenge.findFirst({
        where: {
          weightAdjustmentId: input.weightAdjustmentId,
          measurementRevision: input.measurementRevision,
        },
        orderBy: { challengeSequence: 'desc' },
        select: { challengeSequence: true },
      });
      const nextSequence = (latest?.challengeSequence ?? 0) + 1;

      // 5. Calculate difference amount
      const proposed = new Decimal(input.proposedTotalJmd);
      const ceiling = new Decimal(input.authorizedCeilingJmd);
      const diff = proposed.minus(ceiling);

      // 6. Insert new challenge record
      return txClient.customerWeightApprovalChallenge.create({
        data: {
          weightAdjustmentId: input.weightAdjustmentId,
          measurementRevision: input.measurementRevision,
          challengeSequence: nextSequence,
          authenticatedCustomerId: input.authenticatedCustomerId,
          proposedTotalJmd: new Prisma.Decimal(proposed.toFixed(2)),
          authorizedCeilingJmd: new Prisma.Decimal(ceiling.toFixed(2)),
          differenceAmountJmd: new Prisma.Decimal(diff.toFixed(2)),
          approvalTokenHash: input.approvalTokenHash,
          expiresAt: input.expiresAt,
          status: ApprovalChallengeStatus.OPEN,
          createdAt: now,
        },
      });
    };

    try {
      if (tx) {
        return await executeInTransaction(tx);
      }
      return await this.prisma.$transaction(executeInTransaction);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new CustomerApprovalChallengeConflictError(
          input.weightAdjustmentId,
          input.measurementRevision,
        );
      }
      throw err;
    }
  }

  /**
   * Looks up a challenge by its unique SHA-256 token hash (safe read without secrets).
   */
  async findByTokenHash(
    tokenHash: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomerWeightApprovalChallenge | null> {
    const client = tx ?? this.prisma;
    return client.customerWeightApprovalChallenge.findUnique({
      where: { approvalTokenHash: tokenHash },
    });
  }

  /**
   * Looks up a challenge by primary key ID.
   */
  async findById(
    challengeId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomerWeightApprovalChallenge | null> {
    const client = tx ?? this.prisma;
    return client.customerWeightApprovalChallenge.findUnique({
      where: { id: challengeId },
    });
  }

  /**
   * Atomically consumes an OPEN, unexpired challenge matching the active revision.
   * - Resolves the challenge and locks the parent weight adjustment in consistent order.
   * - Authoritatively verifies active measurement revision, customer ownership, amounts, and validity.
   * - Enforces conditional predicate at the database level to prevent concurrent double-consumption.
   * - Participates in caller-supplied interactive transactions for atomic decision composition.
   */
  async consumeChallenge(
    input: ConsumeApprovalChallengeInput,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomerWeightApprovalChallenge> {
    const executeInTransaction = async (txClient: Prisma.TransactionClient) => {
      // 1. Resolve challenge record
      const challenge = await txClient.customerWeightApprovalChallenge.findUnique({
        where: { id: input.challengeId },
      });

      if (!challenge) {
        throw new ChallengeNotFoundError(input.challengeId);
      }

      // 2. Acquire parent adjustment lock in consistent order
      if (typeof (txClient as any).$queryRaw === 'function') {
        await txClient.$queryRaw`
          SELECT id, "activeMeasurementRevision"
          FROM "seafood_order_weight_adjustments"
          WHERE id = ${challenge.weightAdjustmentId}
          FOR UPDATE;
        `;
      }

      // 3. Fetch and validate parent adjustment state
      const adjustment = await txClient.seafoodOrderWeightAdjustment.findUnique({
        where: { id: challenge.weightAdjustmentId },
        select: { id: true, activeMeasurementRevision: true },
      });

      if (!adjustment) {
        throw new AdjustmentNotFoundError(challenge.weightAdjustmentId);
      }

      // 4. Validate authoritative parent revision vs challenge & expected revision
      const activeRev = adjustment.activeMeasurementRevision ?? 0;
      if (challenge.measurementRevision !== activeRev) {
        throw new CustomerApprovalRevisionMismatchError(
          challenge.weightAdjustmentId,
          challenge.measurementRevision,
          activeRev,
        );
      }

      if (input.expectedMeasurementRevision !== activeRev) {
        throw new CustomerApprovalRevisionMismatchError(
          challenge.weightAdjustmentId,
          input.expectedMeasurementRevision,
          activeRev,
        );
      }

      // 5. Validate customer ownership
      if (challenge.authenticatedCustomerId !== input.authenticatedCustomerId) {
        throw new CustomerApprovalMismatchError('Challenge customer does not match authenticated customer.');
      }

      // 6. Validate expected proposed amount and ceiling if specified
      if (input.expectedProposedTotalJmd !== undefined) {
        const challengeProposed = new Decimal(challenge.proposedTotalJmd.toString());
        const expectedProposed = new Decimal(input.expectedProposedTotalJmd.toString());
        if (!challengeProposed.equals(expectedProposed)) {
          throw new CustomerApprovalMismatchError(
            `Proposed total mismatch: challenge is ${challengeProposed.toFixed(2)}, expected ${expectedProposed.toFixed(2)}.`,
          );
        }
      }

      if (input.expectedAuthorizedCeilingJmd !== undefined) {
        const challengeCeiling = new Decimal(challenge.authorizedCeilingJmd.toString());
        const expectedCeiling = new Decimal(input.expectedAuthorizedCeilingJmd.toString());
        if (!challengeCeiling.equals(expectedCeiling)) {
          throw new CustomerApprovalMismatchError(
            `Authorized ceiling mismatch: challenge is ${challengeCeiling.toFixed(2)}, expected ${expectedCeiling.toFixed(2)}.`,
          );
        }
      }

      // 7. Validate lifecycle status & expiry
      const now = this.clock();

      if (challenge.status === ApprovalChallengeStatus.CONSUMED) {
        throw new ChallengeAlreadyConsumedError(challenge.id, challenge.consumedAt);
      }

      if (challenge.status === ApprovalChallengeStatus.REVOKED) {
        throw new ChallengeRevokedError(challenge.id, challenge.revocationReason ?? undefined);
      }

      if (challenge.status === ApprovalChallengeStatus.EXPIRED || challenge.expiresAt < now) {
        throw new ChallengeExpiredError(challenge.id, challenge.expiresAt);
      }

      // 8. Atomic conditional CAS consumption update
      const updateResult = await txClient.customerWeightApprovalChallenge.updateMany({
        where: {
          id: input.challengeId,
          status: ApprovalChallengeStatus.OPEN,
          expiresAt: { gte: now },
          measurementRevision: input.expectedMeasurementRevision,
          authenticatedCustomerId: input.authenticatedCustomerId,
        },
        data: {
          status: ApprovalChallengeStatus.CONSUMED,
          consumedAt: input.consumedAt ?? now,
        },
      });

      if (updateResult.count !== 1) {
        const recheck = await txClient.customerWeightApprovalChallenge.findUnique({
          where: { id: input.challengeId },
        });
        if (recheck?.status === ApprovalChallengeStatus.CONSUMED) {
          throw new ChallengeAlreadyConsumedError(input.challengeId, recheck.consumedAt);
        }
        if (recheck?.status === ApprovalChallengeStatus.REVOKED) {
          throw new ChallengeRevokedError(input.challengeId, recheck.revocationReason ?? undefined);
        }
        if (recheck && (recheck.status === ApprovalChallengeStatus.EXPIRED || recheck.expiresAt < now)) {
          throw new ChallengeExpiredError(input.challengeId, recheck.expiresAt);
        }
        throw new ChallengeAlreadyConsumedError(input.challengeId);
      }

      const consumed = await txClient.customerWeightApprovalChallenge.findUnique({
        where: { id: input.challengeId },
      });
      if (!consumed) throw new ChallengeNotFoundError(input.challengeId);
      return consumed;
    };

    try {
      if (tx) {
        return await executeInTransaction(tx);
      }
      return await this.prisma.$transaction(executeInTransaction);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new CustomerApprovalChallengeConflictError(
          input.challengeId,
          input.expectedMeasurementRevision,
        );
      }
      throw err;
    }
  }

  /**
   * Revokes an open challenge with an explicit reason.
   */
  async revokeChallenge(
    challengeId: string,
    reason: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomerWeightApprovalChallenge> {
    const client = tx ?? this.prisma;
    const now = this.clock();

    const existing = await client.customerWeightApprovalChallenge.findUnique({
      where: { id: challengeId },
    });
    if (!existing) {
      throw new ChallengeNotFoundError(challengeId);
    }

    return client.customerWeightApprovalChallenge.update({
      where: { id: challengeId },
      data: {
        status: ApprovalChallengeStatus.REVOKED,
        revokedAt: now,
        revocationReason: reason,
      },
    });
  }

  /**
   * Safely renews an expired or existing challenge by revoking open challenges and creating sequence N+1.
   */
  async renewChallenge(
    input: RenewApprovalChallengeInput,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomerWeightApprovalChallenge> {
    return this.createChallenge(
      {
        weightAdjustmentId: input.weightAdjustmentId,
        measurementRevision: input.measurementRevision,
        authenticatedCustomerId: input.authenticatedCustomerId,
        proposedTotalJmd: input.proposedTotalJmd,
        authorizedCeilingJmd: input.authorizedCeilingJmd,
        approvalTokenHash: input.newApprovalTokenHash,
        expiresAt: input.newExpiresAt,
      },
      tx,
    );
  }

  /**
   * Finds the latest challenge for a given adjustment and revision.
   */
  async findLatestChallenge(
    weightAdjustmentId: string,
    measurementRevision: number,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomerWeightApprovalChallenge | null> {
    const client = tx ?? this.prisma;
    return client.customerWeightApprovalChallenge.findFirst({
      where: { weightAdjustmentId, measurementRevision },
      orderBy: { challengeSequence: 'desc' },
    });
  }

  /**
   * Returns all historical challenges for an adjustment for audit traceability.
   */
  async findAllChallengesForAdjustment(
    weightAdjustmentId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomerWeightApprovalChallenge[]> {
    const client = tx ?? this.prisma;
    return client.customerWeightApprovalChallenge.findMany({
      where: { weightAdjustmentId },
      orderBy: [{ measurementRevision: 'asc' }, { challengeSequence: 'asc' }],
    });
  }

  update(): never {
    throw new ImmutableAuditMutationError('CustomerWeightApprovalChallenge', 'CANNOT_UPDATE_ARBITRARY');
  }

  delete(): never {
    throw new ImmutableAuditMutationError('CustomerWeightApprovalChallenge', 'CANNOT_DELETE');
  }
}
