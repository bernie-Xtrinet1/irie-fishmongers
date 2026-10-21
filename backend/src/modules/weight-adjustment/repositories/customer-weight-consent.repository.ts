import { Injectable } from '@nestjs/common';
import {
  CustomerApprovalAction,
  CustomerCheckoutCeilingConsent,
  CustomerWeightApprovalRecord,
  CustomerWeightApprovalStatus,
  Prisma,
} from '@prisma/client';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../database/prisma.service';
import {
  RecordCheckoutConsentInput,
  RecordCustomerApprovalInput,
} from './types/weight-adjustment-repository.types';
import { computeCanonicalPayloadHash, hashApprovalToken } from './utils/canonical-hash.util';
import {
  AdjustmentNotFoundError,
  CustomerApprovalRevisionMismatchError,
  ImmutableAuditMutationError,
} from './errors/weight-adjustment-repository.errors';

@Injectable()
export class CustomerWeightConsentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records immutable checkout ceiling consent captured at initial order placement.
   */
  async recordCheckoutCeilingConsent(
    input: RecordCheckoutConsentInput,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomerCheckoutCeilingConsent> {
    const client = tx ?? this.prisma;

    const payloadForHashing = {
      weightAdjustmentId: input.weightAdjustmentId,
      authenticatedCustomerId: input.authenticatedCustomerId,
      initialEstimatedWeight: new Decimal(input.initialEstimatedWeight).toFixed(3),
      initialEstimatedTotal: new Decimal(input.initialEstimatedTotal).toFixed(2),
      authorizedCeilingJmd: new Decimal(input.authorizedCeilingJmd).toFixed(2),
      termsVersion: input.termsVersion,
    };
    const payloadHash = computeCanonicalPayloadHash(payloadForHashing);

    return client.customerCheckoutCeilingConsent.create({
      data: {
        weightAdjustmentId: input.weightAdjustmentId,
        authenticatedCustomerId: input.authenticatedCustomerId,
        initialEstimatedWeight: new Prisma.Decimal(new Decimal(input.initialEstimatedWeight).toFixed(3)),
        initialEstimatedTotal: new Prisma.Decimal(new Decimal(input.initialEstimatedTotal).toFixed(2)),
        authorizedCeilingJmd: new Prisma.Decimal(new Decimal(input.authorizedCeilingJmd).toFixed(2)),
        termsVersion: input.termsVersion,
        payloadHash,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
    });
  }

  async findCheckoutConsent(
    weightAdjustmentId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomerCheckoutCeilingConsent | null> {
    const client = tx ?? this.prisma;
    return client.customerCheckoutCeilingConsent.findUnique({
      where: { weightAdjustmentId },
    });
  }

  /**
   * Records an immutable customer decision for an adjustment that exceeds authorized ceiling.
   * - Binds strictly to authenticated customer identity and exact measurement revision.
   * - Stores ONLY cryptographic SHA-256 token hash, never plaintext token.
   * - Transitions parent customerApprovalStatus atomically.
   */
  async recordCustomerApproval(
    input: RecordCustomerApprovalInput,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomerWeightApprovalRecord> {
    const client = tx ?? this.prisma;

    // 1. Validate parent adjustment active measurement revision
    const adjustment = await client.seafoodOrderWeightAdjustment.findUnique({
      where: { id: input.weightAdjustmentId },
      select: { activeMeasurementRevision: true },
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

    // 2. Hash token and compute payload hash
    const approvalTokenHash = hashApprovalToken(input.rawApprovalToken);
    const payloadForHashing = {
      weightAdjustmentId: input.weightAdjustmentId,
      measurementRevision: input.measurementRevision,
      authenticatedCustomerId: input.authenticatedCustomerId,
      proposedTotalJmd: new Decimal(input.proposedTotalJmd).toFixed(2),
      authorizedCeilingJmd: new Decimal(input.authorizedCeilingJmd).toFixed(2),
      action: input.action,
      approvalTokenHash,
    };
    const payloadHash = computeCanonicalPayloadHash(payloadForHashing);

    // 3. Insert immutable approval record
    const record = await client.customerWeightApprovalRecord.create({
      data: {
        weightAdjustmentId: input.weightAdjustmentId,
        measurementRevision: input.measurementRevision,
        authenticatedCustomerId: input.authenticatedCustomerId,
        proposedTotalJmd: new Prisma.Decimal(new Decimal(input.proposedTotalJmd).toFixed(2)),
        authorizedCeilingJmd: new Prisma.Decimal(new Decimal(input.authorizedCeilingJmd).toFixed(2)),
        action: input.action,
        approvalTokenHash,
        payloadHash,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        rejectionReason: input.rejectionReason,
      },
    });

    // 4. Update parent adjustment approval status
    let newStatus: CustomerWeightApprovalStatus;
    let boundRev: number | null = null;

    if (input.action === CustomerApprovalAction.APPROVED) {
      newStatus = CustomerWeightApprovalStatus.APPROVED_BY_CUSTOMER;
      boundRev = input.measurementRevision;
    } else if (input.action === CustomerApprovalAction.REJECTED) {
      newStatus = CustomerWeightApprovalStatus.REJECTED_BY_CUSTOMER;
    } else {
      newStatus = CustomerWeightApprovalStatus.AUTO_EXPIRED;
    }

    await client.seafoodOrderWeightAdjustment.update({
      where: { id: input.weightAdjustmentId },
      data: {
        customerApprovalStatus: newStatus,
        boundApprovalRevision: boundRev,
      },
    });

    return record;
  }

  async findApprovalByRevision(
    weightAdjustmentId: string,
    measurementRevision: number,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomerWeightApprovalRecord | null> {
    const client = tx ?? this.prisma;
    return client.customerWeightApprovalRecord.findUnique({
      where: {
        uq_approval_adj_revision: {
          weightAdjustmentId,
          measurementRevision,
        },
      },
    });
  }

  update(): never {
    throw new ImmutableAuditMutationError('CustomerCheckoutCeilingConsent / CustomerWeightApprovalRecord', 'CANNOT_UPDATE');
  }

  delete(): never {
    throw new ImmutableAuditMutationError('CustomerCheckoutCeilingConsent / CustomerWeightApprovalRecord', 'CANNOT_DELETE');
  }
}
