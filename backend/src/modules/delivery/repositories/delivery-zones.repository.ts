import { Injectable } from '@nestjs/common';
import { DeliveryZone, Parish } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateDeliveryZoneInput {
  name: string;
  code: string;
  description?: string;
}

export interface UpdateDeliveryZoneInput {
  name?: string;
  description?: string;
  active?: boolean;
}

@Injectable()
export class DeliveryZonesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(activeOnly = false): Promise<DeliveryZone[]> {
    return this.prisma.deliveryZone.findMany({
      where: activeOnly ? { active: true } : undefined,
      orderBy: { code: 'asc' },
    });
  }

  findById(id: string): Promise<DeliveryZone | null> {
    return this.prisma.deliveryZone.findUnique({ where: { id } });
  }

  findByCode(code: string): Promise<DeliveryZone | null> {
    return this.prisma.deliveryZone.findUnique({ where: { code } });
  }

  create(input: CreateDeliveryZoneInput): Promise<DeliveryZone> {
    return this.prisma.deliveryZone.create({ data: input });
  }

  update(id: string, input: UpdateDeliveryZoneInput): Promise<DeliveryZone> {
    return this.prisma.deliveryZone.update({ where: { id }, data: input });
  }

  async findZoneIdForParish(parish: Parish): Promise<string | null> {
    const mapping = await this.prisma.deliveryZoneParish.findUnique({
      where: { parish },
      select: { zoneId: true },
    });
    return mapping?.zoneId ?? null;
  }
}
