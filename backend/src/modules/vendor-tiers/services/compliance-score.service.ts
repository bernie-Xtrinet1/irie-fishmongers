import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { ComplianceScoreSignalsRepository } from '../repositories/compliance-score-signals.repository';
import { ComplianceBand, deriveComplianceBand } from '../utils/compliance-score-band.util';
import {
  ComplianceScoreBreakdown,
  computeComplianceScore,
} from '../utils/compliance-score-formula.util';

export interface ComplianceScoreExplanation {
  vendorId: string;
  score: number | null;
  band: ComplianceBand;
  updatedAt: Date | null;
  breakdown: ComplianceScoreBreakdown;
}

@Injectable()
export class ComplianceScoreService {
  private readonly logger = new Logger(ComplianceScoreService.name);

  constructor(
    private readonly vendorsRepository: VendorsRepository,
    private readonly signalsRepository: ComplianceScoreSignalsRepository,
  ) {}

  // Re-derives the full score from the vendor's CURRENT signal state and
  // does a plain write-through UPDATE. This is idempotent by construction:
  // concurrent recomputes for the same vendor are safe because neither is an
  // incremental adjustment - each observes the live signal counts and the
  // last write simply reflects the most complete state it saw. No lock is
  // needed at current volume (a per-vendor queue would be a future concern
  // at much higher event rates). Returns null if the vendor no longer
  // exists (an event can arrive after a vendor is gone).
  async recompute(vendorId: string): Promise<number | null> {
    const vendor = await this.vendorsRepository.findById(vendorId);
    if (!vendor) {
      this.logger.warn(`Skipping compliance recompute for missing vendor ${vendorId}`);
      return null;
    }

    const signals = await this.signalsRepository.gather(vendorId, vendor.tier);
    const { score } = computeComplianceScore(signals);
    await this.vendorsRepository.updateComplianceScore(vendorId, score);
    return score;
  }

  // On-demand per-category breakdown for the admin explain view. Recomputes
  // from the same signals + formula the write-through path uses - not stored,
  // not duplicated.
  async explain(vendorId: string): Promise<ComplianceScoreBreakdown> {
    const vendor = await this.vendorsRepository.findById(vendorId);
    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }
    const signals = await this.signalsRepository.gather(vendorId, vendor.tier);
    return computeComplianceScore(signals);
  }

  // The full admin explanation: the STORED score/timestamp/band (what
  // customers see) alongside a freshly recomputed breakdown. The breakdown's
  // own score may differ from the stored score if signals have changed since
  // the last write-through - that difference is itself useful to a moderator.
  async describe(vendorId: string): Promise<ComplianceScoreExplanation> {
    const vendor = await this.vendorsRepository.findById(vendorId);
    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }
    const signals = await this.signalsRepository.gather(vendorId, vendor.tier);
    return {
      vendorId,
      score: vendor.complianceScore,
      band: deriveComplianceBand(vendor.complianceScore),
      updatedAt: vendor.complianceScoreUpdatedAt,
      breakdown: computeComplianceScore(signals),
    };
  }
}
