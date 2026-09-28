import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { ProductReservationRestrictionAdmissionService } from '../services/product-reservation-restriction-admission.service';
import { ProductReservationRestrictionService } from '../services/product-reservation-restriction.service';
import { controlBytes, restrictionDigest } from '../types/product-reservation-restriction.types';

describe('inactive W3-P capability boundary (no network)', () => {
  const db = new PrismaService();
  const client = new Redis('redis://127.0.0.1:16479', { lazyConnect: true });
  const redis = new RedisService(client);
  const admission = new ProductReservationRestrictionAdmissionService(db, redis);
  const service = new ProductReservationRestrictionService(db, redis, admission);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { client.disconnect(); await db.$disconnect(); });
  it.each([null, true, 'a'.repeat(64), {}, { productId: randomUUID(), reasonCategory: 'ACCOUNTING_DRIFT' }])(
    'rejects reconstructed authority %j before database access', async token => {
      const transaction = jest.spyOn(db, '$transaction');
      expect(admission.consume(token)).toBeNull();
      expect(await service.prepare(token)).toBeNull();
      expect(transaction).not.toHaveBeenCalled();
    });
  it('does not treat infrastructure failure as a material observation', async () => {
    jest.spyOn(db.cartReservationSyncState, 'findUnique').mockRejectedValueOnce(new Error('offline'));
    expect(await admission.observe(randomUUID())).toBeNull();
  });
  it('canonical acknowledgement binds product, permanent identity and incarnation', () => {
    const value = { version: 1 as const, productId: randomUUID(), state: 'RESTRICTED' as const,
      restrictionId: randomUUID(), restrictionRevision: 1 as const, incarnation: randomUUID(), epoch: 1 };
    const bytes = controlBytes(value);
    expect(bytes).toBe(JSON.stringify(value));
    expect(restrictionDigest(bytes)).toMatch(/^[a-f0-9]{64}$/);
    expect(restrictionDigest(controlBytes({ ...value, incarnation: randomUUID() }))).not.toBe(restrictionDigest(bytes));
  });
});
