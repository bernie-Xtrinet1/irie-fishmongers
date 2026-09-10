import { Injectable } from '@nestjs/common';
import { CheckoutOperationRepository } from '../../checkout-operation/repositories/checkout-operation.repository';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { ReservationFenceRepository } from '../repositories/reservation-fence.repository';
import { ReservationFenceService } from './reservation-fence.service';
import { accepted, FenceResult } from '../types/reservation-fence.types';

@Injectable()
export class ReservationCapabilityService {
  constructor(private readonly fenceRepository: ReservationFenceRepository,
    private readonly fence: ReservationFenceService,
    private readonly operations: CheckoutOperationRepository,
    private readonly attempts: CheckoutAttemptRepository) {}

  async bind(operationId: string, customerId: string, epoch: number): Promise<FenceResult<number>> {
    return this.fenceRepository.locked(async tx => {
      const op = await this.operations.lockOwned(operationId, customerId, tx);
      if (!op) return { code: 'UNKNOWN_CAPABILITY' };
      if (op.reservationCapabilityState === 'REVOKED') return { code: 'CAPABILITY_REVOKED' };
      if (op.reservationExecutionEpoch !== null) return op.reservationExecutionEpoch === epoch
        ? accepted(epoch) : { code: 'EPOCH_MISMATCH' };
      if (op.selectedPath !== null) return { code: 'UNKNOWN_CAPABILITY' };
      if (await this.attempts.findByIdempotencyKey(op.operationKey, tx)) return { code: 'UNKNOWN_CAPABILITY' };
      const permit = await this.fence.checkIssuance(tx);
      if (permit.code !== 'ACCEPTED') return permit;
      if (permit.value.epoch !== epoch) return { code: 'EPOCH_MISMATCH' };
      await this.operations.bindReservationCapability(op.id, epoch, tx);
      return accepted(epoch);
    });
  }

  async revoke(operationId: string, customerId: string): Promise<FenceResult<undefined>> {
    return this.fenceRepository.locked(async tx => {
      const op = await this.operations.lockOwned(operationId, customerId, tx);
      if (!op || op.reservationExecutionEpoch === null) return { code: 'UNKNOWN_CAPABILITY' };
      await this.operations.revokeReservationCapability(op.id, tx);
      return accepted(undefined);
    });
  }

  async createAttempt(operationId: string, customerId: string, epoch: number): Promise<FenceResult<{ id: string; epoch: number }>> {
    return this.fenceRepository.locked(async tx => {
      const op = await this.operations.lockOwned(operationId, customerId, tx);
      if (!op || op.reservationExecutionEpoch === null) return { code: 'UNKNOWN_CAPABILITY' };
      if (op.reservationCapabilityState === 'REVOKED') return { code: 'CAPABILITY_REVOKED' };
      if (op.reservationExecutionEpoch !== epoch) return { code: 'EPOCH_MISMATCH' };
      const permit = await this.fence.checkIssuance(tx);
      if (permit.code !== 'ACCEPTED') return permit;
      if (permit.value.epoch !== epoch) return { code: 'EPOCH_MISMATCH' };
      const attempt = await this.attempts.createWithReservationCapability({ operationKey: op.operationKey,
        customerId: op.customerId, cartId: op.cartId, epoch }, tx);
      if (attempt.reservationExecutionEpoch !== epoch || attempt.selectedPath !== 'CART_SCOPED' ||
          attempt.customerId !== op.customerId || attempt.cartId !== op.cartId) return { code: 'EPOCH_MISMATCH' };
      return accepted({ id: attempt.id, epoch });
    });
  }
}
