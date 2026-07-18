import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { ComplianceScoreService } from './compliance-score.service';

const BATCH_SIZE = 100;

export interface BatchRecomputeSummary {
  processed: number;
  failed: number;
}

// Nightly safety-net that recomputes every APPROVED vendor's compliance
// score (Phase 13C). The event listeners keep scores current in response to
// individual signal changes; this sweep is the eventual-repair backstop
// (e.g. a listener that threw, or a certificate that expired by the mere
// passage of a date rather than an explicit action).
//
// runBatchRecompute is the single shared entry point: the @Cron handler and
// the compliance:scores:recompute-all backfill CLI both call it, so they
// batch, isolate per-vendor failures, and log identically - no risk of two
// drifting implementations.
@Injectable()
export class ComplianceScoreCronService {
  private readonly logger = new Logger(ComplianceScoreCronService.name);
  private running = false;

  constructor(
    private readonly vendorsRepository: VendorsRepository,
    private readonly complianceScoreService: ComplianceScoreService,
  ) {}

  // Timezone is explicit: "midnight" on a UTC-deployed server would fire at
  // 7-8pm local. Only the FIRING TIME is timezone-sensitive; the batch body
  // itself is timezone-agnostic.
  @Cron('0 0 * * *', { timeZone: 'America/Jamaica' })
  async handleNightlySweep(): Promise<void> {
    await this.runBatchRecompute();
  }

  async runBatchRecompute(): Promise<BatchRecomputeSummary> {
    // A simple in-process guard is sufficient at current scale (single
    // instance). A multi-instance deployment would need a DB-backed lock so
    // two servers' sweeps don't overlap. The manual backfill respects this
    // guard too, so it can't race a concurrent cron tick.
    if (this.running) {
      this.logger.warn('Compliance recompute already in progress - skipping this run');
      return { processed: 0, failed: 0 };
    }

    this.running = true;
    let processed = 0;
    let failed = 0;
    try {
      let skip = 0;
      for (;;) {
        const vendors = await this.vendorsRepository.findApprovedIds({ skip, take: BATCH_SIZE });
        if (vendors.length === 0) {
          break;
        }

        for (const vendor of vendors) {
          try {
            await this.complianceScoreService.recompute(vendor.id);
            processed += 1;
          } catch (error) {
            // One vendor's failure must never abort the sweep for the rest.
            failed += 1;
            this.logger.error(
              `Compliance recompute failed for vendor ${vendor.id}`,
              error instanceof Error ? error.stack : String(error),
            );
          }
        }

        skip += BATCH_SIZE;
      }
    } finally {
      this.running = false;
    }

    this.logger.log(`Compliance recompute complete: ${processed} processed, ${failed} failed`);
    return { processed, failed };
  }
}
