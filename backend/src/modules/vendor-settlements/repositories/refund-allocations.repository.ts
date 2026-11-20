import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  RefundAllocationEntryKind,
  RefundAllocationType,
  RefundStatus,
  RefundVendorOrderAllocation,
} from '@prisma/client';

import { parseExactMonetary2dp } from '../utils/cent-distribution.util';
import { PrismaService } from '../../../database/prisma.service';

export interface CreateRefundAllocationInput {
  refundId: string;
  vendorOrderId: string;
  orderItemId?: string | null;
  componentKey?: string;
  entryKind?: RefundAllocationEntryKind;
  reversesAllocationId?: string | null;
  amount: Prisma.Decimal | number | string;
  currency?: string;
  allocationType: RefundAllocationType;
  reason?: string | null;
}

export function resolveCanonicalComponentKey(params: {
  entryKind: RefundAllocationEntryKind;
  orderItemId?: string | null;
  componentKey?: string;
  reversesAllocationId?: string | null;
}): string {
  const trimmedKey = params.componentKey?.trim();
  if (params.componentKey !== undefined && (!trimmedKey || trimmedKey.length === 0)) {
    throw new BadRequestException('componentKey cannot be empty or whitespace');
  }

  if (params.entryKind === RefundAllocationEntryKind.REVERSAL) {
    if (!params.reversesAllocationId || params.reversesAllocationId.trim().length === 0) {
      throw new BadRequestException('reversesAllocationId is required for REVERSAL entries');
    }
    const expectedRevKey = `REV:${params.reversesAllocationId}`;
    if (trimmedKey && trimmedKey !== expectedRevKey) {
      throw new BadRequestException(`REVERSAL componentKey must equal "${expectedRevKey}"`);
    }
    return expectedRevKey;
  }

  if (params.reversesAllocationId !== undefined && params.reversesAllocationId !== null) {
    throw new BadRequestException('ALLOCATION entries must not specify reversesAllocationId');
  }

  if (trimmedKey && trimmedKey.startsWith('REV:')) {
    throw new BadRequestException(
      'ALLOCATION componentKey cannot start with reserved "REV:" prefix',
    );
  }

  if (params.orderItemId) {
    const expectedItemKey = `ITEM:${params.orderItemId}`;
    if (trimmedKey && trimmedKey !== expectedItemKey) {
      throw new BadRequestException(
        `Item allocation componentKey must equal "${expectedItemKey}"`,
      );
    }
    return expectedItemKey;
  }

  if (trimmedKey && trimmedKey.startsWith('ITEM:')) {
    throw new BadRequestException(
      'componentKey with "ITEM:" prefix requires a matching orderItemId',
    );
  }

  return trimmedKey ?? 'VO';
}

@Injectable()
export class RefundAllocationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    input: CreateRefundAllocationInput,
    tx?: Prisma.TransactionClient,
  ): Promise<RefundVendorOrderAllocation> {
    const entryKind = input.entryKind ?? RefundAllocationEntryKind.ALLOCATION;

    const amount = parseExactMonetary2dp(input.amount, 'amount', {
      allowZero: false,
      allowNegative: entryKind === RefundAllocationEntryKind.REVERSAL,
      onlyNegative: entryKind === RefundAllocationEntryKind.REVERSAL,
    });

    const componentKey = resolveCanonicalComponentKey({
      entryKind,
      orderItemId: input.orderItemId ?? null,
      componentKey: input.componentKey,
      reversesAllocationId: input.reversesAllocationId ?? null,
    });

    const targetCurrency = input.currency ?? 'JMD';

    const executeCreate = async (
      c: Prisma.TransactionClient | PrismaService,
    ): Promise<RefundVendorOrderAllocation> => {
      if (
        typeof (c as any).refund?.findUnique === 'function' &&
        typeof (c as any).vendorOrder?.findUnique === 'function'
      ) {
        const refund = await (c as any).refund.findUnique({
          where: { id: input.refundId },
          select: {
            id: true,
            status: true,
            payment: { select: { orderId: true, currency: true } },
          },
        });
        if (!refund) {
          throw new NotFoundException(`Refund "${input.refundId}" not found`);
        }
        if (refund.status === RefundStatus.FAILED) {
          throw new BadRequestException(
            'Cannot create allocation or reversal for a FAILED refund',
          );
        }

        const vendorOrder = await (c as any).vendorOrder.findUnique({
          where: { id: input.vendorOrderId },
          select: { id: true, orderId: true },
        });
        if (!vendorOrder) {
          throw new NotFoundException(`VendorOrder "${input.vendorOrderId}" not found`);
        }
        if (vendorOrder.orderId !== refund.payment.orderId) {
          throw new BadRequestException(
            'VendorOrder does not belong to the same order as the refund payment',
          );
        }
        if (targetCurrency !== refund.payment.currency) {
          throw new BadRequestException(
            `Allocation currency "${targetCurrency}" does not match payment currency "${refund.payment.currency}"`,
          );
        }

        if (input.orderItemId && typeof (c as any).orderItem?.findUnique === 'function') {
          const orderItem = await (c as any).orderItem.findUnique({
            where: { id: input.orderItemId },
            select: { id: true, vendorOrderId: true },
          });
          if (!orderItem) {
            throw new NotFoundException(`OrderItem "${input.orderItemId}" not found`);
          }
          if (orderItem.vendorOrderId !== input.vendorOrderId) {
            throw new BadRequestException(
              `OrderItem "${input.orderItemId}" does not belong to VendorOrder "${input.vendorOrderId}"`,
            );
          }
        }

        if (
          entryKind === RefundAllocationEntryKind.REVERSAL &&
          typeof (c as any).refundVendorOrderAllocation?.findUnique === 'function'
        ) {
          if (typeof (c as any).$queryRaw === 'function') {
            await (c as any).$queryRaw(
              Prisma.sql`SELECT "id" FROM "refund_vendor_order_allocations" WHERE "id" = ${input.reversesAllocationId!} FOR UPDATE`,
            );
          }
          const original = await (c as any).refundVendorOrderAllocation.findUnique({
            where: { id: input.reversesAllocationId! },
          });
          if (!original) {
            throw new NotFoundException(
              `Original allocation "${input.reversesAllocationId}" not found`,
            );
          }
          if (original.entryKind !== RefundAllocationEntryKind.ALLOCATION) {
            throw new BadRequestException('Only original ALLOCATION entries can be reversed');
          }
          if (typeof (c as any).vendorReceivable?.findUnique === 'function') {
            const existingReceivable = await (c as any).vendorReceivable.findUnique({
              where: { allocationId: original.id },
              select: { id: true, status: true },
            });
            if (existingReceivable) {
              throw new ConflictException(
                `Cannot reverse allocation "${original.id}" because VendorReceivable "${existingReceivable.id}" (${existingReceivable.status}) already references it`,
              );
            }
          }
          if (original.refundId !== input.refundId) {
            throw new BadRequestException(
              'Reversal refundId must match original allocation refundId',
            );
          }
          if (original.vendorOrderId !== input.vendorOrderId) {
            throw new BadRequestException(
              'Reversal vendorOrderId must match original allocation vendorOrderId',
            );
          }
          if ((original.orderItemId ?? null) !== (input.orderItemId ?? null)) {
            throw new BadRequestException(
              'Reversal orderItemId must match original allocation orderItemId',
            );
          }
          if (original.allocationType !== input.allocationType) {
            throw new BadRequestException(
              'Reversal allocationType must match original allocation allocationType',
            );
          }
          if (original.currency !== targetCurrency) {
            throw new BadRequestException(
              'Reversal currency must match original allocation currency',
            );
          }
          if (amount.abs().gt(new Prisma.Decimal(original.amount))) {
            throw new BadRequestException(
              'Reversal amount exceeds original allocation amount eligible for reversal',
            );
          }
        }
      }

      return (c as any).refundVendorOrderAllocation.create({
        data: {
          refundId: input.refundId,
          vendorOrderId: input.vendorOrderId,
          orderItemId: input.orderItemId ?? null,
          componentKey,
          entryKind,
          reversesAllocationId: input.reversesAllocationId ?? null,
          amount,
          currency: targetCurrency,
          allocationType: input.allocationType,
          reason: input.reason ?? null,
        },
      });
    };

    if (tx) {
      return executeCreate(tx);
    }
    if (typeof (this.prisma as any).$transaction === 'function') {
      return this.prisma.$transaction((innerTx) => executeCreate(innerTx), {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      });
    }
    return executeCreate(this.prisma);
  }

  async findById(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<RefundVendorOrderAllocation | null> {
    const client = tx ?? this.prisma;
    return client.refundVendorOrderAllocation.findUnique({
      where: { id },
    });
  }

  async findByRefundId(
    refundId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<RefundVendorOrderAllocation[]> {
    const client = tx ?? this.prisma;
    return client.refundVendorOrderAllocation.findMany({
      where: { refundId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async findByVendorOrderId(
    vendorOrderId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<RefundVendorOrderAllocation[]> {
    const client = tx ?? this.prisma;
    return client.refundVendorOrderAllocation.findMany({
      where: { vendorOrderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async findByOrderItemId(
    orderItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<RefundVendorOrderAllocation[]> {
    const client = tx ?? this.prisma;
    return client.refundVendorOrderAllocation.findMany({
      where: { orderItemId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async findByReversesAllocationId(
    reversesAllocationId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<RefundVendorOrderAllocation | null> {
    const client = tx ?? this.prisma;
    return client.refundVendorOrderAllocation.findUnique({
      where: { reversesAllocationId },
    });
  }

  async findUnique(
    refundId: string,
    vendorOrderId: string,
    allocationType: RefundAllocationType,
    componentKeyOrTx?: string | Prisma.TransactionClient,
    maybeTx?: Prisma.TransactionClient,
  ): Promise<RefundVendorOrderAllocation | null> {
    const componentKey = typeof componentKeyOrTx === 'string' ? componentKeyOrTx : 'VO';
    const client =
      (typeof componentKeyOrTx === 'string' ? maybeTx : componentKeyOrTx) ?? this.prisma;
    return client.refundVendorOrderAllocation.findUnique({
      where: {
        refundId_vendorOrderId_allocationType_componentKey: {
          refundId,
          vendorOrderId,
          allocationType,
          componentKey,
        },
      },
    });
  }

  async sumByRefundIdDecimal(
    refundId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Prisma.Decimal> {
    const client = tx ?? this.prisma;
    const result = await client.refundVendorOrderAllocation.aggregate({
      where: { refundId },
      _sum: { amount: true },
    });
    return result._sum.amount ? new Prisma.Decimal(result._sum.amount) : new Prisma.Decimal(0);
  }

  async sumByVendorOrderIdDecimal(
    vendorOrderId: string,
    tx?: Prisma.TransactionClient,
    options?: { includeFailed?: boolean },
  ): Promise<Prisma.Decimal> {
    const client = tx ?? this.prisma;
    const includeFailed = options?.includeFailed ?? false;
    const result = await client.refundVendorOrderAllocation.aggregate({
      where: {
        vendorOrderId,
        ...(includeFailed ? {} : { refund: { status: { not: RefundStatus.FAILED } } }),
      },
      _sum: { amount: true },
    });
    return result._sum.amount ? new Prisma.Decimal(result._sum.amount) : new Prisma.Decimal(0);
  }

  async sumByOrderItemIdDecimal(
    orderItemId: string,
    tx?: Prisma.TransactionClient,
    options?: { includeFailed?: boolean },
  ): Promise<Prisma.Decimal> {
    const client = tx ?? this.prisma;
    const includeFailed = options?.includeFailed ?? false;
    const result = await client.refundVendorOrderAllocation.aggregate({
      where: {
        orderItemId,
        ...(includeFailed ? {} : { refund: { status: { not: RefundStatus.FAILED } } }),
      },
      _sum: { amount: true },
    });
    return result._sum.amount ? new Prisma.Decimal(result._sum.amount) : new Prisma.Decimal(0);
  }
}
