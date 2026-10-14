import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { RedisService } from '../../../common/redis/redis.service';
import { ProductReservationRestrictionAdmissionService } from '../services/product-reservation-restriction-admission.service';
import { ProductReservationRestrictionService } from '../services/product-reservation-restriction.service';
import { OrdinaryW1IssuanceService } from '../services/ordinary-w1-issuance.service';
import { OrdinaryReservationService } from '../../inventory/services/ordinary-reservation.service';
import { OrdinaryCommandPhysicalService } from '../services/ordinary-command-physical.service';
import { ReservationFenceRepository } from '../repositories/reservation-fence.repository';
import { PRODUCT_CONTROL_INSTALL } from '../lua/product-reservation-restriction.lua';
import { controlBytes, restrictionDigest } from '../types/product-reservation-restriction.types';
import { claimOrdinaryMutation, openOrdinarySchema, ordinaryFixture } from './ordinary-provenance-test-helpers';

describe('W3-P permanent PostgreSQL restriction, mocked physical acknowledgement', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openOrdinarySchema>>;
  const client = new Redis('redis://127.0.0.1:16479', { lazyConnect: true });
  const redis = new RedisService(client);
  beforeAll(async () => { schema = await openOrdinarySchema(); });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { client.disconnect(); if (schema) await schema.close(); });
  async function fixture() {
    const f = await ordinaryFixture(schema.db);
    // Exercise the real read-only observation boundary with malformed transport data.
    jest.spyOn(redis, 'get').mockResolvedValue('{');
    const admission = new ProductReservationRestrictionAdmissionService(schema.db, redis);
    const service = new ProductReservationRestrictionService(schema.db, redis, admission);
    const prepare = async () => service.prepare(await admission.observe(f.marker.id));
    return { ...f, admission, service, prepare };
  }
  it('requires genuine single-use product-bound observation; first permanent reason wins', async () => {
    const f = await fixture(), token = await f.admission.observe(f.marker.id);
    expect(token).not.toBeNull();
    expect(await f.service.prepare({ ...token })).toBeNull();
    const first = await f.service.prepare(token);
    expect(first).toMatchObject({ productId: f.productId, state: 'PREPARED', firstEnforcedAt: null });
    expect(await f.service.prepare(token)).toBeNull();
    expect(await f.prepare()).toEqual(first);
    expect(await schema.db.productReservationRestriction.count({ where: { productId: f.productId } })).toBe(1);
  });
  it('PREPARED denies older W1 and new command issuance without Redis writes', async () => {
    const f = await fixture(); expect(await f.prepare()).not.toBeNull();
    const evaluate = jest.spyOn(redis, 'eval');
    expect((await new OrdinaryReservationService(schema.db, redis).reserve(f.cartId, f.productId, f.customerId, 2)).code)
      .not.toBe('ACCEPTED');
    expect((await new OrdinaryW1IssuanceService(schema.db).issue({ markerId: f.marker.id, cartId: f.cartId,
      customerId: f.customerId, productId: f.productId, generation: 0, mutationVersion: 0, quantity: 2 })).status).toBe('DENIED');
    await expect(f.commands.issue(f.issuance, f.payload)).rejects.toThrow();
    expect(evaluate).not.toHaveBeenCalled();
    expect(await schema.db.ordinaryReservationCommand.count({ where: { markerId: f.marker.id } })).toBe(0);
  });
  it('denies execution of preloaded pending W1 without changing command evidence', async () => {
    const f = await fixture(); const issued = await f.commands.issue(f.issuance, f.payload);
    await f.commands.promote(f.marker.id);
    const admission = await claimOrdinaryMutation(schema.db, issued.command.id, 'EXECUTE_ONLY');
    const before = await schema.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: issued.command.id } });
    expect(await f.prepare()).not.toBeNull();
    const evaluate = jest.spyOn(redis, 'eval');
    expect(await new OrdinaryCommandPhysicalService(schema.db, redis).execute(admission.capability, admission.issuer)).toEqual({ code: 'REJECTED' });
    expect(evaluate).not.toHaveBeenCalled();
    expect(await schema.db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: issued.command.id } })).toEqual(before);
  });
  it.each(['rollback', 'lost-commit-response'] as const)('preparation %s reloads only, never remints identity', async fault => {
    const f = await fixture();
    const original = new ReservationFenceRepository(schema.db).locked.bind(new ReservationFenceRepository(schema.db));
    jest.spyOn(ReservationFenceRepository.prototype, 'locked').mockImplementationOnce(async work => {
      if (fault === 'rollback') return original(async tx => { await work(tx); throw new Error('rollback'); });
      await original(work); throw new Error('response lost');
    });
    const result = await f.prepare();
    expect(result === null).toBe(fault === 'rollback');
    expect(await schema.db.productReservationRestriction.count({ where: { productId: f.productId } })).toBe(fault === 'rollback' ? 0 : 1);
  });
  it('requires exact acknowledgement, retries after restart, and retains first enforcement timestamp', async () => {
    const f = await fixture(), row = await f.prepare(); if (!row) throw new Error('Missing restriction');
    const evaluate = jest.spyOn(redis, 'eval').mockResolvedValue(JSON.stringify({ code: 'ACCEPTED', value: 'forged' }));
    expect(await f.service.install(row.id)).toBe('UNRESOLVED');
    expect((await schema.db.productReservationRestriction.findUniqueOrThrow({ where: { id: row.id } })).state).toBe('PREPARED');
    evaluate.mockImplementation((script, keys, args) => {
      expect(script).toBe(PRODUCT_CONTROL_INSTALL); expect(keys).toHaveLength(2);
      return Promise.resolve(JSON.stringify({ code: 'ACCEPTED', value: args[1] }));
    });
    const restarted = new ProductReservationRestrictionService(schema.db, redis,
      new ProductReservationRestrictionAdmissionService(schema.db, redis));
    expect(await restarted.install(row.id)).toBe('ENFORCED');
    const enforced = await schema.db.productReservationRestriction.findUniqueOrThrow({ where: { id: row.id } });
    expect(enforced.firstEnforcedAt).not.toBeNull();
    expect(await restarted.install(row.id)).toBe('ENFORCED');
    expect(await schema.db.productReservationRestriction.findUniqueOrThrow({ where: { id: row.id } })).toEqual(enforced);
    expect(await schema.db.productReservationRestrictionInstallation.count({ where: { restrictionId: row.id } })).toBe(1);
  });
  it('rejects identity changes, premature enforcement, DELETE and statement TRUNCATE', async () => {
    const f = await fixture(), row = await f.prepare(); if (!row) throw new Error('Missing restriction');
    await expect(schema.db.productReservationRestriction.update({ where: { id: row.id }, data: { observationDigest: 'b'.repeat(64) } })).rejects.toThrow();
    await expect(schema.db.productReservationRestriction.update({ where: { id: row.id }, data: { state: 'ENFORCED', firstEnforcedAt: new Date() } })).rejects.toThrow();
    await expect(schema.db.productReservationRestriction.delete({ where: { id: row.id } })).rejects.toThrow();
    await expect(schema.db.$executeRaw`TRUNCATE reservation_product_restrictions CASCADE`).rejects.toThrow();
    await expect(schema.db.$executeRaw`TRUNCATE reservation_product_restriction_installations`).rejects.toThrow();
  });
  it('keeps exact installation evidence append-only and separate for each incarnation', async () => {
    const f = await fixture(), row = await f.prepare(); if (!row) throw new Error('Missing restriction');
    const install = (incarnation: string) => {
      const acknowledgement = controlBytes({ version: 1, productId: f.productId, state: 'RESTRICTED', restrictionId: row.id,
        restrictionRevision: 1, incarnation, epoch: 1 });
      return { restrictionId: row.id, incarnation, epoch: 1, protocolVersion: 1, acknowledgement,
        acknowledgementHash: restrictionDigest(acknowledgement) };
    };
    const first = install(f.transition.incarnation);
    await expect(schema.db.productReservationRestrictionInstallation.create({ data: { ...first, acknowledgementHash: '0'.repeat(64) } })).rejects.toThrow();
    await schema.db.productReservationRestrictionInstallation.create({ data: first });
    await expect(schema.db.productReservationRestrictionInstallation.create({ data: first })).rejects.toThrow();
    await schema.db.productReservationRestrictionInstallation.create({ data: install(randomUUID()) });
    await expect(schema.db.productReservationRestrictionInstallation.deleteMany({ where: { restrictionId: row.id } })).rejects.toThrow();
    expect(await schema.db.productReservationRestrictionInstallation.count({ where: { restrictionId: row.id } })).toBe(2);
  });
});
