import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FoodSafetyIncident, IncidentStatus } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { CreateIncidentDto } from '../dto/create-incident.dto';
import { ListIncidentsDto } from '../dto/list-incidents.dto';
import { IncidentResponseEntity } from '../entities/incident-response.entity';
import { PaginatedIncidentsEntity } from '../entities/paginated-incidents.entity';
import { FoodSafetyIncidentsRepository } from '../repositories/food-safety-incidents.repository';
import { ComplianceAuditLogService } from './compliance-audit-log.service';
import { SeafoodLotsService } from './seafood-lots.service';

const ALLOWED_STATUS_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  OPEN: ['INVESTIGATING', 'RESOLVED', 'CLOSED'],
  INVESTIGATING: ['RESOLVED', 'CLOSED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
};

@Injectable()
export class FoodSafetyIncidentsService {
  constructor(
    private readonly incidentsRepository: FoodSafetyIncidentsRepository,
    private readonly seafoodLotsService: SeafoodLotsService,
    private readonly auditLogService: ComplianceAuditLogService,
  ) {}

  async report(user: RequestUser, dto: CreateIncidentDto): Promise<IncidentResponseEntity> {
    await this.seafoodLotsService.assertOwnedByRequester(user, dto.lotId);

    const incident = await this.incidentsRepository.create({
      lotId: dto.lotId,
      reportedById: user.id,
      severity: dto.severity,
      description: dto.description,
      photoUrl: dto.photoUrl,
    });

    return FoodSafetyIncidentsService.toResponse(incident);
  }

  async getForLot(
    user: RequestUser,
    lotId: string,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedIncidentsEntity> {
    await this.seafoodLotsService.assertOwnedByRequester(user, lotId);

    const { items, total } = await this.incidentsRepository.findByLotId(lotId, {
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    });

    return {
      items: items.map((item) => FoodSafetyIncidentsService.toResponse(item)),
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async list(dto: ListIncidentsDto): Promise<PaginatedIncidentsEntity> {
    const { items, total } = await this.incidentsRepository.findMany(
      { severity: dto.severity, status: dto.status },
      { skip: (dto.page - 1) * dto.pageSize, take: dto.pageSize },
    );

    return {
      items: items.map((item) => FoodSafetyIncidentsService.toResponse(item)),
      total,
      page: dto.page,
      pageSize: dto.pageSize,
    };
  }

  async updateStatus(
    userId: string,
    id: string,
    status: IncidentStatus,
    correctiveAction?: string,
    ipAddress?: string,
  ): Promise<IncidentResponseEntity> {
    const incident = await this.incidentsRepository.findById(id);
    if (!incident) {
      throw new NotFoundException('Food safety incident not found');
    }
    if (!ALLOWED_STATUS_TRANSITIONS[incident.status].includes(status)) {
      throw new BadRequestException(`Cannot move a ${incident.status} incident to ${status}`);
    }

    const updated = await this.incidentsRepository.updateStatus(id, status, {
      correctiveAction,
      resolvedAt: status === 'RESOLVED' ? new Date() : undefined,
    });

    await this.auditLogService.record({
      userId,
      action: 'FOOD_SAFETY_INCIDENT_STATUS_UPDATED',
      entityType: 'FoodSafetyIncident',
      entityId: id,
      beforeValue: { status: incident.status },
      afterValue: { status: updated.status },
      ipAddress,
      reason: correctiveAction,
    });

    return FoodSafetyIncidentsService.toResponse(updated);
  }

  private static toResponse(incident: FoodSafetyIncident): IncidentResponseEntity {
    return {
      id: incident.id,
      lotId: incident.lotId,
      reportedById: incident.reportedById,
      severity: incident.severity,
      status: incident.status,
      description: incident.description,
      photoUrl: incident.photoUrl,
      correctiveAction: incident.correctiveAction,
      resolvedAt: incident.resolvedAt,
      createdAt: incident.createdAt,
    };
  }
}
