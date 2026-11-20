import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import {
  Prisma,
  RefundAllocationEntryKind,
  RefundAllocationType,
  RefundStatus,
  VendorLiabilityCategory,
  VendorLiabilityDecision,
  VendorReceivable,
  VendorReceivableRecovery,
  VendorReceivableRecoveryType,
  VendorReceivableStatus,
  VendorReceivableWriteOff,
  VendorSettlementDisbursementStatus,
  VendorSettlementStatus,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { parseExactMonetary2dp } from '../utils/cent-distribution.util';

const VENDOR_FAULT_CATEGORIES = new Set<VendorLiabilityCategory>([
  VendorLiabilityCategory.VENDOR_CANCELLED_ORDER,
  VendorLiabilityCategory.VENDOR_ITEM_DEFECT,
  VendorLiabilityCategory.VENDOR_FULFILLMENT_SHORTFALL,
  VendorLiabilityCategory.CONTRACTUAL_VENDOR_RETURN,
]);

export interface CreateVendorReceivableDto {
  allocationId: string;
  vendorId: string;
  settlementId: string;
  grossAllocatedAmount: Prisma.Decimal | number | string;
  commissionReversedAmount: Prisma.Decimal | number | string;
  originalAmount: Prisma.Decimal | number | string;
  currency?: string;
  notes?: string;
}

export interface CreateVendorReceivableRecoveryDto {
  receivableId: string;
  amount: Prisma.Decimal | number | string;
  recoveryType: VendorReceivableRecoveryType;
  targetAdjustmentId?: string;
  externalReference?: string | null;
  collectedAt?: Date | string | null;
  idempotencyKey?: string;
  notes?: string;
}

export interface CreateVendorReceivableWriteOffDto {
  receivableId: string;
  amount: Prisma.Decimal | number | string;
  reason: string;
  idempotencyKey?: string;
}

export interface ReceivableBalanceSummary {
  receivableId: string;
  originalAmount: Prisma.Decimal;
  recoveredAmount: Prisma.Decimal;
  writtenOffAmount: Prisma.Decimal;
  outstandingAmount: Prisma.Decimal;
  status: VendorReceivableStatus;
}

@Injectable()
export class VendorReceivablesRepository {
  constructor(private readonly prisma: PrismaService) {}

  private async runInTx<T>(
    tx: Prisma.TransactionClient | undefined,
    fn: (client: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (tx) {
      return fn(tx);
    }
    return this.prisma.$transaction(fn);
  }

  /**
   * Create a new VendorReceivable record.
   * Acquires canonical top-down locks and verifies allocation, refund COMPLETED status,
   * VENDOR_RESPONSIBLE determination, CONFIRMED disbursement, non-double-recognition,
   * and exact cumulative math bounds before inserting.
   */
  async createReceivable(
    dto: CreateVendorReceivableDto,
    tx?: Prisma.TransactionClient,
  ): Promise<VendorReceivable> {
    const gross = parseExactMonetary2dp(dto.grossAllocatedAmount, 'grossAllocatedAmount', {
      allowZero: false,
      allowNegative: false,
    });
    const fee = parseExactMonetary2dp(dto.commissionReversedAmount, 'commissionReversedAmount', {
      allowZero: true,
      allowNegative: false,
    });
    const original = parseExactMonetary2dp(dto.originalAmount, 'originalAmount', {
      allowZero: false,
      allowNegative: false,
    });

    const expectedOriginal = gross.minus(fee);
    if (!original.equals(expectedOriginal)) {
      throw new BadRequestException(
        `Receivable originalAmount (${original}) does not equal gross (${gross}) - fee (${fee}) = ${expectedOriginal}`,
      );
    }

    return this.runInTx(tx, async (client) => {
      const allocMeta = await client.refundVendorOrderAllocation.findUnique({
        where: { id: dto.allocationId },
        select: {
          id: true,
          vendorOrderId: true,
          refundId: true,
          vendorOrder: { select: { orderId: true } },
          refund: { select: { paymentId: true } },
        },
      });
      if (!allocMeta) {
        throw new NotFoundException(`Allocation ${dto.allocationId} not found`);
      }

      const settlementMeta = await client.vendorSettlement.findUnique({
        where: { id: dto.settlementId },
        select: {
          id: true,
          vendorOrderId: true,
          vendorOrder: { select: { orderId: true } },
        },
      });
      if (!settlementMeta) {
        throw new NotFoundException(`VendorSettlement ${dto.settlementId} not found`);
      }

      if (allocMeta.vendorOrderId !== settlementMeta.vendorOrderId) {
        throw new BadRequestException(
          `Allocation vendorOrderId (${allocMeta.vendorOrderId}) does not match settlement vendorOrderId (${settlementMeta.vendorOrderId})`,
        );
      }

      // Canonical top-down locks: orders -> vendor_orders -> payments -> refunds -> allocations -> vendor_settlements
      await client.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${allocMeta.vendorOrder.orderId} FOR UPDATE`;
      await client.$queryRaw`SELECT "id" FROM "vendor_orders" WHERE "id" = ${allocMeta.vendorOrderId} FOR UPDATE`;
      await client.$queryRaw`SELECT "id" FROM "payments" WHERE "id" = ${allocMeta.refund.paymentId} FOR UPDATE`;
      await client.$queryRaw`SELECT "id" FROM "refunds" WHERE "id" = ${allocMeta.refundId} FOR UPDATE`;
      await client.$queryRaw`SELECT "id" FROM "refund_vendor_order_allocations" WHERE "id" = ${dto.allocationId} FOR UPDATE`;
      await client.$queryRaw`SELECT "id" FROM "vendor_settlements" WHERE "id" = ${dto.settlementId} FOR UPDATE`;

      const existing = await client.vendorReceivable.findUnique({
        where: { allocationId: dto.allocationId },
      });
      if (existing) {
        throw new ConflictException(
          `VendorReceivable for allocation ${dto.allocationId} already exists`,
        );
      }

      const alloc = await client.refundVendorOrderAllocation.findUniqueOrThrow({
        where: { id: dto.allocationId },
        include: {
          vendorOrder: true,
          refund: { include: { payment: true } },
          reversedBy: true,
          liabilityDetermination: true,
        },
      });

      const settlement = await client.vendorSettlement.findUniqueOrThrow({
        where: { id: dto.settlementId },
        include: {
          disbursements: true,
        },
      });

      if (dto.vendorId !== settlement.vendorId || alloc.vendorOrder.vendorId !== settlement.vendorId) {
        throw new BadRequestException(
          `Receivable vendorId (${dto.vendorId}) must match settlement (${settlement.vendorId}) and vendorOrder (${alloc.vendorOrder.vendorId}) vendorId`,
        );
      }

      if (alloc.refund.payment.orderId !== alloc.vendorOrder.orderId) {
        throw new BadRequestException(
          `Payment order (${alloc.refund.payment.orderId}) does not match vendorOrder order (${alloc.vendorOrder.orderId})`,
        );
      }

      const targetCurrency = dto.currency ?? alloc.currency;
      if (targetCurrency !== alloc.currency || targetCurrency !== alloc.refund.payment.currency) {
        throw new BadRequestException(
          `Receivable currency (${targetCurrency}) must match allocation (${alloc.currency}) and payment (${alloc.refund.payment.currency}) currency`,
        );
      }

      if (alloc.refund.status !== RefundStatus.COMPLETED) {
        throw new BadRequestException(
          `VendorReceivable requires COMPLETED refund, got ${alloc.refund.status}`,
        );
      }

      if (alloc.entryKind !== RefundAllocationEntryKind.ALLOCATION) {
        throw new BadRequestException(
          `VendorReceivable requires ALLOCATION entryKind, got ${alloc.entryKind}`,
        );
      }

      const reversedAmt = alloc.reversedBy
        ? new Prisma.Decimal(alloc.reversedBy.amount)
        : new Prisma.Decimal('0.00');
      const netActiveAlloc = new Prisma.Decimal(alloc.amount).plus(reversedAmt);
      if (netActiveAlloc.lte(0)) {
        throw new BadRequestException(
          `Cannot create VendorReceivable for reversed allocation ${dto.allocationId}`,
        );
      }
      if (!gross.equals(netActiveAlloc)) {
        throw new BadRequestException(
          `Receivable grossAllocatedAmount (${gross}) must equal net active allocation amount (${netActiveAlloc})`,
        );
      }

      const determination = alloc.liabilityDetermination;
      if (
        !determination ||
        determination.decision !== VendorLiabilityDecision.VENDOR_RESPONSIBLE
      ) {
        throw new BadRequestException(
          `Allocation ${dto.allocationId} lacks a VENDOR_RESPONSIBLE determination`,
        );
      }
      if (!VENDOR_FAULT_CATEGORIES.has(determination.category)) {
        throw new BadRequestException(
          `Determination category "${determination.category}" is not a vendor responsibility category`,
        );
      }
      if (
        alloc.allocationType === RefundAllocationType.MANUAL_SUPERVISOR_ADJUSTMENT &&
        (!determination.evidenceReference || determination.evidenceReference.trim().length === 0)
      ) {
        throw new BadRequestException(
          `MANUAL_SUPERVISOR_ADJUSTMENT allocation ${dto.allocationId} requires non-empty determination evidenceReference`,
        );
      }

      if (settlement.status !== VendorSettlementStatus.PAID) {
        throw new BadRequestException(
          `VendorReceivable requires PAID settlement, got ${settlement.status}`,
        );
      }

      const validConfirmedDisbursements = settlement.disbursements.filter(
        (d) =>
          d.status === VendorSettlementDisbursementStatus.CONFIRMED &&
          d.vendorId === settlement.vendorId &&
          d.currency === targetCurrency &&
          new Prisma.Decimal(d.amount).gt(0) &&
          typeof d.externalReference === 'string' &&
          d.externalReference.trim().length > 0 &&
          d.confirmedAt !== null,
      );
      if (validConfirmedDisbursements.length === 0) {
        throw new BadRequestException(
          `Settlement ${dto.settlementId} lacks a valid CONFIRMED VendorSettlementDisbursement`,
        );
      }

      const confirmedDisbursedTotal = validConfirmedDisbursements.reduce(
        (acc, d) => acc.plus(new Prisma.Decimal(d.amount)),
        new Prisma.Decimal('0.00'),
      );

      const adjSumAgg = await client.vendorSettlementAdjustment.aggregate({
        where: { settlementId: dto.settlementId },
        _sum: { amount: true },
      });
      const adjustedEntitlement = new Prisma.Decimal(settlement.netAmount).plus(
        new Prisma.Decimal(adjSumAgg._sum.amount ?? 0),
      );
      if (adjustedEntitlement.lte(0) || confirmedDisbursedTotal.gt(adjustedEntitlement)) {
        throw new BadRequestException(
          `Settlement ${dto.settlementId} confirmed disbursement total (${confirmedDisbursedTotal}) exceeds adjusted payable entitlement (${adjustedEntitlement})`,
        );
      }

      const conflictingAdj = await client.vendorSettlementAdjustment.findFirst({
        where: {
          settlementId: dto.settlementId,
          amount: { lt: 0 },
          OR: [{ allocationId: dto.allocationId }, { refundId: alloc.refundId }],
        },
      });
      if (conflictingAdj) {
        throw new ConflictException(
          `Double-recognition blocked: negative adjustment ${conflictingAdj.id} already recognizes settlement ${dto.settlementId} refund ${alloc.refundId}`,
        );
      }

      const existingSums = await client.vendorReceivable.aggregate({
        where: { settlementId: dto.settlementId },
        _sum: {
          grossAllocatedAmount: true,
          commissionReversedAmount: true,
          originalAmount: true,
        },
      });
      const cumGross = new Prisma.Decimal(existingSums._sum.grossAllocatedAmount ?? 0).plus(gross);
      const cumFee = new Prisma.Decimal(existingSums._sum.commissionReversedAmount ?? 0).plus(fee);
      const cumOriginal = new Prisma.Decimal(existingSums._sum.originalAmount ?? 0).plus(original);

      if (cumGross.gt(new Prisma.Decimal(settlement.grossAmount))) {
        throw new BadRequestException(
          `Cumulative receivable gross (${cumGross}) exceeds settlement grossAmount (${settlement.grossAmount})`,
        );
      }
      if (cumFee.gt(new Prisma.Decimal(settlement.platformFee))) {
        throw new BadRequestException(
          `Cumulative receivable commission (${cumFee}) exceeds settlement platformFee (${settlement.platformFee})`,
        );
      }
      if (cumOriginal.gt(confirmedDisbursedTotal)) {
        throw new BadRequestException(
          `Cumulative receivable exposure (${cumOriginal}) exceeds confirmed disbursement amount (${confirmedDisbursedTotal}) on settlement ${dto.settlementId}`,
        );
      }

      try {
        return await client.vendorReceivable.create({
          data: {
            allocationId: dto.allocationId,
            vendorId: dto.vendorId,
            settlementId: dto.settlementId,
            grossAllocatedAmount: gross,
            commissionReversedAmount: fee,
            originalAmount: original,
            currency: targetCurrency,
            status: VendorReceivableStatus.OPEN,
            notes: dto.notes,
          },
        });
      } catch (err: any) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException(
            `VendorReceivable for allocation ${dto.allocationId} already exists`,
          );
        }
        throw err;
      }
    });
  }

  /**
   * Find a receivable by ID with its recoveries and write-offs
   */
  async findById(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<
    | (VendorReceivable & {
        recoveries: VendorReceivableRecovery[];
        writeOffs: VendorReceivableWriteOff[];
      })
    | null
  > {
    const client = tx || this.prisma;
    return client.vendorReceivable.findUnique({
      where: { id },
      include: {
        recoveries: { orderBy: { createdAt: 'asc' } },
        writeOffs: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  /**
   * Find a receivable by allocation ID
   */
  async findByAllocationId(
    allocationId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<
    | (VendorReceivable & {
        recoveries: VendorReceivableRecovery[];
        writeOffs: VendorReceivableWriteOff[];
      })
    | null
  > {
    const client = tx || this.prisma;
    return client.vendorReceivable.findUnique({
      where: { allocationId },
      include: {
        recoveries: { orderBy: { createdAt: 'asc' } },
        writeOffs: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  /**
   * List receivables by vendor ID with optional status filter
   */
  async findByVendorId(
    vendorId: string,
    status?: VendorReceivableStatus,
    tx?: Prisma.TransactionClient,
  ): Promise<VendorReceivable[]> {
    const client = tx || this.prisma;
    return client.vendorReceivable.findMany({
      where: {
        vendorId,
        ...(status ? { status } : {}),
      },
      include: { recoveries: true, writeOffs: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findWriteOffsByReceivableId(
    receivableId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<VendorReceivableWriteOff[]> {
    const client = tx || this.prisma;
    return client.vendorReceivableWriteOff.findMany({
      where: { receivableId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Get outstanding balance summary for a receivable
   */
  async getOutstandingBalance(
    receivableId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ReceivableBalanceSummary> {
    const client = tx || this.prisma;
    const r = await client.vendorReceivable.findUniqueOrThrow({
      where: { id: receivableId },
    });

    const original = new Prisma.Decimal(r.originalAmount);
    const recovered = new Prisma.Decimal(r.recoveredAmount);
    const writtenOff = new Prisma.Decimal(r.writtenOffAmount);
    const outstanding = original.minus(recovered).minus(writtenOff);

    return {
      receivableId: r.id,
      originalAmount: original,
      recoveredAmount: recovered,
      writtenOffAmount: writtenOff,
      outstandingAmount: outstanding,
      status: r.status,
    };
  }

  /**
   * Atomically apply a recovery entry (SETTLEMENT_OFFSET or MANUAL_PAYMENT) against an
   * active OPEN/PARTIALLY_RECOVERED VendorReceivable. Rejects WRITE_OFF and DISPUTED/terminal rows.
   * Parent balances and status are synchronized strictly by PostgreSQL ledger triggers.
   */
  async createRecovery(
    dto: CreateVendorReceivableRecoveryDto,
    tx?: Prisma.TransactionClient,
  ): Promise<{ recovery: VendorReceivableRecovery; receivable: VendorReceivable }> {
    if ((dto.recoveryType as string) === 'WRITE_OFF') {
      throw new BadRequestException(
        'WRITE_OFF is disallowed on createRecovery(); use createWriteOff() instead',
      );
    }

    if (
      dto.recoveryType !== VendorReceivableRecoveryType.SETTLEMENT_OFFSET &&
      dto.recoveryType !== VendorReceivableRecoveryType.MANUAL_PAYMENT
    ) {
      throw new BadRequestException(`Unsupported recoveryType: ${String(dto.recoveryType)}`);
    }

    const recoveryAmount = parseExactMonetary2dp(dto.amount, 'amount', {
      allowZero: false,
      allowNegative: false,
    });

    let normalizedExternalRef: string | null = null;
    let parsedCollectedAt: Date | null = null;
    let normalizedIdempotencyKey =
      dto.idempotencyKey !== undefined && dto.idempotencyKey !== null
        ? dto.idempotencyKey.trim()
        : undefined;

    if (dto.idempotencyKey !== undefined && dto.idempotencyKey !== null && !normalizedIdempotencyKey) {
      throw new BadRequestException('idempotencyKey must not be blank when supplied');
    }

    if (dto.recoveryType === VendorReceivableRecoveryType.SETTLEMENT_OFFSET) {
      if (!dto.targetAdjustmentId || dto.targetAdjustmentId.trim().length === 0) {
        throw new BadRequestException(
          'SETTLEMENT_OFFSET recovery requires a non-empty targetAdjustmentId',
        );
      }
      if (
        (dto.externalReference !== undefined && dto.externalReference !== null) ||
        (dto.collectedAt !== undefined && dto.collectedAt !== null)
      ) {
        throw new BadRequestException(
          'SETTLEMENT_OFFSET recovery must not specify externalReference or collectedAt',
        );
      }
    } else {
      if (dto.targetAdjustmentId !== undefined && dto.targetAdjustmentId !== null) {
        throw new BadRequestException(
          'MANUAL_PAYMENT recovery must not specify targetAdjustmentId',
        );
      }
      if (typeof dto.externalReference !== 'string' || dto.externalReference.trim().length === 0) {
        throw new BadRequestException(
          'MANUAL_PAYMENT recovery requires a non-empty externalReference',
        );
      }
      normalizedExternalRef = dto.externalReference.trim();

      if (dto.collectedAt === undefined || dto.collectedAt === null) {
        throw new BadRequestException(
          'MANUAL_PAYMENT recovery requires a valid collectedAt timestamp',
        );
      }
      if (
        !(dto.collectedAt instanceof Date) &&
        (typeof dto.collectedAt !== 'string' || dto.collectedAt.trim().length === 0)
      ) {
        throw new BadRequestException('MANUAL_PAYMENT collectedAt must be a Date or ISO timestamp string');
      }
      const parsedDate =
        dto.collectedAt instanceof Date ? dto.collectedAt : new Date(dto.collectedAt);
      if (Number.isNaN(parsedDate.getTime())) {
        throw new BadRequestException('MANUAL_PAYMENT collectedAt must be a valid timestamp');
      }
      if (parsedDate.getTime() > Date.now() + 5 * 60 * 1000) {
        throw new BadRequestException(
          'MANUAL_PAYMENT collectedAt timestamp cannot be in the future',
        );
      }
      parsedCollectedAt = parsedDate;

      if (!normalizedIdempotencyKey) {
        throw new BadRequestException(
          'MANUAL_PAYMENT recovery requires a non-empty idempotencyKey',
        );
      }
    }

    return this.runInTx(tx, async (client) => {
      if (normalizedIdempotencyKey) {
        const existingByKey = await client.vendorReceivableRecovery.findUnique({
          where: { idempotencyKey: normalizedIdempotencyKey },
        });
        if (existingByKey) {
          throw new ConflictException(
            `Recovery with idempotencyKey "${normalizedIdempotencyKey}" already exists`,
          );
        }
      }

      if (normalizedExternalRef) {
        const dupExternal = await client.$queryRaw<{ id: string }[]>`
          SELECT "id"
          FROM "vendor_receivable_recoveries"
          WHERE "recoveryType"::text = 'MANUAL_PAYMENT'
            AND "externalReference" IS NOT NULL
            AND lower(btrim("externalReference")) = lower(${normalizedExternalRef})
          LIMIT 1
        `;
        if (dupExternal.length > 0) {
          throw new ConflictException(
            `MANUAL_PAYMENT recovery with externalReference "${normalizedExternalRef}" already exists`,
          );
        }
      }

      let targetAdj: {
        id: string;
        settlementId: string;
        amount: Prisma.Decimal;
        refundId: string | null;
        allocationId: string | null;
        settlement: {
          id: string;
          vendorId: string;
          vendorOrderId: string;
          status: VendorSettlementStatus;
          netAmount: Prisma.Decimal;
          vendorOrder: { order: { currency: string | null; payment: { currency: string } | null } };
        };
      } | null = null;

      if (dto.recoveryType === VendorReceivableRecoveryType.SETTLEMENT_OFFSET) {
        const adjPreview = await client.vendorSettlementAdjustment.findUnique({
          where: { id: dto.targetAdjustmentId! },
          select: { id: true, settlementId: true },
        });
        if (!adjPreview) {
          throw new NotFoundException(
            `Target settlement adjustment ${dto.targetAdjustmentId} not found`,
          );
        }

        // Canonical lock order: vendor_settlements -> vendor_settlement_adjustments -> vendor_receivables
        await client.$queryRaw`SELECT "id" FROM "vendor_settlements" WHERE "id" = ${adjPreview.settlementId} FOR UPDATE`;
        await client.$queryRaw`SELECT "id" FROM "vendor_settlement_adjustments" WHERE "id" = ${dto.targetAdjustmentId!} FOR UPDATE`;

        const existingTargetUse = await client.vendorReceivableRecovery.findUnique({
          where: { targetAdjustmentId: dto.targetAdjustmentId! },
        });
        if (existingTargetUse) {
          throw new ConflictException(
            `Target settlement adjustment ${dto.targetAdjustmentId} is already bound to recovery ${existingTargetUse.id}`,
          );
        }

        targetAdj = await client.vendorSettlementAdjustment.findUniqueOrThrow({
          where: { id: dto.targetAdjustmentId! },
          select: {
            id: true,
            settlementId: true,
            amount: true,
            refundId: true,
            allocationId: true,
            settlement: {
              select: {
                id: true,
                vendorId: true,
                vendorOrderId: true,
                status: true,
                netAmount: true,
                vendorOrder: {
                  select: {
                    order: {
                      select: {
                        currency: true,
                        payment: { select: { currency: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        });
      }

      const [locked] = await client.$queryRaw<VendorReceivable[]>`
        SELECT * FROM "vendor_receivables" WHERE "id" = ${dto.receivableId} FOR UPDATE
      `;

      if (!locked) {
        throw new NotFoundException(`VendorReceivable ${dto.receivableId} not found`);
      }

      if (
        locked.status === VendorReceivableStatus.DISPUTED ||
        locked.status === VendorReceivableStatus.RECOVERED ||
        locked.status === VendorReceivableStatus.WRITTEN_OFF
      ) {
        throw new BadRequestException(
          `Cannot apply recovery to receivable ${locked.id} in status ${locked.status}`,
        );
      }

      if (targetAdj) {
        if (targetAdj.refundId !== null || targetAdj.allocationId !== null) {
          throw new BadRequestException(
            `Target offset adjustment ${targetAdj.id} cannot be refund/allocation-linked`,
          );
        }
        if (targetAdj.settlement.vendorId !== locked.vendorId) {
          throw new BadRequestException(
            `Target offset adjustment vendor (${targetAdj.settlement.vendorId}) does not match receivable vendor (${locked.vendorId})`,
          );
        }
        if (targetAdj.settlementId === locked.settlementId) {
          throw new BadRequestException(
            `Target offset adjustment cannot reference origin settlement ${locked.settlementId}`,
          );
        }
        if (
          targetAdj.settlement.status !== VendorSettlementStatus.PENDING &&
          targetAdj.settlement.status !== VendorSettlementStatus.APPROVED
        ) {
          throw new BadRequestException(
            `Target offset settlement ${targetAdj.settlement.id} must be PENDING or APPROVED, got ${targetAdj.settlement.status}`,
          );
        }
        const targetCurrency =
          targetAdj.settlement.vendorOrder.order.payment?.currency ??
          targetAdj.settlement.vendorOrder.order.currency;
        if (targetCurrency && targetCurrency !== locked.currency) {
          throw new BadRequestException(
            `Target offset settlement currency (${targetCurrency}) does not match receivable currency (${locked.currency})`,
          );
        }
        const adjAmt = new Prisma.Decimal(targetAdj.amount);
        if (adjAmt.gte(0) || !adjAmt.negated().equals(recoveryAmount)) {
          throw new BadRequestException(
            `Recovery amount (${recoveryAmount}) must match negative target adjustment magnitude (${adjAmt})`,
          );
        }

        const targetAdjSumAgg = await client.vendorSettlementAdjustment.aggregate({
          where: { settlementId: targetAdj.settlementId },
          _sum: { amount: true },
        });
        const targetAdjustedNet = new Prisma.Decimal(targetAdj.settlement.netAmount).plus(
          new Prisma.Decimal(targetAdjSumAgg._sum.amount ?? 0),
        );
        const activeDisbAgg = await client.vendorSettlementDisbursement.aggregate({
          where: {
            settlementId: targetAdj.settlementId,
            status: {
              in: [
                VendorSettlementDisbursementStatus.IN_FLIGHT,
                VendorSettlementDisbursementStatus.CONFIRMED,
              ],
            },
          },
          _sum: { amount: true },
        });
        const targetActiveDisb = new Prisma.Decimal(activeDisbAgg._sum.amount ?? 0);
        if (targetAdjustedNet.lt(0) || targetAdjustedNet.lt(targetActiveDisb)) {
          throw new BadRequestException(
            `Target offset settlement ${targetAdj.settlement.id} lacks sufficient payable balance (adjustedNet=${targetAdjustedNet}, activeDisbursements=${targetActiveDisb})`,
          );
        }
      }

      const recSumAgg = await client.vendorReceivableRecovery.aggregate({
        where: { receivableId: dto.receivableId },
        _sum: { amount: true },
      });
      const woSumAgg = await client.vendorReceivableWriteOff.aggregate({
        where: { receivableId: dto.receivableId },
        _sum: { amount: true },
      });

      const original = new Prisma.Decimal(locked.originalAmount);
      const currentRecovered = new Prisma.Decimal(recSumAgg._sum.amount ?? 0);
      const currentWrittenOff = new Prisma.Decimal(woSumAgg._sum.amount ?? 0);
      const outstanding = original.minus(currentRecovered).minus(currentWrittenOff);

      if (recoveryAmount.gt(outstanding)) {
        throw new BadRequestException(
          `Recovery amount (${recoveryAmount}) exceeds outstanding receivable balance (${outstanding})`,
        );
      }

      try {
        const recovery = await client.vendorReceivableRecovery.create({
          data: {
            receivableId: dto.receivableId,
            targetAdjustmentId: dto.targetAdjustmentId ?? null,
            amount: recoveryAmount,
            recoveryType: dto.recoveryType,
            externalReference: normalizedExternalRef,
            collectedAt: parsedCollectedAt,
            idempotencyKey: normalizedIdempotencyKey,
            notes: dto.notes,
          },
        });

        const updatedReceivable = await client.vendorReceivable.findUniqueOrThrow({
          where: { id: dto.receivableId },
        });

        return { recovery, receivable: updatedReceivable };
      } catch (err: any) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException(
            `Recovery conflict for idempotencyKey "${normalizedIdempotencyKey ?? ''}", targetAdjustmentId "${dto.targetAdjustmentId ?? ''}", or externalReference "${normalizedExternalRef ?? ''}"`,
          );
        }
        throw err;
      }
    });
  }

  /**
   * Atomically record an append-only VendorReceivableWriteOff row.
   * Rejects DISPUTED or terminal receivables and overdrafts; closure with writtenOffAmount > 0 yields WRITTEN_OFF.
   */
  async createWriteOff(
    dto: CreateVendorReceivableWriteOffDto,
    tx?: Prisma.TransactionClient,
  ): Promise<{ writeOff: VendorReceivableWriteOff; receivable: VendorReceivable }> {
    const writeOffAmount = parseExactMonetary2dp(dto.amount, 'amount', {
      allowZero: false,
      allowNegative: false,
    });

    if (!dto.reason || typeof dto.reason !== 'string' || dto.reason.trim().length === 0) {
      throw new BadRequestException('Write-off reason is required and cannot be empty');
    }

    return this.runInTx(tx, async (client) => {
      if (dto.idempotencyKey) {
        const existingByKey = await client.vendorReceivableWriteOff.findUnique({
          where: { idempotencyKey: dto.idempotencyKey },
        });
        if (existingByKey) {
          throw new ConflictException(
            `Write-off with idempotencyKey "${dto.idempotencyKey}" already exists`,
          );
        }
      }

      const [locked] = await client.$queryRaw<VendorReceivable[]>`
        SELECT * FROM "vendor_receivables" WHERE "id" = ${dto.receivableId} FOR UPDATE
      `;

      if (!locked) {
        throw new NotFoundException(`VendorReceivable ${dto.receivableId} not found`);
      }

      if (
        locked.status === VendorReceivableStatus.DISPUTED ||
        locked.status === VendorReceivableStatus.RECOVERED ||
        locked.status === VendorReceivableStatus.WRITTEN_OFF
      ) {
        throw new BadRequestException(
          `Cannot apply write-off to receivable ${locked.id} in status ${locked.status}`,
        );
      }

      const recSumAgg = await client.vendorReceivableRecovery.aggregate({
        where: { receivableId: dto.receivableId },
        _sum: { amount: true },
      });
      const woSumAgg = await client.vendorReceivableWriteOff.aggregate({
        where: { receivableId: dto.receivableId },
        _sum: { amount: true },
      });

      const original = new Prisma.Decimal(locked.originalAmount);
      const currentRecovered = new Prisma.Decimal(recSumAgg._sum.amount ?? 0);
      const currentWrittenOff = new Prisma.Decimal(woSumAgg._sum.amount ?? 0);
      const outstanding = original.minus(currentRecovered).minus(currentWrittenOff);

      if (writeOffAmount.gt(outstanding)) {
        throw new BadRequestException(
          `Write-off amount (${writeOffAmount}) exceeds outstanding receivable balance (${outstanding})`,
        );
      }

      try {
        const writeOff = await client.vendorReceivableWriteOff.create({
          data: {
            receivableId: dto.receivableId,
            amount: writeOffAmount,
            reason: dto.reason.trim(),
            idempotencyKey: dto.idempotencyKey,
          },
        });

        const updatedReceivable = await client.vendorReceivable.findUniqueOrThrow({
          where: { id: dto.receivableId },
        });

        return { writeOff, receivable: updatedReceivable };
      } catch (err: any) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException(
            `Write-off with idempotencyKey "${dto.idempotencyKey}" already exists`,
          );
        }
        throw err;
      }
    });
  }

  /**
   * Place an active OPEN or PARTIALLY_RECOVERED receivable into DISPUTED status.
   */
  async markDisputed(
    receivableId: string,
    notes?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<VendorReceivable> {
    return this.runInTx(tx, async (client) => {
      const [locked] = await client.$queryRaw<VendorReceivable[]>`
        SELECT * FROM "vendor_receivables" WHERE "id" = ${receivableId} FOR UPDATE
      `;

      if (!locked) {
        throw new NotFoundException(`VendorReceivable ${receivableId} not found`);
      }

      if (
        locked.status !== VendorReceivableStatus.OPEN &&
        locked.status !== VendorReceivableStatus.PARTIALLY_RECOVERED
      ) {
        throw new BadRequestException(
          `Only OPEN or PARTIALLY_RECOVERED receivables can be disputed (current status: ${locked.status})`,
        );
      }

      return client.vendorReceivable.update({
        where: { id: receivableId },
        data: {
          status: VendorReceivableStatus.DISPUTED,
          ...(notes !== undefined ? { notes } : {}),
        },
      });
    });
  }

  /**
   * Resolve a DISPUTED receivable back to OPEN or PARTIALLY_RECOVERED based on authoritative ledger sums.
   */
  async resolveDispute(
    receivableId: string,
    notes?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<VendorReceivable> {
    return this.runInTx(tx, async (client) => {
      const [locked] = await client.$queryRaw<VendorReceivable[]>`
        SELECT * FROM "vendor_receivables" WHERE "id" = ${receivableId} FOR UPDATE
      `;

      if (!locked) {
        throw new NotFoundException(`VendorReceivable ${receivableId} not found`);
      }

      if (locked.status !== VendorReceivableStatus.DISPUTED) {
        throw new BadRequestException(
          `Only DISPUTED receivables can resolve dispute (current status: ${locked.status})`,
        );
      }

      const recSumAgg = await client.vendorReceivableRecovery.aggregate({
        where: { receivableId },
        _sum: { amount: true },
      });
      const woSumAgg = await client.vendorReceivableWriteOff.aggregate({
        where: { receivableId },
        _sum: { amount: true },
      });

      const totalApplied = new Prisma.Decimal(recSumAgg._sum.amount ?? 0).plus(
        new Prisma.Decimal(woSumAgg._sum.amount ?? 0),
      );
      const nextStatus = totalApplied.isZero()
        ? VendorReceivableStatus.OPEN
        : VendorReceivableStatus.PARTIALLY_RECOVERED;

      return client.vendorReceivable.update({
        where: { id: receivableId },
        data: {
          status: nextStatus,
          ...(notes !== undefined ? { notes } : {}),
        },
      });
    });
  }
}
