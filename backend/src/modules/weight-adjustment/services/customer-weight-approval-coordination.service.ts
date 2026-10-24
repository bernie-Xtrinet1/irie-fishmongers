import { Injectable, Logger } from '@nestjs/common';
import {
  ApprovalChallengeStatus,
  CustomerApprovalAction,
  CustomerWeightApprovalStatus,
  Prisma,
  UserStatus,
  WeightMeasurementStatus,
} from '@prisma/client';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../database/prisma.service';
import {
  AdjustmentNotFoundError,
  ChallengeNotFoundError,
  CustomerApprovalMismatchError,
} from '../repositories/errors/weight-adjustment-repository.errors';
import { CustomerWeightApprovalChallengeRepository } from '../repositories/customer-weight-approval-challenge.repository';
import { CustomerWeightConsentRepository } from '../repositories/customer-weight-consent.repository';
import { SeafoodOrderWeightAdjustmentRepository } from '../repositories/seafood-order-weight-adjustment.repository';
import { hashApprovalToken } from '../repositories/utils/canonical-hash.util';
import {
  CustomerApprovalCoordinationResult,
  ProcessCustomerApprovalInput,
  StaleApprovalRevisionError,
  UnauthorizedApprovalCustomerError,
} from './types/weight-adjustment-coordination.types';

@Injectable()
export class CustomerWeightApprovalCoordinationService {
  private readonly logger = new Logger(CustomerWeightApprovalCoordinationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly challengeRepo: CustomerWeightApprovalChallengeRepository,
    private readonly consentRepo: CustomerWeightConsentRepository,
    private readonly adjustmentRepo: SeafoodOrderWeightAdjustmentRepository,
  ) {}

  /**
   * Processes a customer approval decision (APPROVED or REJECTED) for a weight adjustment.
   *
   * Invariants enforced:
   * 1. Requires trusted authenticated actor matching the order's customer ID.
   * 2. Confirms active user status of the authenticated customer.
   * 3. Binds strictly to the active measurement revision (superseded revisions fail closed).
   * 4. Verifies cryptographic approval token challenge against SHA-256 hash.
   * 5. Atomically consumes challenge and records immutable approval decision in one transaction.
   * 6. Replays idempotently if exact token hash and decision were already persisted.
   * 7. Distinguishes customer agreement from financial settlement (obligation remains PENDING).
   * 8. Uses customer's explicitly authorized ceiling; never synthesizes automatic tolerance.
   */
  async processCustomerApproval(
    input: ProcessCustomerApprovalInput,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomerApprovalCoordinationResult> {
    // 1. Authenticated Actor Pre-condition Check
    if (!input.authenticatedActor || !input.authenticatedActor.id) {
      throw new UnauthorizedApprovalCustomerError(
        'Missing trusted authentication context: authenticated actor must be provided.',
      );
    }

    if (!input.rawApprovalToken || input.rawApprovalToken.trim() === '') {
      throw new UnauthorizedApprovalCustomerError('Approval token is required.');
    }

    const tokenHash = hashApprovalToken(input.rawApprovalToken);

    const executeInTransaction = async (txClient: Prisma.TransactionClient): Promise<CustomerApprovalCoordinationResult> => {
      // 2. Verify User Active Status
      const user = await txClient.user.findUnique({
        where: { id: input.authenticatedActor.id },
        select: { id: true, status: true },
      });

      if (!user || user.status !== UserStatus.ACTIVE) {
        throw new UnauthorizedApprovalCustomerError(
          `Customer "${input.authenticatedActor.id}" is not an active authenticated platform user.`,
        );
      }

      // 3. Load Parent Weight Adjustment with Order Context
      const adjustment = await txClient.seafoodOrderWeightAdjustment.findUnique({
        where: { id: input.weightAdjustmentId },
        include: {
          orderItem: {
            include: {
              vendorOrder: {
                include: {
                  order: {
                    select: {
                      id: true,
                      customerId: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!adjustment) {
        throw new AdjustmentNotFoundError(input.weightAdjustmentId);
      }

      // 4. Verify Customer Order Ownership
      const orderCustomerId = adjustment.orderItem?.vendorOrder?.order?.customerId;
      if (!orderCustomerId || orderCustomerId !== input.authenticatedActor.id) {
        throw new UnauthorizedApprovalCustomerError(
          `Customer "${input.authenticatedActor.id}" is not authorized for order belonging to customer "${orderCustomerId}". Exact order ownership required.`,
        );
      }

      // 5. Verify Active Measurement Revision
      const activeRevision = adjustment.activeMeasurementRevision ?? 0;
      if (input.measurementRevision !== activeRevision) {
        throw new StaleApprovalRevisionError(
          input.weightAdjustmentId,
          input.measurementRevision,
          activeRevision,
        );
      }

      if (
        adjustment.measurementStatus !== WeightMeasurementStatus.MEASURED_WITHIN_CEILING &&
        adjustment.measurementStatus !== WeightMeasurementStatus.MEASURED_EXCEEDS_CEILING &&
        adjustment.measurementStatus !== WeightMeasurementStatus.SETTLED
      ) {
        throw new StaleApprovalRevisionError(
          input.weightAdjustmentId,
          input.measurementRevision,
          activeRevision,
        );
      }

      // 6. Idempotent Replay Check: If already decided for this revision, verify exact match
      const existingApproval = await this.consentRepo.findApprovalByRevision(
        input.weightAdjustmentId,
        input.measurementRevision,
        txClient,
      );

      if (existingApproval) {
        if (
          existingApproval.approvalTokenHash === tokenHash &&
          existingApproval.action === input.action
        ) {
          const latestChallenge = await this.challengeRepo.findLatestChallenge(
            input.weightAdjustmentId,
            input.measurementRevision,
            txClient,
          );
          return {
            status: 'IDEMPOTENT_REPLAY',
            weightAdjustment: adjustment,
            approvalRecord: existingApproval,
            challengeId: latestChallenge?.id ?? '',
            isReplay: true,
          };
        }
        throw new CustomerApprovalMismatchError(
          `Approval decision for adjustment "${input.weightAdjustmentId}" revision ${input.measurementRevision} has already been recorded under a different token or action.`,
        );
      }

      // 7. Resolve Challenge by Token Hash
      const challenge = await this.challengeRepo.findByTokenHash(tokenHash, txClient);
      if (!challenge) {
        throw new ChallengeNotFoundError(`tokenHash:${tokenHash}`);
      }

      if (challenge.weightAdjustmentId !== input.weightAdjustmentId) {
        throw new CustomerApprovalMismatchError(
          `Approval challenge "${challenge.id}" belongs to a different weight adjustment.`,
        );
      }

      if (challenge.measurementRevision !== input.measurementRevision) {
        throw new StaleApprovalRevisionError(
          input.weightAdjustmentId,
          input.measurementRevision,
          challenge.measurementRevision,
        );
      }

      // 8. Atomic Challenge Consumption
      const proposedTotal = adjustment.finalItemTotal
        ? new Decimal(adjustment.finalItemTotal.toString())
        : new Decimal(0);
      const authorizedCeiling = new Decimal(adjustment.customerAuthorizedCeilingJmd.toString());

      const consumedChallenge = await this.challengeRepo.consumeChallenge(
        {
          challengeId: challenge.id,
          expectedMeasurementRevision: input.measurementRevision,
          authenticatedCustomerId: input.authenticatedActor.id,
          expectedProposedTotalJmd: proposedTotal,
          expectedAuthorizedCeilingJmd: authorizedCeiling,
        },
        txClient,
      );

      // 9. Atomic Approval Record Insertion & Parent Adjustment Update
      const record = await this.consentRepo.recordCustomerApproval(
        {
          weightAdjustmentId: input.weightAdjustmentId,
          measurementRevision: input.measurementRevision,
          authenticatedCustomerId: input.authenticatedActor.id,
          rawApprovalToken: input.rawApprovalToken,
          proposedTotalJmd: proposedTotal,
          authorizedCeilingJmd: authorizedCeiling,
          action: input.action,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          rejectionReason: input.rejectionReason,
        },
        txClient,
      );

      // 10. Fetch Updated Adjustment
      const updatedAdjustment = await txClient.seafoodOrderWeightAdjustment.findUniqueOrThrow({
        where: { id: input.weightAdjustmentId },
      });

      const coordinationStatus =
        input.action === CustomerApprovalAction.APPROVED ? 'APPROVED' : 'REJECTED';

      return {
        status: coordinationStatus,
        weightAdjustment: updatedAdjustment,
        approvalRecord: record,
        challengeId: consumedChallenge.id,
        isReplay: false,
      };
    };

    if (tx) {
      return await executeInTransaction(tx);
    }
    return await this.prisma.$transaction(executeInTransaction);
  }
}
