import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { ComplianceScoreCronService } from '../modules/vendor-tiers/services/compliance-score-cron.service';

// One-time backfill for the compliance-score feature (Phase 13C). Event
// listeners and the nightly cron only maintain scores going forward, so
// every already-APPROVED vendor reads complianceScore: null until this runs.
//
// It deliberately reuses ComplianceScoreCronService.runBatchRecompute() as-is
// - the exact same batching, per-vendor failure isolation, no-overlap guard,
// and summary the nightly sweep uses - so the backfill and the ongoing sweep
// can never drift into two subtly different implementations.
async function bootstrap(): Promise<void> {
  const logger = new Logger('RecomputeComplianceScores');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const cronService = app.get(ComplianceScoreCronService);
    const summary = await cronService.runBatchRecompute();
    logger.log(`Backfill complete: ${summary.processed} processed, ${summary.failed} failed`);
    if (summary.failed > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    logger.error('Backfill failed', error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void bootstrap();
