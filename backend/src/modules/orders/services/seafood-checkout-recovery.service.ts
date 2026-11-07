import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CheckoutPath } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { StaleCheckoutAttemptCursor } from '../../checkout-attempt/types/checkout-attempt.types';
import { CHECKOUT_HEARTBEAT_FRESHNESS_SECONDS } from '../../inventory/constants/inventory.constants';
import { CheckoutReservationRecoveryService } from '../../inventory/services/checkout-reservation-recovery.service';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';

export interface SeafoodRecoveryCycleResult {
  fenced: number;
  finalized: number;
  cleanedFailed: number;
  errors: number;
}

@Injectable()
export class SeafoodCheckoutRecoveryService {
  private readonly logger = new Logger(SeafoodCheckoutRecoveryService.name);
  private running = false;
  private lastFencedCleanupCursor: StaleCheckoutAttemptCursor | null = null;

  constructor(
    private readonly checkoutAttemptRepository: CheckoutAttemptRepository,
    private readonly checkoutReservationRecovery: CheckoutReservationRecoveryService,
    private readonly inventoryReservations: InventoryReservationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async runRecoverySweep(): Promise<void> {
    if (this.running) {
      this.logger.debug('Seafood checkout recovery sweep skipped: previous cycle still running');
      return;
    }
    this.running = true;
    try {
      await this.runCycle();
    } catch (err: any) {
      this.logger.error(`Seafood checkout recovery cycle failed: ${err.message}`, err.stack);
    } finally {
      this.running = false;
    }
  }

  async runCycle(now = new Date(), resetCursor = false): Promise<SeafoodRecoveryCycleResult> {
    if (resetCursor) {
      this.lastFencedCleanupCursor = null;
    }
    const staleBefore = new Date(now.getTime() - CHECKOUT_HEARTBEAT_FRESHNESS_SECONDS * 1000);
    let cursor: StaleCheckoutAttemptCursor | null = null;
    let fenced = 0;
    let finalized = 0;
    let cleanedFailed = 0;
    let errors = 0;

    while (true) {
      const candidates = await this.checkoutAttemptRepository.findStaleProcessing({
        heartbeatBefore: staleBefore,
        cursor,
        limit: 50,
      });

      if (candidates.length === 0) break;

      for (const attempt of candidates) {
        cursor = { id: attempt.id, lastHeartbeatAt: attempt.lastHeartbeatAt };
        try {
          const current = await this.checkoutAttemptRepository.findById(attempt.id);
          if (!current) continue;

          if (current.status === 'COMMITTED' && current.orderId) {
            // Crash after commit: finalize Redis reservation consumption safely
            await this.checkoutReservationRecovery.finalizeCheckoutConsumption(
              current.cartId,
              current.idempotencyKey,
            );
            finalized++;
          } else if (current.status === 'PROCESSING') {
            // Atomically fence stale attempt in PostgreSQL before releasing Redis
            const fenceResult = await this.checkoutAttemptRepository.fenceStaleProcessing({
              attemptId: current.id,
              customerId: current.customerId,
              selectedPath: current.selectedPath ?? CheckoutPath.CART_SCOPED,
              observedHeartbeatAt: current.lastHeartbeatAt,
              staleBefore,
              now,
            });

            if (fenceResult.count === 1) {
              fenced++;
              await this.releaseCartHolds(current.cartId);
            }
          }
        } catch (err: any) {
          errors++;
          this.logger.warn(`Failed recovery for attempt "${attempt.id}": ${err.message}`);
        }
      }

      if (candidates.length < 50) break;
    }

    // Post-commit crash recovery: sweep recently committed attempts whose Redis
    // reservations were not finalized before process termination
    try {
      const committedCandidates = await this.prisma.checkoutAttempt.findMany({
        where: {
          status: 'COMMITTED',
          orderId: { not: null },
          updatedAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
        },
        take: 50,
      });

      for (const committed of committedCandidates) {
        try {
          const outcome = await this.checkoutReservationRecovery.finalizeCheckoutConsumption(
            committed.cartId,
            committed.idempotencyKey,
          );
          if (outcome.ok && outcome.finalizedProductIds.length > 0) {
            finalized++;
          }
        } catch (err: any) {
          this.logger.warn(
            `Failed finalization for committed attempt "${committed.id}": ${err.message}`,
          );
        }
      }
    } catch (err: any) {
      this.logger.warn(`Failed sweeping committed attempts for finalization: ${err.message}`);
    }

    // Durable post-fencing crash recovery: sweep FAILED attempts whose Redis
    // holds were not released before process termination (e.g. crash after fence)
    try {
      const failedCandidates = await this.checkoutAttemptRepository.findFencedCleanupPage({
        cursor: this.lastFencedCleanupCursor,
        limit: 50,
      });

      for (const attempt of failedCandidates) {
        this.lastFencedCleanupCursor = { id: attempt.id, lastHeartbeatAt: attempt.lastHeartbeatAt };
        try {
          const current = await this.checkoutAttemptRepository.findById(attempt.id);
          if (!current || current.status !== 'FAILED' || current.orderId !== null) {
            continue;
          }
          if (current.failureCode !== 'STALE_RECOVERY_FENCED') {
            continue;
          }

          const releasedCount = await this.releaseCartHolds(current.cartId);
          if (releasedCount > 0) {
            cleanedFailed++;
          }
        } catch (err: any) {
          errors++;
          this.logger.warn(`Failed cleanup for fenced attempt "${attempt.id}": ${err.message}`);
        }
      }

      if (failedCandidates.length < 50) {
        this.lastFencedCleanupCursor = null;
      }
    } catch (err: any) {
      this.logger.warn(`Failed sweeping fenced attempts for hold release: ${err.message}`);
    }

    return { fenced, finalized, cleanedFailed, errors };
  }

  private async releaseCartHolds(cartId: string): Promise<number> {
    let releasedCount = 0;
    const cart = await this.prisma.cart.findUnique({
      where: { id: cartId },
      include: { items: true },
    });
    if (cart) {
      for (const item of cart.items) {
        const result = await this.inventoryReservations.releaseReservation(cartId, item.productId);
        if (result.released) {
          releasedCount++;
        }
      }
    }
    return releasedCount;
  }
}
