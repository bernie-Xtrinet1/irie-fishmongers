import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { CatchRegisteredEvent } from '../../../common/events/catch-registered.event';
import { DeliveryRejectedEvent } from '../../../common/events/delivery-rejected.event';
import { PrismaService } from '../../../database/prisma.service';
import { FoodSafetyIncidentsRepository } from '../repositories/food-safety-incidents.repository';
import { CustodyEventsRepository } from '../repositories/custody-events.repository';

/**
 * Consumes DeliveryRejectedEvent and raises one FoodSafetyIncident per
 * distinct seafood lot among the rejected vendor order's items. Calls the
 * repository directly rather than FoodSafetyIncidentsService.report()
 * (gated to vendor self-reports via assertOwnedByRequester) since this is a
 * system-triggered report on the customer's behalf, not identity spoofing.
 *
 * Also consumes CatchRegisteredEvent to write the LANDING chain-of-custody
 * event - CatchesModule can't call CustodyEventsRepository directly
 * without a circular import.
 */
@Injectable()
export class FoodSafetyEventsListener {
  constructor(
    private readonly prisma: PrismaService,
    private readonly incidentsRepository: FoodSafetyIncidentsRepository,
    private readonly custodyEventsRepository: CustodyEventsRepository,
  ) {}

  @OnEvent(DeliveryRejectedEvent.eventName)
  async onDeliveryRejected(event: DeliveryRejectedEvent): Promise<void> {
    const items = await this.prisma.orderItem.findMany({
      where: { vendorOrderId: event.vendorOrderId },
      select: { product: { select: { lotId: true } } },
    });

    const lotIds = new Set(
      items
        .map((item) => item.product.lotId)
        .filter((lotId): lotId is string => lotId !== null),
    );

    for (const lotId of lotIds) {
      await this.incidentsRepository.create({
        lotId,
        reportedById: event.customerId,
        severity: 'MEDIUM',
        description: `Customer rejected delivery: ${event.reason}`,
      });
    }
  }

  @OnEvent(CatchRegisteredEvent.eventName)
  async onCatchRegistered(event: CatchRegisteredEvent): Promise<void> {
    await this.custodyEventsRepository.create({
      catchId: event.catchId,
      eventType: 'LANDING',
      toUserId: event.fishermanUserId,
    });
  }
}
