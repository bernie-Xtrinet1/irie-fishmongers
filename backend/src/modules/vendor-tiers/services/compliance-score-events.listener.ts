import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { ColdChainAlertRaisedEvent } from '../../../common/events/cold-chain-alert-raised.event';
import { QualityInspectionRecordedEvent } from '../../../common/events/quality-inspection-recorded.event';
import { RecallStatusChangedEvent } from '../../../common/events/recall-status-changed.event';
import { RegulatoryCertificationStatusChangedEvent } from '../../../common/events/regulatory-certification-status-changed.event';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { ComplianceScoreService } from './compliance-score.service';

// Keeps Vendor.complianceScore current in response to the food-safety signal
// changes that feed the formula (Phase 13C). Each handler runs AFTER the
// triggering mutation has committed and is fully guarded: a recompute
// failure here is logged and swallowed so it can never roll back the
// original operational action - the nightly sweep is the repair backstop.
@Injectable()
export class ComplianceScoreEventsListener {
  private readonly logger = new Logger(ComplianceScoreEventsListener.name);

  constructor(
    private readonly complianceScoreService: ComplianceScoreService,
    private readonly vendorsRepository: VendorsRepository,
  ) {}

  @OnEvent(ColdChainAlertRaisedEvent.eventName)
  async onColdChainAlert(event: ColdChainAlertRaisedEvent): Promise<void> {
    // The cold-chain event carries the vendor's userId, not vendorId.
    const vendor = await this.vendorsRepository.findByUserId(event.vendorUserId);
    if (!vendor) {
      return;
    }
    await this.safeRecompute(vendor.id, ColdChainAlertRaisedEvent.eventName);
  }

  @OnEvent(QualityInspectionRecordedEvent.eventName)
  async onQualityInspection(event: QualityInspectionRecordedEvent): Promise<void> {
    await this.safeRecompute(event.vendorId, QualityInspectionRecordedEvent.eventName);
  }

  @OnEvent(RecallStatusChangedEvent.eventName)
  async onRecallStatusChanged(event: RecallStatusChangedEvent): Promise<void> {
    for (const vendorId of event.vendorIds) {
      await this.safeRecompute(vendorId, RecallStatusChangedEvent.eventName);
    }
  }

  @OnEvent(RegulatoryCertificationStatusChangedEvent.eventName)
  async onCertificationStatusChanged(event: RegulatoryCertificationStatusChangedEvent): Promise<void> {
    await this.safeRecompute(event.vendorId, RegulatoryCertificationStatusChangedEvent.eventName);
  }

  private async safeRecompute(vendorId: string, source: string): Promise<void> {
    try {
      await this.complianceScoreService.recompute(vendorId);
    } catch (error) {
      this.logger.error(
        `Compliance recompute from ${source} failed for vendor ${vendorId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
