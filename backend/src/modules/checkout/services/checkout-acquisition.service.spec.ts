import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { CheckoutSettlementRepository } from '../../reservation-fence/repositories/checkout-settlement.repository';
import { ReservationFenceRepository } from '../../reservation-fence/repositories/reservation-fence.repository';
import { CheckoutSettlementAuthorityService } from '../../reservation-fence/services/checkout-settlement-authority.service';
import { ReservationMutationAuthorityService } from '../../reservation-fence/services/reservation-mutation-authority.service';
import { acquiredManifest, CheckoutAcquisitionEvidence, CheckoutAcquisitionService } from './checkout-acquisition.service';

describe('inactive acquisition authority boundary', () => {
  it('a TypeScript assertion cannot forge physical acquisition evidence', () => {
    expect(() => acquiredManifest({} as CheckoutAcquisitionEvidence)).toThrow('ACQUISITION_EVIDENCE_REQUIRED');
  });

  it.each(['LEGACY', 'historical-operation', 'historical-attempt', 'different-attempt-epoch', 'revoked'])(
    '%s cannot reach a manifest, gate or Redis writer', async kind => {
      const operation = { id: 'operation', customerId: 'customer', cartId: 'cart', operationKey: 'key',
        selectedPath: kind === 'LEGACY' ? 'LEGACY' : 'CART_SCOPED',
        reservationExecutionEpoch: kind === 'historical-operation' ? null : 7,
        reservationCapabilityState: kind === 'revoked' ? 'REVOKED' : 'ACTIVE' };
      const attempt = { id: 'attempt', customerId: 'customer', cartId: 'cart', selectedPath: 'CART_SCOPED',
        status: 'PROCESSING', reservationExecutionEpoch: kind === 'historical-attempt' ? null : 8 };
      const prisma = { checkoutOperation: { findFirst: jest.fn().mockResolvedValue(operation) },
        checkoutAttempt: { findUnique: jest.fn().mockResolvedValue(attempt) } };
      const redis = { eval: jest.fn() };
      const manifests = { prepare: jest.fn() };
      const metadata = { initializeExecutionGate: jest.fn() };
      const service = new CheckoutAcquisitionService(prisma as unknown as PrismaService, redis as unknown as RedisService,
        manifests as unknown as CheckoutSettlementRepository, {} as ReservationFenceRepository,
        {} as CheckoutSettlementAuthorityService, metadata as unknown as ReservationMutationAuthorityService);
      expect(await service.acquire('customer', 'operation')).toEqual({ ok: false, code: 'ACQUISITION_REJECTED' });
      expect(manifests.prepare).not.toHaveBeenCalled();
      expect(metadata.initializeExecutionGate).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled();
    });
});
