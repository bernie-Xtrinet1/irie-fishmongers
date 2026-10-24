import { Injectable, Logger } from '@nestjs/common';
import {
  ObligationStatus,
  PaymentObligationDirection,
  Prisma,
  RoleName,
  SettlementChannel,
  UserStatus,
  WeightAdjustmentObligation,
  WeightAdjustmentSettlementRecord,
} from '@prisma/client';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../database/prisma.service';
import {
  AdjustmentNotFoundError,
  InvalidSettlementAmountError,
} from '../repositories/errors/weight-adjustment-repository.errors';
import {
  FinancialEvidenceClassification,
  PERMITTED_SETTLEMENT_CHANNELS_BY_DIRECTION,
  WeightFinancialObligationRepository,
} from '../repositories/weight-financial-obligation.repository';
import {
  DormantSettlementChannelError,
  FinancialSettlementCoordinationResult,
  InvalidSettlementEvidenceError,
  ObligationBalanceSummary,
  RecordFinancialSettlementInput,
  UnauthorizedSettlementOperatorError,
} from './types/weight-adjustment-coordination.types';

@Injectable()
export class WeightAdjustmentSettlementService {
  private readonly logger = new Logger(WeightAdjustmentSettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly obligationRepo: WeightFinancialObligationRepository,
  ) {}

  /**
   * Records financial settlement evidence against an immutable weight adjustment obligation.
   *
   * Invariants enforced:
   * 1. Requires trusted authenticated actor with active platform status.
   * 2. Rejects dormant settlement channels (WIPAY_SECONDARY_PAYMENT_CONFIRMED is dormant in WP3.4).
   * 3. Directional channel enforcement (credit memos only for customer credits; COD/absorption for supplemental).
   * 4. COD receipt requires authenticated driver collection reference and evidence document.
   * 5. Vendor absorption represents vendor write-off waiver, not customer cash payment.
   * 6. Admin credit memo represents platform accounting credit, not cash refund.
   * 7. Decimal cumulative balance cannot be exceeded; duplicate submissions are idempotent.
   * 8. Atomically updates settlement evidence and transitions obligation status to SETTLED upon exact discharge.
   */
  async recordSettlement(
    input: RecordFinancialSettlementInput,
    tx?: Prisma.TransactionClient,
  ): Promise<FinancialSettlementCoordinationResult> {
    // 1. Authenticated Actor Verification
    if (!input.authenticatedActor || !input.authenticatedActor.id) {
      throw new UnauthorizedSettlementOperatorError(
        'Missing trusted authentication context: authenticated actor must be provided.',
      );
    }

    if (input.settlementChannel === SettlementChannel.WIPAY_SECONDARY_PAYMENT_CONFIRMED) {
      throw new DormantSettlementChannelError(
        input.settlementChannel,
        'Settlement channel "WIPAY_SECONDARY_PAYMENT_CONFIRMED" is dormant and unsupported in WP3.4: secondary hosted capture and automated background debits are not active.',
      );
    }

    let parsedAmount: Decimal;
    try {
      parsedAmount = new Decimal(input.amountSettled);
    } catch {
      throw new InvalidSettlementAmountError('Settlement amount must be a valid numeric value.');
    }
    if (parsedAmount.isNaN() || !parsedAmount.isFinite() || parsedAmount.lessThanOrEqualTo(0)) {
      throw new InvalidSettlementAmountError('Settlement amount must be a positive finite number.');
    }

    const executeInTransaction = async (
      txClient: Prisma.TransactionClient,
    ): Promise<FinancialSettlementCoordinationResult> => {
      // 2. Verify User Status & Roles
      const user = await txClient.user.findUnique({
        where: { id: input.authenticatedActor.id },
        include: { roles: { include: { role: true } } },
      });

      if (!user || user.status !== UserStatus.ACTIVE) {
        throw new UnauthorizedSettlementOperatorError(
          `Operator "${input.authenticatedActor.id}" is not an active authenticated platform user.`,
        );
      }

      const roleNames = user.roles.map((r) => r.role.name);
      const isAdmin = roleNames.includes(RoleName.ADMINISTRATOR);
      const isDriver = roleNames.includes(RoleName.DRIVER);
      const isVendor = roleNames.includes(RoleName.VENDOR);
      const isFisherman = roleNames.includes(RoleName.FISHERMAN);

      // 3. Resolve Obligation with Weight Adjustment & Order Context
      const obligation = await txClient.weightAdjustmentObligation.findUnique({
        where: { id: input.obligationId },
        include: {
          weightAdjustment: {
            include: {
              orderItem: {
                include: {
                  vendorOrder: {
                    include: {
                      vendor: true,
                      delivery: {
                        include: {
                          driver: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!obligation) {
        throw new AdjustmentNotFoundError(`Obligation ID "${input.obligationId}"`);
      }

      // 4. Channel-Specific Role & Evidence Rules
      if (input.settlementChannel === SettlementChannel.COD_DOORSTEP_RECEIPT) {
        const vendorOrder = obligation.weightAdjustment.orderItem?.vendorOrder;
        const delivery = vendorOrder?.delivery;

        if (!delivery) {
          throw new UnauthorizedSettlementOperatorError(
            `No delivery record found for VendorOrder "${vendorOrder?.id ?? 'unknown'}". COD doorstep collection requires an assigned delivery.`,
          );
        }

        const assignedDriverUserId = delivery.driver?.userId;
        if (!assignedDriverUserId) {
          throw new UnauthorizedSettlementOperatorError(
            `No driver assigned to delivery "${delivery.id}". COD doorstep collection requires an assigned driver.`,
          );
        }

        if (input.authenticatedActor.id !== assignedDriverUserId) {
          throw new UnauthorizedSettlementOperatorError(
            `Operator "${input.authenticatedActor.id}" is not the driver specifically assigned to delivery "${delivery.id}". Generic administrator or unrelated driver submission is prohibited.`,
          );
        }

        if (!isDriver) {
          throw new UnauthorizedSettlementOperatorError(
            `Operator "${input.authenticatedActor.id}" does not hold DRIVER role for COD doorstep receipt.`,
          );
        }

        if (!input.externalReference || input.externalReference.trim() === '') {
          throw new InvalidSettlementEvidenceError(
            'Driver physical receipt reference / ticket number is required for COD doorstep collection.',
          );
        }
        if (!input.evidenceDocumentUrl || input.evidenceDocumentUrl.trim() === '') {
          throw new InvalidSettlementEvidenceError(
            'Signed delivery / collection evidence document URL is required for COD doorstep collection.',
          );
        }
      } else if (input.settlementChannel === SettlementChannel.VENDOR_ABSORPTION) {
        const vendorOwnerUserId = obligation.weightAdjustment.orderItem?.vendorOrder?.vendor?.userId;
        const isVendorOwner = vendorOwnerUserId && input.authenticatedActor.id === vendorOwnerUserId;
        if (!isVendorOwner && !isAdmin) {
          throw new UnauthorizedSettlementOperatorError(
            `Operator "${input.authenticatedActor.id}" is not authorized for vendor absorption. Only the vendor account owner or ADMINISTRATOR may waive excess charges.`,
          );
        }
        if (!input.externalReference || input.externalReference.trim() === '') {
          throw new InvalidSettlementEvidenceError(
            'A documented concession reason / waiver note is required for vendor absorption.',
          );
        }
      } else if (input.settlementChannel === SettlementChannel.ADMIN_CREDIT_MEMO_ISSUED) {
        if (!isAdmin) {
          throw new UnauthorizedSettlementOperatorError(
            `Operator "${input.authenticatedActor.id}" does not hold ADMINISTRATOR role. Only platform administrators may issue customer store credit memos.`,
          );
        }
        if (!input.externalReference || input.externalReference.trim() === '') {
          throw new InvalidSettlementEvidenceError(
            'Credit memo document number (e.g., CM-XXXX) is required for administrative credit memo issuance.',
          );
        }
      }

      // 5. Record Settlement Evidence via WP2 Repository
      const { settlement, isReplay } = await this.obligationRepo.recordSettlementEvidence(
        {
          obligationId: input.obligationId,
          idempotencyKey: input.idempotencyKey,
          settlementChannel: input.settlementChannel,
          amountSettled: parsedAmount,
          externalReference: input.externalReference,
          evidenceDocumentUrl: input.evidenceDocumentUrl,
          settledByUserId: input.authenticatedActor.id,
        },
        txClient,
      );

      // 6. Compute Remaining Balance & Discharge Status
      const balanceSummary = await this.obligationRepo.getObligationBalance(
        input.obligationId,
        txClient,
      );

      const classification = this.obligationRepo.classifySettlementRecord(input.settlementChannel);

      const updatedObligation = await txClient.weightAdjustmentObligation.findUniqueOrThrow({
        where: { id: input.obligationId },
      });

      return {
        settlementRecord: settlement,
        obligation: updatedObligation,
        evidenceClassification: classification,
        isFullySettled: balanceSummary.isFullySettled,
        remainingBalanceJmd: balanceSummary.remainingBalanceJmd,
        isReplay,
      };
    };

    if (tx) {
      return await executeInTransaction(tx);
    }
    return await this.prisma.$transaction(executeInTransaction);
  }

  /**
   * Retrieves accurate outstanding balance and discharge status for an obligation.
   */
  async getObligationBalance(
    obligationId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ObligationBalanceSummary> {
    return this.obligationRepo.getObligationBalance(obligationId, tx);
  }

  /**
   * Retrieves all obligations associated with a weight adjustment.
   */
  async findObligationsByAdjustmentId(
    weightAdjustmentId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WeightAdjustmentObligation[]> {
    return this.obligationRepo.findObligationsByAdjustmentId(weightAdjustmentId, tx);
  }
}
