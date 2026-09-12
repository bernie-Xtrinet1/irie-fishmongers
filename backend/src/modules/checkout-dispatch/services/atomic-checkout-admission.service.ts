import { Injectable } from '@nestjs/common';
import { CheckoutOperation, Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { PrismaService } from '../../../database/prisma.service';
import { CheckoutOperationRepository } from '../../checkout-operation/repositories/checkout-operation.repository';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { CheckoutRolloutParticipantsRepository } from '../../checkout-rollout/repositories/checkout-rollout-participants.repository';
import { RolloutControlsRepository } from '../../checkout-rollout-admin/repositories/rollout-controls.repository';
import {
  lockRolloutGlobal,
  lockRolloutParticipant,
} from '../../checkout-rollout/checkout-rollout-locks';
import {
  CheckoutAdmissionContext,
  CheckoutAdmissionResult,
  CheckoutAdmissionService,
} from './checkout-admission.service';

@Injectable()
export class AtomicCheckoutAdmissionService extends CheckoutAdmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: CheckoutOperationRepository,
    private readonly attempts: CheckoutAttemptRepository,
    private readonly controls: RolloutControlsRepository,
    private readonly participants: CheckoutRolloutParticipantsRepository,
  ) {
    super();
  }

  async admit(context: CheckoutAdmissionContext): Promise<CheckoutAdmissionResult> {
    if (
      !context ||
      Object.keys(context).some((key) => !['customerId', 'cartId', 'operationId'].includes(key)) ||
      !isUUID(context.customerId) ||
      !isUUID(context.cartId) ||
      !isUUID(context.operationId)
    )
      return { ok: false, code: 'PATH_MISMATCH' };
    try {
      // The promise resolves only AFTER commit. Database-only work; no callback
      // may prepare prices, execute checkout or emit telemetry inside this scope.
      return await this.prisma.$transaction(
        async (tx): Promise<CheckoutAdmissionResult> => {
          await lockRolloutGlobal(tx);
          await lockRolloutParticipant(tx, context.customerId);
          // Same fence/mode lock order as capability issuance; no Redis work
          // occurs in this durable admission transaction.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1380339280, 1)`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('reservation_engine_mode_transition'))`;
          const operation = await this.operations.lockOwned(
            context.operationId,
            context.customerId,
            tx,
          );
          if (
            !operation ||
            operation.id !== context.operationId ||
            operation.customerId !== context.customerId ||
            operation.cartId !== context.cartId
          )
            return { ok: false, code: 'PATH_MISMATCH' };
          const attempt = await this.attempts.findByIdempotencyKey(operation.operationKey, tx);
          if (attempt) {
            if (
              attempt.customerId !== operation.customerId ||
              attempt.cartId !== operation.cartId ||
              attempt.idempotencyKey !== operation.operationKey ||
              (attempt.selectedPath !== 'LEGACY' && attempt.selectedPath !== 'CART_SCOPED') ||
              attempt.selectedPath !== operation.selectedPath
            )
              return { ok: false, code: 'PATH_MISMATCH' };
            return { ok: true, decision: 'EXISTING_ATTEMPT', operation, durable: true };
          }
          if (operation.selectedPath !== null) {
            if (operation.selectedPath !== 'LEGACY' && operation.selectedPath !== 'CART_SCOPED')
              return { ok: false, code: 'PATH_MISMATCH' };
            if (operation.selectedPath === 'CART_SCOPED') {
              if (!operation.reservationExecutionEpoch || operation.reservationCapabilityState !== 'ACTIVE')
                return { ok: false, code: 'PATH_MISMATCH' };
              const epoch = await this.currentEpoch(tx);
              if (epoch !== operation.reservationExecutionEpoch) return { ok: false, code: 'UNAVAILABLE' };
              await this.inheritCapability(operation, epoch, tx);
            }
            return { ok: true, decision: operation.selectedPath, operation, durable: true };
          }
          const control = await this.controls.findCurrent(tx);
          if (!control) return { ok: false, code: 'UNAVAILABLE' };
          if (control.newAdmissionStopped || control.behavior === 'DENY')
            return { ok: false, code: 'ADMISSION_DENIED' };
          const participant = await this.participants.findCurrent(context.customerId, tx);
          if (
            !participant?.enabled ||
            (control.eligibleCohort !== null && participant.cohort !== control.eligibleCohort)
          )
            return { ok: false, code: 'ADMISSION_DENIED' };
          if (control.behavior === 'SHADOW')
            return { ok: true, decision: 'SHADOW', operation, durable: false };
          if (control.behavior !== 'LEGACY' && control.behavior !== 'CART_SCOPED')
            return { ok: false, code: 'UNAVAILABLE' };
          const epoch = control.behavior === 'CART_SCOPED' ? await this.currentEpoch(tx) : null;
          if (control.behavior === 'CART_SCOPED' && epoch === null) return { ok: false, code: 'UNAVAILABLE' };
          const assigned = epoch !== null ? await this.operations.bindReservationCapability(operation.id, epoch, tx) : await this.operations.assignPath(
            operation.id,
            context.customerId,
            control.behavior,
            tx,
          );
          if (assigned.count !== 1) throw new Error('Admission ownership changed');
          const committedOperation = await this.operations.findOwned(
            operation.id,
            context.customerId,
            tx,
          );
          if (!committedOperation || committedOperation.selectedPath !== control.behavior)
            throw new Error('Admission assignment inconsistent');
          if (epoch !== null) {
            await this.inheritCapability(committedOperation, epoch, tx);
          }
          return {
            ok: true,
            decision: control.behavior,
            operation: committedOperation,
            durable: true,
          };
        },
        { isolationLevel: 'ReadCommitted', timeout: 5000, maxWait: 5000 },
      );
    } catch {
      return { ok: false, code: 'UNAVAILABLE' };
    }
  }

  private async inheritCapability(operation: CheckoutOperation, epoch: number, tx: Prisma.TransactionClient) {
    const attempt = await this.attempts.createWithReservationCapability({
      operationKey: operation.operationKey,
      customerId: operation.customerId,
      cartId: operation.cartId,
      epoch,
    }, tx);
    if (operation.reservationExecutionEpoch !== epoch || operation.reservationCapabilityState !== 'ACTIVE' ||
      attempt.reservationExecutionEpoch !== epoch || attempt.selectedPath !== 'CART_SCOPED' ||
      attempt.customerId !== operation.customerId || attempt.cartId !== operation.cartId)
      throw new Error('Admission epoch inheritance inconsistent');
  }

  private async currentEpoch(tx: Prisma.TransactionClient): Promise<number | null> {
    const fence = await tx.reservationFenceTransition.findFirst({ orderBy: { revision: 'desc' } });
    const mode = await tx.reservationEngineModeConfig.findFirst({ orderBy: { revision: 'desc' } });
    return fence?.status === 'ACKNOWLEDGED' && fence.phase === 'OPEN' && fence.mode === 'CART_SCOPED' &&
      mode?.mode === 'CART_SCOPED' && fence.modeRevision === mode.revision ? fence.epoch : null;
  }
}
