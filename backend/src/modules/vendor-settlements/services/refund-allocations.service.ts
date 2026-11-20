import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  RefundAllocationEntryKind,
  RefundAllocationType,
  RefundStatus,
  RefundVendorOrderAllocation,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  RefundAllocationsRepository,
  resolveCanonicalComponentKey,
} from '../repositories/refund-allocations.repository';
import {
  compareTargetIdsAsc,
  distributeAmountHamilton,
  HamiltonDistributionResult,
  parseExactMonetary2dp,
} from '../utils/cent-distribution.util';

export const PROVISIONAL_ALLOCATION_REFUND_STATUSES: readonly RefundStatus[] = [
  RefundStatus.REQUIRED,
  RefundStatus.PENDING,
  RefundStatus.PROCESSING,
  RefundStatus.RECONCILE_REQUIRED,
];

export const ELIGIBLE_ALLOCATION_REFUND_STATUSES: readonly RefundStatus[] = [
  ...PROVISIONAL_ALLOCATION_REFUND_STATUSES,
  RefundStatus.COMPLETED,
];

export interface CreateAllocationDto {
  refundId: string;
  vendorOrderId: string;
  orderItemId?: string | null;
  componentKey?: string;
  amount: Prisma.Decimal | number | string;
  allocationType: RefundAllocationType;
  reason?: string;
  currency?: string;
}

export interface BatchAllocationItemDto {
  vendorOrderId: string;
  orderItemId?: string | null;
  componentKey?: string;
  amount: Prisma.Decimal | number | string;
  allocationType: RefundAllocationType;
  reason?: string;
  currency?: string;
}

export interface CreateBatchAllocationsDto {
  refundId: string;
  items: BatchAllocationItemDto[];
}

export interface ProportionalAllocationTargetDto {
  vendorOrderId: string;
  orderItemId?: string | null;
  componentKey?: string;
  weight: Prisma.Decimal | number | string;
  maxCeiling?: Prisma.Decimal | number | string;
  reason?: string;
}

export interface CreateProportionalAllocationsDto {
  refundId: string;
  amount: Prisma.Decimal | number | string;
  allocationType: RefundAllocationType;
  targets: ProportionalAllocationTargetDto[];
  currency?: string;
  reason?: string;
  allowCeilingResidual?: boolean;
}

export interface CreateProportionalAllocationsResult {
  allocations: RefundVendorOrderAllocation[];
  distribution: HamiltonDistributionResult;
}

export interface ReverseAllocationDto {
  allocationId: string;
  amount?: Prisma.Decimal | number | string;
  reason: string;
}

export function assertRefundStatusEligibleForAllocation(status: string): void {
  if (status === RefundStatus.FAILED) {
    throw new BadRequestException('Cannot create allocation for a FAILED refund');
  }
  if (!ELIGIBLE_ALLOCATION_REFUND_STATUSES.includes(status as RefundStatus)) {
    throw new BadRequestException(`Refund status "${status}" is not eligible for allocation`);
  }
}

@Injectable()
export class RefundAllocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refundAllocationsRepository: RefundAllocationsRepository,
  ) {}

  async createAllocation(
    input: CreateAllocationDto,
    externalTx?: Prisma.TransactionClient,
  ): Promise<RefundVendorOrderAllocation> {
    const created = await this.createBatchAllocations(
      {
        refundId: input.refundId,
        items: [
          {
            vendorOrderId: input.vendorOrderId,
            orderItemId: input.orderItemId ?? null,
            componentKey: input.componentKey,
            amount: input.amount,
            allocationType: input.allocationType,
            reason: input.reason,
            currency: input.currency,
          },
        ],
      },
      externalTx,
    );
    return created[0]!;
  }

  async createBatchAllocations(
    input: CreateBatchAllocationsDto,
    externalTx?: Prisma.TransactionClient,
  ): Promise<RefundVendorOrderAllocation[]> {
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new BadRequestException('At least one allocation item is required');
    }

    const parsedAmounts = input.items.map((item) => parseExactMonetary2dp(item.amount, 'amount'));
    const uniqueSortedVoIds = [
      ...new Set(input.items.map((item) => item.vendorOrderId)),
    ].sort(compareTargetIdsAsc);

    const execute = async (
      tx: Prisma.TransactionClient,
    ): Promise<RefundVendorOrderAllocation[]> => {
      const { refund, payment, voMap } = await this.lockOrderHierarchyForAllocation(
        tx,
        input.refundId,
        uniqueSortedVoIds,
      );

      assertRefundStatusEligibleForAllocation(refund.status);

      for (const item of input.items) {
        if (item.currency && item.currency !== payment.currency) {
          throw new BadRequestException(
            `Allocation currency "${item.currency}" does not match payment currency "${payment.currency}"`,
          );
        }
      }

      // 1. Aggregate single-refund ceiling check
      const existingRefundAllocations =
        await this.refundAllocationsRepository.sumByRefundIdDecimal(input.refundId, tx);
      const batchTotal = parsedAmounts.reduce(
        (sum, amt) => sum.add(amt),
        new Prisma.Decimal(0),
      );
      const refundAmount = new Prisma.Decimal(refund.amount);
      if (existingRefundAllocations.add(batchTotal).gt(refundAmount)) {
        throw new BadRequestException(
          'Total allocated amount exceeds refundable balance',
        );
      }

      // 2. Per-VendorOrder active ceiling checks (excluding FAILED refunds)
      const requestedByVo = new Map<string, Prisma.Decimal>();
      for (let idx = 0; idx < input.items.length; idx++) {
        const voId = input.items[idx]!.vendorOrderId;
        const prev = requestedByVo.get(voId) ?? new Prisma.Decimal(0);
        requestedByVo.set(voId, prev.add(parsedAmounts[idx]!));
      }

      for (const voId of uniqueSortedVoIds) {
        const vo = voMap.get(voId)!;
        const existingVoAllocations =
          await this.refundAllocationsRepository.sumByVendorOrderIdDecimal(voId, tx);
        const requestedVoTotal = requestedByVo.get(voId) ?? new Prisma.Decimal(0);
        if (existingVoAllocations.add(requestedVoTotal).gt(new Prisma.Decimal(vo.subtotal))) {
          throw new BadRequestException(
            'Total allocated amount exceeds vendor order subtotal',
          );
        }
      }

      // 3. Per-OrderItem ownership and active ceiling checks (when orderItemId provided)
      const requestedByItem = new Map<string, { vendorOrderId: string; total: Prisma.Decimal }>();
      for (let idx = 0; idx < input.items.length; idx++) {
        const item = input.items[idx]!;
        if (item.orderItemId) {
          const prev = requestedByItem.get(item.orderItemId);
          if (prev && prev.vendorOrderId !== item.vendorOrderId) {
            throw new BadRequestException(
              `OrderItem "${item.orderItemId}" cannot be assigned to multiple VendorOrders`,
            );
          }
          requestedByItem.set(item.orderItemId, {
            vendorOrderId: item.vendorOrderId,
            total: (prev?.total ?? new Prisma.Decimal(0)).add(parsedAmounts[idx]!),
          });
        }
      }

      if (requestedByItem.size > 0) {
        const uniqueItemIds = [...requestedByItem.keys()].sort(compareTargetIdsAsc);
        const dbItems = await tx.orderItem.findMany({
          where: { id: { in: uniqueItemIds } },
          select: { id: true, vendorOrderId: true, subtotal: true },
        });
        const itemMap = new Map(dbItems.map((i) => [i.id, i]));

        for (const itemId of uniqueItemIds) {
          const dbItem = itemMap.get(itemId);
          if (!dbItem) {
            throw new NotFoundException(`OrderItem "${itemId}" not found`);
          }
          const req = requestedByItem.get(itemId)!;
          if (dbItem.vendorOrderId !== req.vendorOrderId) {
            throw new BadRequestException(
              'OrderItem does not belong to the specified VendorOrder',
            );
          }
          const existingItemAllocations =
            await this.refundAllocationsRepository.sumByOrderItemIdDecimal(itemId, tx);
          if (
            existingItemAllocations.add(req.total).gt(new Prisma.Decimal(dbItem.subtotal))
          ) {
            throw new BadRequestException(
              'Total allocated amount exceeds order item subtotal',
            );
          }
        }
      }

      // 4. Persist all validated allocations in deterministic identity order
      const created: RefundVendorOrderAllocation[] = [];
      for (let idx = 0; idx < input.items.length; idx++) {
        const item = input.items[idx]!;
        const row = await this.refundAllocationsRepository.create(
          {
            refundId: input.refundId,
            vendorOrderId: item.vendorOrderId,
            orderItemId: item.orderItemId ?? null,
            componentKey: item.componentKey,
            entryKind: RefundAllocationEntryKind.ALLOCATION,
            reversesAllocationId: null,
            amount: parsedAmounts[idx]!,
            currency: payment.currency,
            allocationType: item.allocationType,
            reason: item.reason,
          },
          tx,
        );
        created.push(row);
      }

      return created;
    };

    if (externalTx) {
      return execute(externalTx);
    }
    return this.prisma.$transaction(execute, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }

  async createProportionalAllocations(
    input: CreateProportionalAllocationsDto,
    externalTx?: Prisma.TransactionClient,
  ): Promise<CreateProportionalAllocationsResult> {
    if (!Array.isArray(input.targets) || input.targets.length === 0) {
      throw new BadRequestException('At least one proportional allocation target is required');
    }

    const requestedAmount = parseExactMonetary2dp(input.amount, 'amount');
    const uniqueSortedVoIds = [
      ...new Set(input.targets.map((t) => t.vendorOrderId)),
    ].sort(compareTargetIdsAsc);

    const execute = async (
      tx: Prisma.TransactionClient,
    ): Promise<CreateProportionalAllocationsResult> => {
      const { refund, payment, voMap } = await this.lockOrderHierarchyForAllocation(
        tx,
        input.refundId,
        uniqueSortedVoIds,
      );

      assertRefundStatusEligibleForAllocation(refund.status);

      if (input.currency && input.currency !== payment.currency) {
        throw new BadRequestException(
          `Allocation currency "${input.currency}" does not match payment currency "${payment.currency}"`,
        );
      }

      const existingRefundAllocations =
        await this.refundAllocationsRepository.sumByRefundIdDecimal(input.refundId, tx);
      const refundRemaining = new Prisma.Decimal(refund.amount).sub(existingRefundAllocations);
      if (requestedAmount.gt(refundRemaining)) {
        throw new BadRequestException(
          'Total allocated amount exceeds refundable balance',
        );
      }

      // Compute remaining VendorOrder capacities under FOR UPDATE locks
      const voRemainingMap = new Map<string, Prisma.Decimal>();
      for (const voId of uniqueSortedVoIds) {
        const vo = voMap.get(voId)!;
        const used = await this.refundAllocationsRepository.sumByVendorOrderIdDecimal(
          voId,
          tx,
        );
        const rem = new Prisma.Decimal(vo.subtotal).sub(used);
        voRemainingMap.set(voId, rem.gt(0) ? rem : new Prisma.Decimal(0));
      }

      // Validate and compute remaining OrderItem capacities where specified
      const uniqueItemIds = [
        ...new Set(input.targets.map((t) => t.orderItemId).filter(Boolean) as string[]),
      ].sort(compareTargetIdsAsc);
      const itemMap = new Map<
        string,
        { id: string; vendorOrderId: string; subtotal: Prisma.Decimal; remaining: Prisma.Decimal }
      >();

      if (uniqueItemIds.length > 0) {
        const dbItems = await tx.orderItem.findMany({
          where: { id: { in: uniqueItemIds } },
          select: { id: true, vendorOrderId: true, subtotal: true },
        });
        const dbItemById = new Map(dbItems.map((i) => [i.id, i]));
        for (const itemId of uniqueItemIds) {
          const dbItem = dbItemById.get(itemId);
          if (!dbItem) {
            throw new NotFoundException(`OrderItem "${itemId}" not found`);
          }
          const used = await this.refundAllocationsRepository.sumByOrderItemIdDecimal(
            itemId,
            tx,
          );
          const rem = new Prisma.Decimal(dbItem.subtotal).sub(used);
          itemMap.set(itemId, {
            ...dbItem,
            remaining: rem.gt(0) ? rem : new Prisma.Decimal(0),
          });
        }
      }

      // Build deterministic Hamilton target list
      const targetMetaByKey = new Map<
        string,
        {
          target: ProportionalAllocationTargetDto;
          componentKey: string;
        }
      >();

      const hamiltonTargets = input.targets.map((target) => {
        const componentKey = resolveCanonicalComponentKey({
          entryKind: RefundAllocationEntryKind.ALLOCATION,
          orderItemId: target.orderItemId ?? null,
          componentKey: target.componentKey,
          reversesAllocationId: null,
        });

        // Deterministic unique targetId used by Hamilton sorting & tie-breaking:
        // for VO-level targets this equals vendorOrderId; for item-level targets it equals orderItemId
        const targetId = target.orderItemId
          ? target.orderItemId
          : componentKey === 'VO'
            ? target.vendorOrderId
            : `${target.vendorOrderId}::${componentKey}`;

        if (targetMetaByKey.has(targetId)) {
          throw new BadRequestException(`Duplicate proportional target "${targetId}"`);
        }

        const voRemaining = voRemainingMap.get(target.vendorOrderId)!;
        let maxCeiling = voRemaining;

        if (target.orderItemId) {
          const itemInfo = itemMap.get(target.orderItemId)!;
          if (itemInfo.vendorOrderId !== target.vendorOrderId) {
            throw new BadRequestException(
              'OrderItem does not belong to the specified VendorOrder',
            );
          }
          maxCeiling = Prisma.Decimal.min(maxCeiling, itemInfo.remaining);
        }

        if (target.maxCeiling !== undefined) {
          const explicitMax = parseExactMonetary2dp(target.maxCeiling, 'maxCeiling', {
            allowZero: true,
          });
          maxCeiling = Prisma.Decimal.min(maxCeiling, explicitMax);
        }

        targetMetaByKey.set(targetId, { target, componentKey });
        return {
          targetId,
          weight: target.weight,
          maxCeiling,
        };
      });

      const distribution = distributeAmountHamilton({
        amount: requestedAmount,
        targets: hamiltonTargets,
        allowCeilingResidual: input.allowCeilingResidual,
      });

      // Verify grouped per-VO totals also stay <= remaining VO subtotal (relevant if multi-item targets share 1 VO)
      const groupedVoSum = new Map<string, Prisma.Decimal>();
      for (const alloc of distribution.allocations) {
        if (alloc.amountCents <= 0n) continue;
        const meta = targetMetaByKey.get(alloc.targetId)!;
        const prev = groupedVoSum.get(meta.target.vendorOrderId) ?? new Prisma.Decimal(0);
        groupedVoSum.set(meta.target.vendorOrderId, prev.add(alloc.amount));
      }
      for (const [voId, sumForVo] of groupedVoSum.entries()) {
        if (sumForVo.gt(voRemainingMap.get(voId)!)) {
          throw new BadRequestException(
            'Total allocated amount exceeds vendor order subtotal',
          );
        }
      }

      const allocations: RefundVendorOrderAllocation[] = [];
      for (const alloc of distribution.allocations) {
        if (alloc.amountCents <= 0n) continue;
        const meta = targetMetaByKey.get(alloc.targetId)!;
        const created = await this.refundAllocationsRepository.create(
          {
            refundId: input.refundId,
            vendorOrderId: meta.target.vendorOrderId,
            orderItemId: meta.target.orderItemId ?? null,
            componentKey: meta.componentKey,
            entryKind: RefundAllocationEntryKind.ALLOCATION,
            reversesAllocationId: null,
            amount: alloc.amount,
            currency: payment.currency,
            allocationType: input.allocationType,
            reason: meta.target.reason ?? input.reason,
          },
          tx,
        );
        allocations.push(created);
      }

      return { allocations, distribution };
    };

    if (externalTx) {
      return execute(externalTx);
    }
    return this.prisma.$transaction(execute, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }

  async reverseAllocation(
    input: ReverseAllocationDto,
    externalTx?: Prisma.TransactionClient,
  ): Promise<RefundVendorOrderAllocation> {
    if (!input.reason || typeof input.reason !== 'string' || input.reason.trim().length === 0) {
      throw new BadRequestException('Reversal reason is required');
    }

    const explicitMagnitude =
      input.amount !== undefined
        ? parseExactMonetary2dp(input.amount, 'amount', {
            allowZero: false,
            allowNegative: false,
          })
        : undefined;

    const execute = async (
      tx: Prisma.TransactionClient,
    ): Promise<RefundVendorOrderAllocation> => {
      // Unlocked immutable metadata read so canonical lock header runs Order -> VendorOrder -> Refund -> Allocation
      const targetMeta = await tx.refundVendorOrderAllocation.findUnique({
        where: { id: input.allocationId },
        select: {
          id: true,
          refundId: true,
          vendorOrderId: true,
          refund: { select: { payment: { select: { orderId: true } } } },
        },
      });
      if (!targetMeta) {
        throw new NotFoundException(`Allocation "${input.allocationId}" not found`);
      }

      const { refund } = await this.lockOrderHierarchyForAllocation(
        tx,
        targetMeta.refundId,
        [targetMeta.vendorOrderId],
      );

      let target: RefundVendorOrderAllocation | null;
      if ((tx as any).$queryRaw) {
        await (tx as any).$queryRaw(
          Prisma.sql`SELECT "id" FROM "refund_vendor_order_allocations" WHERE "id" = ${input.allocationId} FOR UPDATE`,
        );
      }
      target = await this.refundAllocationsRepository.findById(input.allocationId, tx);
      if (!target) {
        throw new NotFoundException(`Allocation "${input.allocationId}" not found`);
      }

      if (target.entryKind !== RefundAllocationEntryKind.ALLOCATION) {
        throw new BadRequestException('Only original ALLOCATION entries can be reversed');
      }

      if (refund.status === RefundStatus.FAILED) {
        throw new BadRequestException(
          'Cannot reverse allocation belonging to a FAILED refund',
        );
      }

      if (typeof (tx as any).vendorReceivable?.findUnique === 'function') {
        if ((tx as any).$queryRaw) {
          await (tx as any).$queryRaw(
            Prisma.sql`SELECT "id" FROM "vendor_receivables" WHERE "allocationId" = ${target.id} FOR UPDATE`,
          );
        }
        const existingReceivable = await (tx as any).vendorReceivable.findUnique({
          where: { allocationId: target.id },
          select: { id: true, status: true },
        });
        if (existingReceivable) {
          throw new ConflictException(
            `Cannot reverse allocation "${target.id}" because VendorReceivable "${existingReceivable.id}" (${existingReceivable.status}) already references it`,
          );
        }
      }

      const existingReversal =
        await this.refundAllocationsRepository.findByReversesAllocationId(target.id, tx);
      if (existingReversal) {
        throw new ConflictException(
          `Allocation "${input.allocationId}" has already been reversed`,
        );
      }

      const originalAmount = new Prisma.Decimal(target.amount);
      const reversalMagnitude = explicitMagnitude ?? originalAmount;

      if (reversalMagnitude.gt(originalAmount)) {
        throw new BadRequestException(
          'Reversal amount exceeds original allocation amount eligible for reversal',
        );
      }

      // Ensure reversal never creates negative aggregate liability on Refund, VendorOrder, or OrderItem
      const refundNet = await this.refundAllocationsRepository.sumByRefundIdDecimal(
        target.refundId,
        tx,
      );
      if (refundNet.sub(reversalMagnitude).lt(0)) {
        throw new BadRequestException(
          'Reversal would create negative aggregate refund allocation balance',
        );
      }

      const voNet = await this.refundAllocationsRepository.sumByVendorOrderIdDecimal(
        target.vendorOrderId,
        tx,
      );
      if (voNet.sub(reversalMagnitude).lt(0)) {
        throw new BadRequestException(
          'Reversal would create negative aggregate vendor order liability',
        );
      }

      if (target.orderItemId) {
        const itemNet = await this.refundAllocationsRepository.sumByOrderItemIdDecimal(
          target.orderItemId,
          tx,
        );
        if (itemNet.sub(reversalMagnitude).lt(0)) {
          throw new BadRequestException(
            'Reversal would create negative aggregate order item liability',
          );
        }
      }

      return this.refundAllocationsRepository.create(
        {
          refundId: target.refundId,
          vendorOrderId: target.vendorOrderId,
          orderItemId: target.orderItemId,
          componentKey: `REV:${target.id}`,
          entryKind: RefundAllocationEntryKind.REVERSAL,
          reversesAllocationId: target.id,
          amount: reversalMagnitude.neg(),
          currency: target.currency,
          allocationType: target.allocationType,
          reason: input.reason.trim(),
        },
        tx,
      );
    };

    if (externalTx) {
      return execute(externalTx);
    }
    return this.prisma.$transaction(execute, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }

  async getAllocationById(
    allocationId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<RefundVendorOrderAllocation | null> {
    return this.refundAllocationsRepository.findById(allocationId, tx);
  }

  async getAllocationsByRefundId(
    refundId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<RefundVendorOrderAllocation[]> {
    return this.refundAllocationsRepository.findByRefundId(refundId, tx);
  }

  async getAllocationsByVendorOrderId(
    vendorOrderId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<RefundVendorOrderAllocation[]> {
    return this.refundAllocationsRepository.findByVendorOrderId(vendorOrderId, tx);
  }

  async getAllocationsByOrderItemId(
    orderItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<RefundVendorOrderAllocation[]> {
    return this.refundAllocationsRepository.findByOrderItemId(orderItemId, tx);
  }

  async getAllocatedTotalByRefundId(
    refundId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Prisma.Decimal> {
    return this.refundAllocationsRepository.sumByRefundIdDecimal(refundId, tx);
  }

  async getAllocatedTotalByVendorOrderId(
    vendorOrderId: string,
    tx?: Prisma.TransactionClient,
    options?: { includeFailed?: boolean },
  ): Promise<Prisma.Decimal> {
    return this.refundAllocationsRepository.sumByVendorOrderIdDecimal(vendorOrderId, tx, options);
  }

  async getAllocatedTotalByOrderItemId(
    orderItemId: string,
    tx?: Prisma.TransactionClient,
    options?: { includeFailed?: boolean },
  ): Promise<Prisma.Decimal> {
    return this.refundAllocationsRepository.sumByOrderItemIdDecimal(orderItemId, tx, options);
  }

  /**
   * Acquires row locks strictly in Global Canonical Lock Hierarchy order:
   *   Level 1: orders
   *   Level 2: vendor_orders (id ASC)
   *   Level 4: refunds
   * Never locks any VendorOrder after a Refund lock is acquired.
   */
  private async lockOrderHierarchyForAllocation(
    tx: Prisma.TransactionClient,
    refundId: string,
    sortedUniqueVoIds: string[],
  ): Promise<{
    refund: { id: string; paymentId: string; amount: Prisma.Decimal; status: string };
    payment: { id: string; orderId: string; currency: string };
    voMap: Map<string, { id: string; orderId: string; subtotal: Prisma.Decimal }>;
  }> {
    // Unlocked immutable FK metadata lookup prior to acquiring FOR UPDATE locks
    const refundHeader = await tx.refund.findUnique({
      where: { id: refundId },
      select: {
        id: true,
        paymentId: true,
        payment: { select: { id: true, orderId: true, currency: true } },
      },
    });
    if (!refundHeader) {
      throw new NotFoundException(`Refund "${refundId}" not found`);
    }
    if (!refundHeader.payment) {
      throw new NotFoundException(`Payment "${refundHeader.paymentId}" not found`);
    }

    const voHeaders = await tx.vendorOrder.findMany({
      where: { id: { in: sortedUniqueVoIds } },
      select: { id: true, orderId: true },
    });
    const voHeaderMap = new Map(voHeaders.map((vo) => [vo.id, vo]));
    for (const voId of sortedUniqueVoIds) {
      const vo = voHeaderMap.get(voId);
      if (!vo) {
        throw new NotFoundException(`VendorOrder "${voId}" not found`);
      }
      if (vo.orderId !== refundHeader.payment.orderId) {
        throw new BadRequestException(
          'Refund and VendorOrder do not belong to the same Order',
        );
      }
    }

    const orderId = refundHeader.payment.orderId;
    let lockedVos: Array<{ id: string; orderId: string; subtotal: Prisma.Decimal }>;
    let lockedRefund: {
      id: string;
      paymentId: string;
      amount: Prisma.Decimal;
      status: string;
    };

    if ((tx as any).$queryRaw) {
      // Level 1: Order
      await (tx as any).$queryRaw(
        Prisma.sql`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`,
      );

      // Level 2: VendorOrders in deterministic ASC id order
      lockedVos = (await (tx as any).$queryRaw(
        Prisma.sql`SELECT "id", "orderId", "subtotal" FROM "vendor_orders" WHERE "id" IN (${Prisma.join(sortedUniqueVoIds)}) ORDER BY "id" ASC FOR UPDATE`,
      )) as Array<{ id: string; orderId: string; subtotal: Prisma.Decimal }>;

      if (lockedVos.length !== sortedUniqueVoIds.length) {
        const presentIds = new Set(lockedVos.map((v) => v.id));
        const missingId = sortedUniqueVoIds.find((id) => !presentIds.has(id));
        throw new NotFoundException(`VendorOrder "${missingId}" not found`);
      }

      // Level 3: Payment
      await (tx as any).$queryRaw(
        Prisma.sql`SELECT "id" FROM "payments" WHERE "id" = ${refundHeader.paymentId} FOR UPDATE`,
      );

      // Level 4: Refund
      const rRows = (await (tx as any).$queryRaw(
        Prisma.sql`SELECT "id", "paymentId", "amount", "status" FROM "refunds" WHERE "id" = ${refundId} FOR UPDATE`,
      )) as Array<{
        id: string;
        paymentId: string;
        amount: Prisma.Decimal;
        status: string;
      }>;
      if (!rRows || rRows.length === 0) {
        throw new NotFoundException(`Refund "${refundId}" not found`);
      }
      lockedRefund = rRows[0]!;
    } else {
      lockedVos = await tx.vendorOrder.findMany({
        where: { id: { in: sortedUniqueVoIds } },
        select: { id: true, orderId: true, subtotal: true },
        orderBy: { id: 'asc' },
      });
      const foundR = await tx.refund.findUnique({
        where: { id: refundId },
        select: { id: true, paymentId: true, amount: true, status: true },
      });
      if (!foundR) {
        throw new NotFoundException(`Refund "${refundId}" not found`);
      }
      lockedRefund = foundR;
    }

    const voMap = new Map(lockedVos.map((v) => [v.id, v]));
    return {
      refund: lockedRefund,
      payment: refundHeader.payment,
      voMap,
    };
  }
}
