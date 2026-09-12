import { CheckoutSettlementAuthorityService } from '../services/checkout-settlement-authority.service';
import { CheckoutSettlementRepository } from '../repositories/checkout-settlement.repository';
import { ReservationFenceRepository } from '../repositories/reservation-fence.repository';
import { RedisService } from '../../../common/redis/redis.service';
import { Prisma } from '@prisma/client';

describe('inactive settlement issuer durable boundary', () => {
  it('never reads Redis to fabricate a pin when durable provenance is absent', async () => {
    const authority = jest.fn().mockRejectedValue(new Error('SETTLEMENT_AUTHORITY_DENIED'));
    const evalRedis = jest.fn();
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) } as unknown as Prisma.TransactionClient;
    const service = new CheckoutSettlementAuthorityService({ authority } as unknown as CheckoutSettlementRepository,
      { locked: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => work(tx) } as ReservationFenceRepository,
      { eval: evalRedis } as unknown as RedisService);
    await expect(service.register('00000000-0000-4000-8000-000000000000', 'ACQUIRE')).rejects.toThrow('SETTLEMENT_AUTHORITY_DENIED');
    expect(evalRedis).not.toHaveBeenCalled();
    expect(authority).toHaveBeenCalledWith(tx, '00000000-0000-4000-8000-000000000000', 'ACQUIRE');
  });
});
