import { Injectable } from '@nestjs/common';
import { Prisma, SLABreach, SLABreachType } from '@prisma/client';

import { PrismaClientOrTx } from '../../orders/repositories/orders.repository';
import { PrismaService } from '../../../database/prisma.service';

export interface CreateSLABreachInput {
  deliveryId: string;
  type: SLABreachType;
  scheduledEnd: Date;
  minutesLate: number;
}

export interface SLABreachFilters {
  resolved?: boolean;
  type?: SLABreachType;
}

export interface Page {
  skip: number;
  take: number;
}

export interface OverdueInTransitCandidate {
  id: string;
  customerDeliveryWindowEnd: Date;
}

export interface ZoneBreachCounts {
  zoneId: string;
  totalBreaches: number;
  unresolvedBreaches: number;
}

const sLABreachWithZone = Prisma.validator<Prisma.SLABreachDefaultArgs>()({
  select: {
    resolved: true,
    delivery: { select: { vendorOrder: { select: { order: { select: { deliveryZoneId: true } } } } } },
  },
});

type SLABreachWithZone = Prisma.SLABreachGetPayload<typeof sLABreachWithZone>;

@Injectable()
export class SLABreachesRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Idempotent: SLABreach has @@unique([deliveryId, type]) - the cron scan
  // runs every 5 minutes and must not create a duplicate
  // OVERDUE_IN_TRANSIT row on every tick a delivery remains overdue.
  // update: {} means a re-detected breach keeps its original
  // detectedAt/minutesLate (the moment it first became known), not the
  // latest scan's values.
  upsert(input: CreateSLABreachInput, client: PrismaClientOrTx = this.prisma): Promise<SLABreach> {
    return client.sLABreach.upsert({
      where: { deliveryId_type: { deliveryId: input.deliveryId, type: input.type } },
      create: input,
      update: {},
    });
  }

  findById(id: string): Promise<SLABreach | null> {
    return this.prisma.sLABreach.findUnique({ where: { id } });
  }

  resolve(id: string, resolvedById: string): Promise<SLABreach> {
    return this.prisma.sLABreach.update({
      where: { id },
      data: { resolved: true, resolvedAt: new Date(), resolvedById },
    });
  }

  async findMany(
    filters: SLABreachFilters,
    page: Page,
  ): Promise<{ items: SLABreach[]; total: number }> {
    const where: Prisma.SLABreachWhereInput = {
      ...(filters.resolved !== undefined ? { resolved: filters.resolved } : {}),
      ...(filters.type ? { type: filters.type } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.sLABreach.findMany({
        where,
        orderBy: { detectedAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.sLABreach.count({ where }),
    ]);

    return { items, total };
  }

  // Cron candidate query (SLABreachDetectionService): in-flight deliveries
  // past their promised window with no existing OVERDUE_IN_TRANSIT breach
  // yet. Prisma's `lt` comparison on a nullable DateTime column excludes
  // rows where the column is null, so deliveries with no scheduled window
  // (customerDeliveryWindowEnd never set) are correctly never candidates -
  // there is no promise to breach.
  findOverdueInTransitCandidates(now: Date): Promise<OverdueInTransitCandidate[]> {
    return this.prisma.delivery.findMany({
      where: {
        deliveredAt: null,
        failedAt: null,
        customerDeliveryWindowEnd: { lt: now },
        slaBreaches: { none: { type: 'OVERDUE_IN_TRANSIT' } },
      },
      select: { id: true, customerDeliveryWindowEnd: true },
    }) as Promise<OverdueInTransitCandidate[]>;
  }

  // Fleet/zone rollup (10D deliverable). Grouped in application code rather
  // than a Prisma groupBy - the zone is two relations away
  // (SLABreach -> Delivery -> VendorOrder -> Order.deliveryZoneId) and
  // Prisma's groupBy cannot group by a nested relation field.
  async getBreachCountsByZone(): Promise<ZoneBreachCounts[]> {
    const breaches = (await this.prisma.sLABreach.findMany({
      select: sLABreachWithZone.select,
    })) as SLABreachWithZone[];

    const counts = new Map<string, ZoneBreachCounts>();
    for (const breach of breaches) {
      const zoneId = breach.delivery.vendorOrder.order.deliveryZoneId;
      if (!zoneId) continue;

      const entry = counts.get(zoneId) ?? { zoneId, totalBreaches: 0, unresolvedBreaches: 0 };
      entry.totalBreaches += 1;
      if (!breach.resolved) entry.unresolvedBreaches += 1;
      counts.set(zoneId, entry);
    }

    return [...counts.values()];
  }
}
