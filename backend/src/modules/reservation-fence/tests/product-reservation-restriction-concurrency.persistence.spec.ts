import { Redis } from 'ioredis';
import { RedisService } from '../../../common/redis/redis.service';
import { ProductReservationRestrictionAdmissionService } from '../services/product-reservation-restriction-admission.service';
import { ProductReservationRestrictionService } from '../services/product-reservation-restriction.service';
import { OrdinaryCommandDispatchClaimRepository } from '../repositories/ordinary-command-dispatch-claim.repository';
import { OrdinaryDispatchIdentity } from '../types/ordinary-command-dispatch-claim.types';
import { openOrdinarySchema, ordinaryFixture, ordinaryReleaseFixture } from './ordinary-provenance-test-helpers';
import { OrdinaryReleaseService } from '../services/ordinary-release.service';

describe('W3-P shared-lock serialization and W2 separation (PostgreSQL only)', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openOrdinarySchema>>;
  const client = new Redis('redis://127.0.0.1:16479', { lazyConnect: true });
  const redis = new RedisService(client);
  beforeAll(async () => { schema = await openOrdinarySchema(); });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { client.disconnect(); if (schema) await schema.close(); });
  it('concurrent genuine preparation returns the same permanent identity on independent connections', async () => {
    const f = await ordinaryFixture(schema.db);
    jest.spyOn(redis, 'get').mockResolvedValue('{');
    const clients = [schema.fresh(), schema.fresh(), schema.fresh()];
    try {
      const results = await Promise.all(clients.map(async db => {
        const admission = new ProductReservationRestrictionAdmissionService(db, redis);
        return new ProductReservationRestrictionService(db, redis, admission).prepare(await admission.observe(f.marker.id));
      }));
      expect(results[0]).not.toBeNull();
      expect(results).toEqual([results[0], results[0], results[0]]);
      expect(await schema.db.productReservationRestriction.count({ where: { productId: f.productId } })).toBe(1);
    } finally { await Promise.all(clients.map(db => db.$disconnect())); }
  });
  it('pre-restriction issuance survives but restriction-first claim consumes no attempt', async () => {
    const f = await ordinaryFixture(schema.db), issued = await f.commands.issue(f.issuance, f.payload);
    const c = await f.commands.promote(f.marker.id); if (!c) throw new Error('Missing pending command');
    const identity: OrdinaryDispatchIdentity = { version: 1, commandId: c.id, replayId: c.replayId,
      action: 'W1', sequence: c.sequence!, expectedSequence: c.expectedSequence!, mutationVersion: 0,
      incarnation: issued.owner.incarnation, epoch: 1, ownerId: issued.owner.id, sourceOwnerId: null,
      target: { customerId: f.customerId, cartId: f.cartId, productId: f.productId, markerId: f.marker.id,
        generation: 0, holdInstanceId: issued.owner.holdInstanceId }, source: null, transition: 'INITIAL', quantity: 2, parent: null };
    await schema.db.productReservationRestriction.create({ data: { productId: f.productId,
      reasonCategory: 'ACCOUNTING_DRIFT', observationDigest: 'a'.repeat(64) } });
    expect(await new OrdinaryCommandDispatchClaimRepository(schema.db).claim(identity)).toEqual({ status: 'NOT_AUTHORIZED' });
    expect(await schema.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: c.id } })).toEqual(c);
  });
  it('restriction does not block exact publication-aware RELEASE creation or claim', async () => {
    const f = await ordinaryReleaseFixture(schema.db);
    await schema.db.productReservationRestriction.create({ data: { productId: f.productId,
      reasonCategory: 'ACCOUNTING_DRIFT', observationDigest: 'b'.repeat(64) } });
    await f.prepare();
    const service = new OrdinaryReleaseService(schema.db);
    const result = await service.publish(f.request.intentId, { ownerId: f.owner.id, reason: 'CART_REMOVAL' }, f.domain);
    expect(result.status).toBe('PUBLISHED');
    if (result.status !== 'PUBLISHED') throw new Error('Missing exact release');
    expect((await new OrdinaryCommandDispatchClaimRepository(schema.db).claimRelease(result.admission, service)).status)
      .toBe('FIRST_PHYSICAL_DISPATCH_AUTHORIZED');
  });
});
