import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { PrismaService } from '../database/prisma.service';
import { CartMutationBarrierService } from '../modules/cart-mutation-barrier/services/cart-mutation-barrier.service';
import { CartReservationSyncRecoveryService } from '../modules/cart-reservation-sync/services/cart-reservation-sync-recovery.service';
import { CartScopedBackfillService } from '../modules/cart-scoped-backfill/services/cart-scoped-backfill.service';
import { CartScopedOrphanReleaseService } from '../modules/cart-scoped-backfill/services/cart-scoped-orphan-release.service';
import { CompensationBatchService } from '../modules/mirror-compensation/services/compensation-batch.service';
import { ReservationEngineModeService } from '../modules/reservation-engine-mode/services/reservation-engine-mode.service';
import { CutoverOrchestrationModule } from './cutover-orchestration.module';

// CART_SCOPED activation-boundary gate (see the gate design review's final
// approved end-to-end sequence). The complete, frozen procedure - barrier
// activation, backlog draining, durable-truth enumeration/backfill, orphan
// removal, fresh-epoch sweep, attestation construction, and the final
// locked transition - runs entirely inside this ONE standalone Node
// process, matching every prior script's own single-bootstrap precedent
// (see recompute-compliance-scores.ts) and satisfying the gate design's
// own clock-domain-affinity requirement: the freshness attestation's
// minimumExpiresAt and setMode's postLockNow read are the same process's
// Date.now(), by construction, never two different hosts' clocks.
//
// Never exposed through a controller or scheduler - this module is booted
// standalone via CutoverOrchestrationModule, never imported by AppModule.
// Failure at any step leaves mode at MIRROR and the mutation barrier
// active; nothing here ever lifts the barrier automatically, on success
// or failure alike - see lift-cart-mutation-barrier.ts for the separate,
// deliberate operator action that does.
const MAX_DRAIN_ITERATIONS = 200;

async function drainSyncBacklog(
  prisma: PrismaService,
  recovery: CartReservationSyncRecoveryService,
  logger: Logger,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_DRAIN_ITERATIONS; attempt += 1) {
    const count = await prisma.cartReservationSyncState.count({ where: { resolvedAt: null } });
    if (count === 0) {
      logger.log('DA.1B sync backlog drained to zero');
      return;
    }
    logger.log(`DA.1B sync backlog: ${count} unresolved - running a recovery batch`);
    await recovery.runBatch({ now: new Date() });
  }
  throw new Error(`DA.1B sync backlog did not drain to zero within ${MAX_DRAIN_ITERATIONS} batches`);
}

async function drainCompensationBacklog(
  prisma: PrismaService,
  batch: CompensationBatchService,
  logger: Logger,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_DRAIN_ITERATIONS; attempt += 1) {
    const count = await prisma.cartReservationCompensation.count({
      where: { status: { in: ['PENDING', 'PROCESSING', 'BLOCKED', 'PERMANENT_FAILURE'] } },
    });
    if (count === 0) {
      logger.log('C4 compensation backlog drained to zero');
      return;
    }
    logger.log(`C4 compensation backlog: ${count} unresolved/PERMANENT_FAILURE - running a recovery batch`);
    await batch.runBatch({ now: new Date() });
  }
  throw new Error(`C4 compensation backlog did not drain to zero within ${MAX_DRAIN_ITERATIONS} batches`);
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('ActivateCartScopedMode');
  const operatorUserId = process.env.CUTOVER_OPERATOR_USER_ID;
  if (!operatorUserId) {
    logger.error('CUTOVER_OPERATOR_USER_ID environment variable is required');
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(CutoverOrchestrationModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const prisma = app.get(PrismaService);
    const barrier = app.get(CartMutationBarrierService);
    const syncRecovery = app.get(CartReservationSyncRecoveryService);
    const compensationBatch = app.get(CompensationBatchService);
    const backfill = app.get(CartScopedBackfillService);
    const orphanRelease = app.get(CartScopedOrphanReleaseService);
    const modeService = app.get(ReservationEngineModeService);

    logger.log('Step 1/7: activating mutation barrier');
    const barrierSnapshot = await barrier.activate(operatorUserId);
    if (!barrierSnapshot.active || barrierSnapshot.revision === null) {
      throw new Error('Invariant violation: barrier activation did not report active with a revision');
    }
    logger.log(`Mutation barrier active at revision ${barrierSnapshot.revision}`);

    logger.log('Step 2/7: draining DA.1B sync backlog');
    await drainSyncBacklog(prisma, syncRecovery, logger);

    logger.log('Step 3/7: draining C4 compensation backlog');
    await drainCompensationBacklog(prisma, compensationBatch, logger);

    logger.log('Step 4/7: enumerating durable positive targets and backfilling');
    const targets = await backfill.enumeratePositiveTargets();
    logger.log(`${targets.length} positive CartItem target(s) found`);
    const backfillOutcomes = await backfill.backfillTargets(targets);
    const backfillFailures = backfillOutcomes.filter((outcome) => outcome.outcome !== 'CONVERGED');
    if (backfillFailures.length > 0) {
      throw new Error(`Backfill did not fully converge: ${JSON.stringify(backfillFailures)}`);
    }

    logger.log('Step 5/7: discovering and releasing orphan cart-scoped reservations');
    const orphans = await orphanRelease.discoverAndReleaseOrphans();
    logger.log(`${orphans.length} orphan reservation(s) released`);

    logger.log('Step 6/7: running freshness sweep and building attestation');
    const freshnessOutcomes = await backfill.freshnessSweep(targets);
    const freshnessFailures = freshnessOutcomes.filter((outcome) => outcome.outcome !== 'CONVERGED');
    if (freshnessFailures.length > 0) {
      throw new Error(`Freshness sweep did not fully converge: ${JSON.stringify(freshnessFailures)}`);
    }
    const attestation = backfill.buildAttestation(targets, freshnessOutcomes, barrierSnapshot.revision);
    logger.log(`Attestation built: ${JSON.stringify(attestation)}`);

    logger.log('Step 7/7: authorizing MIRROR -> CART_SCOPED transition');
    const result = await modeService.setMode({
      targetMode: 'CART_SCOPED',
      updatedById: operatorUserId,
      cutoverAttestation: attestation,
    });

    if (!result.ok) {
      logger.error(`Cutover REJECTED: ${JSON.stringify(result)}`);
      logger.error(
        'Mode remains MIRROR. Mutation barrier remains active - investigate, then retry this script or run lift-cart-mutation-barrier.ts to abort.',
      );
      process.exitCode = 1;
      return;
    }

    logger.log(`Cutover SUCCEEDED: mode is now CART_SCOPED (id ${result.id}, ${result.createdAt.toISOString()})`);
    logger.log(
      'Mutation barrier remains active by design - perform post-transition verification, then run lift-cart-mutation-barrier.ts explicitly.',
    );
  } catch (error) {
    logger.error('Cutover activation failed', error instanceof Error ? error.stack : String(error));
    logger.error('Mode remains unchanged. Mutation barrier remains active - no automatic lift.');
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void bootstrap();
