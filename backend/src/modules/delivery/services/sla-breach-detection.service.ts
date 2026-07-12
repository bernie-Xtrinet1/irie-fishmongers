import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { SLABreachesRepository } from '../repositories/sla-breaches.repository';

// OVERDUE_IN_TRANSIT can only be detected by the passage of time - the
// delivery hasn't reached a terminal state yet, so no existing state
// transition can trigger this check the way DeliveriesService.updateStatus
// triggers LATE_DELIVERY. A cron is the correct tool here, not a workaround.
// Every 5 minutes balances promptness (a dispatcher sees an overdue
// delivery reasonably soon) against load (this scans the full deliveries
// table every tick).
@Injectable()
export class SLABreachDetectionService {
  private readonly logger = new Logger(SLABreachDetectionService.name);

  constructor(private readonly slaBreachesRepository: SLABreachesRepository) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async detectOverdueInTransitDeliveries(): Promise<void> {
    const now = new Date();
    const candidates = await this.slaBreachesRepository.findOverdueInTransitCandidates(now);

    for (const candidate of candidates) {
      const minutesLate = Math.round(
        (now.getTime() - candidate.customerDeliveryWindowEnd.getTime()) / 60_000,
      );
      await this.slaBreachesRepository.upsert({
        deliveryId: candidate.id,
        type: 'OVERDUE_IN_TRANSIT',
        scheduledEnd: candidate.customerDeliveryWindowEnd,
        minutesLate,
      });
    }

    if (candidates.length > 0) {
      this.logger.warn(`Detected ${candidates.length} newly overdue in-transit delivery(ies)`);
    }
  }
}
