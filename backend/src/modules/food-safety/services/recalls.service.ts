import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { RecallStatus } from '@prisma/client';

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
    };
  }
}
