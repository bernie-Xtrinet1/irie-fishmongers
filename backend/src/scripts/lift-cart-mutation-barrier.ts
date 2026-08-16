import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { CartMutationBarrierService } from '../modules/cart-mutation-barrier/services/cart-mutation-barrier.service';
import { CutoverOrchestrationModule } from './cutover-orchestration.module';

// CART_SCOPED activation-boundary gate (see the gate design review's final
// approved sequence). The separate, deliberate "lift" action - never run
// automatically by activate-cart-scoped-mode.ts, on success or failure
// alike. Run this only after explicit post-transition verification
// (success case) or an explicit operator decision to abort (failure
// case) - both are judgment calls this script does not make for you.
async function bootstrap(): Promise<void> {
  const logger = new Logger('LiftCartMutationBarrier');
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
    const barrier = app.get(CartMutationBarrierService);
    const snapshot = await barrier.deactivate(operatorUserId);
    logger.log(`Mutation barrier lifted (revision ${snapshot.revision}); ordinary cart mutations resume.`);
  } catch (error) {
    logger.error('Failed to lift mutation barrier', error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void bootstrap();
