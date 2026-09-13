import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { CheckoutSettlementRepository } from '../../reservation-fence/repositories/checkout-settlement.repository';
import { ReservationFenceRepository } from '../../reservation-fence/repositories/reservation-fence.repository';
import { CheckoutSettlementAuthorityService } from '../../reservation-fence/services/checkout-settlement-authority.service';
import { CheckoutFailureSettlementService } from './checkout-failure-settlement.service';

describe('W5 restart authority rejects historical or inconsistent provenance', () => {
  it.each(['LEGACY', 'NULL-operation-E', 'NULL-attempt-E', 'wrong-attempt-E', 'wrong-customer', 'wrong-cart',
    'wrong-key', 'PREPARED', 'ACQUIRED', 'COMMITTED', 'order-linkage', 'old-failure', 'acquisition-replay',
    'missing-customer', 'missing-operation', 'wrong-authenticated-customer', 'wrong-requested-operation'])(
    '%s cannot issue a grant, mutate Redis, or manufacture an obligation', async kind => {
      const operation = { id: 'operation', customerId: 'customer', cartId: 'cart', operationKey: 'key',
        selectedPath: kind === 'LEGACY' ? 'LEGACY' : 'CART_SCOPED', reservationCapabilityState: 'ACTIVE',
        reservationExecutionEpoch: kind === 'NULL-operation-E' ? null : 1 };
      const attempt = { id: 'attempt', customerId: kind === 'wrong-customer' ? 'other' : 'customer',
        cartId: kind === 'wrong-cart' ? 'other' : 'cart', idempotencyKey: kind === 'wrong-key' ? 'other' : 'key',
        selectedPath: 'CART_SCOPED', reservationExecutionEpoch: kind === 'NULL-attempt-E' ? null : kind === 'wrong-attempt-E' ? 2 : 1,
        status: kind === 'COMMITTED' ? 'COMMITTED' : 'FAILED', orderId: kind === 'order-linkage' ? 'order' : null,
        failureCode: kind === 'old-failure' ? 'STALE_RECOVERY_FENCED' : 'ORDER_TRANSACTION_ROLLED_BACK' };
      const manifest = { id: 'manifest', sealed: true, operationId: operation.id, attemptId: attempt.id,
        reservationExecutionEpoch: 1, operation, attempt, effect: 'CHECKOUT_REVERT_DELETE_ONLY',
        state: ['PREPARED', 'ACQUIRED'].includes(kind) ? kind : 'REVERT_PENDING', acquisitionReplayId: 'acquisition',
        settlementReplayId: kind === 'acquisition-replay' ? 'acquisition' : 'terminal' };
      const prisma = { checkoutReservationSettlement: { findFirst: jest.fn().mockResolvedValue({ id: manifest.id }) } };
      const manifests = { find: jest.fn().mockResolvedValue(manifest), prepare: jest.fn(), markRevertPending: jest.fn() };
      const redis = { eval: jest.fn() }, authority = { register: jest.fn() };
      const service = new CheckoutFailureSettlementService(prisma as unknown as PrismaService,
        redis as unknown as RedisService, {} as CheckoutAttemptRepository,
        manifests as unknown as CheckoutSettlementRepository, {} as ReservationFenceRepository,
        authority as unknown as CheckoutSettlementAuthorityService);
      const customerId = kind === 'missing-customer' ? undefined : kind === 'wrong-authenticated-customer' ? 'other' : 'customer';
      const operationId = kind === 'missing-operation' ? undefined : kind === 'wrong-requested-operation' ? 'other' : 'operation';
      expect(await service.continue(customerId as string, operationId as string)).toEqual({ code: 'REVERT_REJECTED' });
      expect(redis.eval).not.toHaveBeenCalled(); expect(authority.register).not.toHaveBeenCalled();
      expect(manifests.prepare).not.toHaveBeenCalled(); expect(manifests.markRevertPending).not.toHaveBeenCalled();
    });
});
