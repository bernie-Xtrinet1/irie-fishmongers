import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RecallStatus } from '@prisma/client';

import { RecallIssuedEvent } from '../../../common/events/recall-issued.event';
import { RecallStatusChangedEvent } from '../../../common/events/recall-status-changed.event';
import { computeRetentionExpiresAt } from '../../../common/utils/retention.util';
import { CreateRecallDto } from '../dto/create-recall.dto';
import { ListRecallsDto } from '../dto/list-recalls.dto';
import { UpdateRecallStatusDto } from '../dto/update-recall-status.dto';
import { AffectedOrderEntity } from '../entities/affected-order.entity';
import { PaginatedRecallsEntity } from '../entities/paginated-recalls.entity';
import { RecallResponseEntity } from '../entities/recall-response.entity';
import { AffectedOrderItem, RecallsRepository, RecallWithLots } from '../repositories/recalls.repository';
import { SeafoodLotsRepository } from '../repositories/seafood-lots.repository';
import { ComplianceAuditLogService } from './compliance-audit-log.service';

const ALLOWED_STATUS_TRANSITIONS: Record<RecallStatus, RecallStatus[]> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['INVESTIGATING'],
  INVESTIGATING: ['RESOLVED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
};

@Injectable()
export class RecallsService {
  constructor(
    private readonly recallsRepository: RecallsRepository,
    private readonly lotsRepository: SeafoodLotsRepository,
    private readonly auditLogService: ComplianceAuditLogService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(userId: string, dto: CreateRecallDto): Promise<RecallResponseEntity> {
    for (const lotId of dto.lotIds) {
      const lot = await this.lotsRepository.findById(lotId);
      if (!lot) {
        throw new NotFoundException(`Seafood lot ${lotId} not found`);
      }
    }

    const recall = await this.recallsRepository.create({
      severityClass: dto.severityClass,
      reason: dto.reason,
      createdById: userId,
      lotIds: dto.lotIds,
    });

    return RecallsService.toResponse(recall);
  }

  async updateStatus(
    userId: string,
    id: string,
    dto: UpdateRecallStatusDto,
    ipAddress?: string,
  ): Promise<RecallResponseEntity> {
    const recall = await this.recallsRepository.findById(id);
    if (!recall) {
      throw new NotFoundException('Recall not found');
    }
    if (!ALLOWED_STATUS_TRANSITIONS[recall.status].includes(dto.status)) {
      throw new BadRequestException(`Cannot move a ${recall.status} recall to ${dto.status}`);
    }

    const updated = await this.recallsRepository.updateStatus(id, dto.status, {
      rootCause: dto.rootCause,
      resolutionNotes: dto.resolutionNotes,
      closedAt: dto.status === 'CLOSED' ? new Date() : undefined,
    });

    if (dto.status === 'ACTIVE') {
      for (const recallLot of recall.lots) {
        await this.lotsRepository.updateStatus(
          recallLot.lotId,
          'RECALLED',
          `Recalled (${recall.severityClass}): ${recall.reason}`,
        );
      }

      await this.notifyAffectedCustomers(id, recall.reason);
    }

    await this.auditLogService.record({
      userId,
      action: 'RECALL_STATUS_UPDATED',
      entityType: 'Recall',
      entityId: id,
      beforeValue: { status: recall.status },
      afterValue: { status: updated.status },
      ipAddress,
      reason: dto.rootCause ?? dto.resolutionNotes,
    });

    // Any recall status change may raise or lower the compliance score of
    // every vendor whose lots the recall touches (an ACTIVE/INVESTIGATING
    // recall deducts; RESOLVED/CLOSED lets the score recover). Emitted after
    // the status update and lot/audit writes commit (Phase 13C).
    await this.emitStatusChanged(id, recall.lots, updated.status);

    return RecallsService.toResponse(updated);
  }

  async list(dto: ListRecallsDto): Promise<PaginatedRecallsEntity> {
    const { items, total } = await this.recallsRepository.findMany(dto.status, {
      skip: (dto.page - 1) * dto.pageSize,
      take: dto.pageSize,
    });

    return {
      items: items.map((item) => RecallsService.toResponse(item)),
      total,
      page: dto.page,
      pageSize: dto.pageSize,
    };
  }

  async getById(id: string): Promise<RecallResponseEntity> {
    const recall = await this.recallsRepository.findById(id);
    if (!recall) {
      throw new NotFoundException('Recall not found');
    }
    return RecallsService.toResponse(recall);
  }

  async getAffectedOrders(id: string): Promise<AffectedOrderEntity[]> {
    const recall = await this.recallsRepository.findById(id);
    if (!recall) {
      throw new NotFoundException('Recall not found');
    }

    const lotIds = recall.lots.map((recallLot) => recallLot.lotId);
    const orderItems = await this.recallsRepository.findAffectedOrderItems(lotIds);

    return orderItems.map((item) => RecallsService.toAffectedOrder(item));
  }

  // Resolves the DISTINCT vendors whose lots a recall touches and emits a
  // single RecallStatusChangedEvent for the compliance-score listener. A
  // recall spanning three of one vendor's lots yields that vendor once.
  private async emitStatusChanged(
    recallId: string,
    lots: { lotId: string }[],
    status: string,
  ): Promise<void> {
    const vendorIds = new Set<string>();
    for (const recallLot of lots) {
      const lot = await this.lotsRepository.findById(recallLot.lotId);
      if (lot) {
        vendorIds.add(lot.vendorId);
      }
    }
    if (vendorIds.size === 0) {
      return;
    }
    await this.eventEmitter.emitAsync(
      RecallStatusChangedEvent.eventName,
      new RecallStatusChangedEvent(recallId, status, [...vendorIds]),
    );
  }

  // seafood-compliance-rules.md's recall workflow: Identify Customers ->
  // Notify Stakeholders. Emits one RecallIssuedEvent per affected order
  // (an affected customer may have multiple orders touching the recalled
  // lots) - lotNumber is resolved per distinct lotId and cached, since
  // AffectedOrderEntity only carries the lotId, not the human-readable
  // lotNumber.
  private async notifyAffectedCustomers(recallId: string, reason: string): Promise<void> {
    const affectedOrders = await this.getAffectedOrders(recallId);
    const lotNumberByLotId = new Map<string, string>();

    for (const order of affectedOrders) {
      let lotNumber = lotNumberByLotId.get(order.lotId);
      if (!lotNumber) {
        const lot = await this.lotsRepository.findById(order.lotId);
        lotNumber = lot?.lotNumber ?? order.lotId;
        lotNumberByLotId.set(order.lotId, lotNumber);
      }

      await this.eventEmitter.emitAsync(
        RecallIssuedEvent.eventName,
        new RecallIssuedEvent(order.customerId, order.orderId, lotNumber, reason),
      );
    }
  }

  private static toAffectedOrder(item: AffectedOrderItem): AffectedOrderEntity {
    return {
      orderId: item.vendorOrder.order.id,
      vendorOrderId: item.vendorOrderId,
      customerId: item.vendorOrder.order.customerId,
      customerEmail: item.vendorOrder.order.customer.email,
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity,
      lotId: item.product.lotId!,
    };
  }

  private static toResponse(recall: RecallWithLots): RecallResponseEntity {
    return {
      id: recall.id,
      severityClass: recall.severityClass,
      status: recall.status,
      reason: recall.reason,
      rootCause: recall.rootCause,
      resolutionNotes: recall.resolutionNotes,
      createdById: recall.createdById,
      lotIds: recall.lots.map((recallLot) => recallLot.lotId),
      closedAt: recall.closedAt,
      createdAt: recall.createdAt,
      retentionExpiresAt: computeRetentionExpiresAt(recall.createdAt),
    };
  }
}
