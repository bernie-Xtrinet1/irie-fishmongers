import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EmergencyResponse, EmergencyResponseStatus } from '@prisma/client';

import { UpdateEmergencyResponseStatusDto } from '../dto/update-emergency-response-status.dto';
import { EmergencyResponseResponseEntity } from '../entities/emergency-response-response.entity';
import { EmergencyResponsesRepository } from '../repositories/emergency-responses.repository';

// Linear, no skipping - matches RecallsService's/QualityInspectionsService's
// "no silent auto-clear of a compliance hold" discipline: an EMERGENCY
// can't be closed out without first being acknowledged and contained.
const ALLOWED_STATUS_TRANSITIONS: Record<EmergencyResponseStatus, EmergencyResponseStatus[]> = {
  OPEN: ['ACKNOWLEDGED'],
  ACKNOWLEDGED: ['CONTAINED'],
  CONTAINED: ['RESOLVED'],
  RESOLVED: [],
};

@Injectable()
export class EmergencyResponsesService {
  constructor(private readonly responsesRepository: EmergencyResponsesRepository) {}

  async createForAlert(alertId: string): Promise<EmergencyResponseResponseEntity> {
    const response = await this.responsesRepository.create(alertId);
    return EmergencyResponsesService.toResponse(response);
  }

  async acknowledge(userId: string, id: string): Promise<EmergencyResponseResponseEntity> {
    const response = await this.responsesRepository.findById(id);
    if (!response) {
      throw new NotFoundException('Emergency response not found');
    }
    if (!ALLOWED_STATUS_TRANSITIONS[response.status].includes('ACKNOWLEDGED')) {
      throw new BadRequestException(`Cannot acknowledge a ${response.status} emergency response`);
    }

    const updated = await this.responsesRepository.update(id, {
      status: 'ACKNOWLEDGED',
      assignedToId: userId,
      acknowledgedAt: new Date(),
    });

    return EmergencyResponsesService.toResponse(updated);
  }

  async updateStatus(
    id: string,
    dto: UpdateEmergencyResponseStatusDto,
  ): Promise<EmergencyResponseResponseEntity> {
    const response = await this.responsesRepository.findById(id);
    if (!response) {
      throw new NotFoundException('Emergency response not found');
    }
    if (!ALLOWED_STATUS_TRANSITIONS[response.status].includes(dto.status)) {
      throw new BadRequestException(`Cannot move a ${response.status} emergency response to ${dto.status}`);
    }
    if (dto.status === 'RESOLVED' && (!dto.rootCause || !dto.correctiveAction)) {
      throw new BadRequestException('Resolving an emergency response requires rootCause and correctiveAction');
    }

    const updated = await this.responsesRepository.update(id, {
      status: dto.status,
      actionsTaken: dto.actionsTaken,
      rootCause: dto.rootCause,
      correctiveAction: dto.correctiveAction,
      preventiveAction: dto.preventiveAction,
      resolvedAt: dto.status === 'RESOLVED' ? new Date() : undefined,
    });

    return EmergencyResponsesService.toResponse(updated);
  }

  async list(status?: EmergencyResponseStatus): Promise<EmergencyResponseResponseEntity[]> {
    const responses = await this.responsesRepository.findMany(status);
    return responses.map((response) => EmergencyResponsesService.toResponse(response));
  }

  private static toResponse(response: EmergencyResponse): EmergencyResponseResponseEntity {
    return {
      id: response.id,
      alertId: response.alertId,
      assignedToId: response.assignedToId,
      status: response.status,
      actionsTaken: response.actionsTaken,
      rootCause: response.rootCause,
      correctiveAction: response.correctiveAction,
      preventiveAction: response.preventiveAction,
      acknowledgedAt: response.acknowledgedAt,
      resolvedAt: response.resolvedAt,
      createdAt: response.createdAt,
    };
  }
}
