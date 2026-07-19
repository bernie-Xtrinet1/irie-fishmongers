import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DeliveryZone } from '@prisma/client';

import { CreateDeliveryZoneDto } from '../dto/create-delivery-zone.dto';
import { UpdateDeliveryZoneDto } from '../dto/update-delivery-zone.dto';
import { DeliveryZonesRepository } from '../repositories/delivery-zones.repository';

@Injectable()
export class DeliveryZonesService {
  constructor(private readonly deliveryZonesRepository: DeliveryZonesRepository) {}

  list(): Promise<DeliveryZone[]> {
    return this.deliveryZonesRepository.findAll();
  }

  async create(dto: CreateDeliveryZoneDto): Promise<DeliveryZone> {
    const existing = await this.deliveryZonesRepository.findByCode(dto.code);
    if (existing) {
      throw new ConflictException(`A delivery zone with code "${dto.code}" already exists`);
    }
    return this.deliveryZonesRepository.create(dto);
  }

  async update(id: string, dto: UpdateDeliveryZoneDto): Promise<DeliveryZone> {
    const zone = await this.deliveryZonesRepository.findById(id);
    if (!zone) {
      throw new NotFoundException('Delivery zone not found');
    }
    return this.deliveryZonesRepository.update(id, dto);
  }
}
