import { Injectable } from '@nestjs/common';
import { Parish } from '@prisma/client';

import { DeliveryZonesRepository } from '../repositories/delivery-zones.repository';

/**
 * Deterministic, DB-driven parish->zone lookup (jamaica-delivery-zones.md's
 * mapping is seeded, not hardcoded here). OrdersModule cannot depend on this
 * service directly - DeliveryModule already imports OrdersModule, so
 * OrdersService resolves the same DeliveryZoneParish data via its own
 * PrismaService read instead of importing DeliveryModule back.
 */
@Injectable()
export class ZoneResolutionService {
  constructor(private readonly deliveryZonesRepository: DeliveryZonesRepository) {}

  resolveZoneForParish(parish: Parish): Promise<string | null> {
    return this.deliveryZonesRepository.findZoneIdForParish(parish);
  }
}
