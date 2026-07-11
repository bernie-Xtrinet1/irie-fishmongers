import { Injectable } from '@nestjs/common';
import { EmergencyResponse, EmergencyResponseStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface UpdateEmergencyResponseInput {
  status?: EmergencyResponseStatus;
  assignedToId?: string;
  actionsTaken?: string;
  rootCause?: string;
  correctiveAction?: string;
  preventiveAction?: string;
  acknowledgedAt?: Date;
  resolvedAt?: Date;
}

@Injectable()
export class EmergencyResponsesRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(alertId: string): Promise<EmergencyResponse> {
    return this.prisma.emergencyResponse.create({ data: { alertId } });
  }

  findById(id: string): Promise<EmergencyResponse | null> {
    return this.prisma.emergencyResponse.findUnique({ where: { id } });
  }

  update(id: string, input: UpdateEmergencyResponseInput): Promise<EmergencyResponse> {
    return this.prisma.emergencyResponse.update({ where: { id }, data: input });
  }

  findMany(status?: EmergencyResponseStatus): Promise<EmergencyResponse[]> {
    return this.prisma.emergencyResponse.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }
}
