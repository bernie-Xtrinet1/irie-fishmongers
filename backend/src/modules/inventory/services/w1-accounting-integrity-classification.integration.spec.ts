import { randomUUID } from 'crypto';
import { RoleName } from '@prisma/client';
import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { CheckoutReservationFacade } from '../../checkout-reservation/services/checkout-reservation-facade.service';
import { CompensationRepository } from '../../mirror-compensation/repositories/compensation.repository';
import {
  CompensationTestFixture,
  baseCreateInput,
  seedCartAndProduct,
  setUpCompensationFixture,
  tearDownCompensationFixture,
} from '../../mirror-compensation/repositories/compensation-repository-test-helpers';
import { CompensationReconciliationService } from '../../mirror-compensation/services/compensation-reconciliation.service';
import { CompensationService } from '../../mirror-compensation/services/compensation.service';
import { resourceGuardKey } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { ProductReservationRestrictionAdmissionService } from '../../reservation-fence/services/product-reservation-restriction-admission.service';
import { ProductReservationRestrictionService } from '../../reservation-fence/services/product-reservation-restriction.service';
import { ReservationAvailabilityService } from '../../reservation-engine-mode/services/reservation-availability.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { ReservationRecoveryConvergenceService } from '../../reservation-recovery/services/reservation-recovery-convergence.service';
import { cartIndexKey, productSuspectKey, productTotalKey, reservationKey } from '../constants/inventory.constants';
import { CartScopedReservationEntry, InventoryReservationsService } from './inventory-reservations.service';
import { connectRealRedis, ensureOpenReservationFence } from './inventory-reservations.redis-test-helpers';
import { OrdinaryReservationService } from './ordinary-reservation.service';

jest.setTimeout(45_000);
const ISOLATED_DB_INDEX = 9;

interface ResourceGuardPayload {
  resource: { generation: number; holdInstanceId: string };
}

describe('W1 Accounting & Integrity Error Classification (real Postgres + Redis)', () => {
  let redisClient: Redis, redisService: RedisService, prisma: PrismaService, fixture: CompensationTestFixture;
  let compRepo: CompensationRepository, cartRepo: CartRepository, inv: InventoryReservationsService;
  let facade: CheckoutReservationFacade, reconciler: CompensationReconciliationService, convergence: ReservationRecoveryConvergenceService;
  let modeService: { getCurrentMode: jest.Mock; getCurrentModeSnapshot: jest.Mock };

  async function setFenceMode(mode: 'MIRROR' | 'CART_SCOPED'): Promise<void> {
    modeService.getCurrentMode.mockResolvedValue(mode);
    modeService.getCurrentModeSnapshot.mockResolvedValue({ mode, revision: 1 });
    await ensureOpenReservationFence(prisma, redisClient, mode, fixture.userIds[0]!);
  }

  async function syncQty(cartId: string, productId: string, expectedQuantity: number) {
    return prisma.cartReservationSyncState.upsert({
      where: { cartId_productId: { cartId, productId } },
      create: { cartId, productId, expectedMutationVersion: 1, expectedQuantity, generation: 1 },
      update: { expectedMutationVersion: { increment: 1 }, expectedQuantity, generation: { increment: 1 } },
    });
  }

  async function patchRedisJson<T>(key: string, mutator: (value: T) => void): Promise<void> {
    const parsed = JSON.parse((await redisClient.get(key))!) as T;
    mutator(parsed);
    await redisClient.set(key, JSON.stringify(parsed));
  }

  async function seedSecondCart(cartLabel: string): Promise<{ cartId: string; customerId: string }> {
    const role = await prisma.role.upsert({ where: { name: RoleName.CUSTOMER }, update: {}, create: { name: RoleName.CUSTOMER } });
    const cust = await new UsersRepository(prisma).create({
      email: `${cartLabel}-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Second',
      lastName: 'Buyer',
      roleId: role.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    fixture.userIds.push(cust.id);
    const cart = await cartRepo.findOrCreateByCustomerId(cust.id);
    return { cartId: cart.id, customerId: cust.id };
  }

  beforeAll(async () => {
    redisClient = await connectRealRedis();
    await redisClient.select(ISOLATED_DB_INDEX);
    prisma = new PrismaService();
    await prisma.onModuleInit();
    fixture = await setUpCompensationFixture(prisma);
  });

  afterAll(async () => {
    const retainedRestrictions = await prisma.productReservationRestriction.count({ where: { product: { vendorId: fixture.vendor.id } } });
    if (retainedRestrictions === 0) await tearDownCompensationFixture(fixture);
    await prisma.onModuleDestroy();
    await redisClient.flushdb();
    await redisClient.quit();
  });

  beforeEach(async () => {
    await redisClient.flushdb();
    compRepo = new CompensationRepository(prisma);
    cartRepo = new CartRepository(prisma);
    redisService = new RedisService(redisClient);
    inv = new InventoryReservationsService(redisService);
    Object.assign(inv, { ordinary: new OrdinaryReservationService(prisma, redisService), observationPrisma: prisma });
    modeService = {
      getCurrentMode: jest.fn().mockResolvedValue('MIRROR'),
      getCurrentModeSnapshot: jest.fn().mockResolvedValue({ mode: 'MIRROR', revision: 1 }),
    };
    await ensureOpenReservationFence(prisma, redisClient, 'MIRROR', fixture.userIds[0]!);
    const modeTyped = modeService as unknown as ReservationEngineModeService;
    const availability = new ReservationAvailabilityService(modeTyped, inv);
    facade = new CheckoutReservationFacade(modeTyped, inv, availability, new CompensationService(compRepo));
    reconciler = new CompensationReconciliationService(compRepo, cartRepo, inv, modeTyped);
    convergence = new ReservationRecoveryConvergenceService(modeTyped, inv);
  });

  it('1. accounting underflow (reserve decrease, reserve increase with low total, and release) blocks cleanly', async () => {
    const a = await seedCartAndProduct(fixture);
    await syncQty(a.cartId, a.productId, 10);
    expect((await inv.reserveOrRenew(a.cartId, a.productId, a.customerId, 10)).ok).toBe(true);
    await redisClient.set(productTotalKey(a.productId), '2');
    await cartRepo.addOrIncrementItem(a.cartId, a.productId, 3);
    await syncQty(a.cartId, a.productId, 3);
    expect(await facade.reserveForCart(a.cartId, a.productId, a.customerId, 3))
      .toEqual({ ok: true, mode: 'MIRROR', mirror: { status: 'FAILED', operation: 'RESERVE', reasonCode: 'ACCOUNTING_UNDERFLOW' } });

    const created = await prisma.cartReservationCompensation.findFirst({ where: { cartId: a.cartId, productId: a.productId } });
    expect(created?.lastError).toBeNull();
    expect(await reconciler.attemptRecovery(created!.id, new Date())).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', compensationId: created!.id });
    const rowAfter = await compRepo.findById(created!.id);
    expect(rowAfter?.status).toBe('BLOCKED');
    expect(rowAfter?.reasonCode).toBe('ACCOUNTING_UNDERFLOW');
    expect(rowAfter?.attemptCount).toBe(1);

    const c = await seedCartAndProduct(fixture);
    await syncQty(c.cartId, c.productId, 10);
    expect((await inv.reserveOrRenew(c.cartId, c.productId, c.customerId, 10)).ok).toBe(true);
    await redisClient.set(productTotalKey(c.productId), '2');
    await syncQty(c.cartId, c.productId, 12);
    expect(await inv.reserveOrRenew(c.cartId, c.productId, c.customerId, 12)).toEqual({ ok: false, code: 'RESERVATION_ACCOUNTING_UNDERFLOW' });

    const b = await seedCartAndProduct(fixture);
    await syncQty(b.cartId, b.productId, 6);
    expect((await inv.reserveOrRenew(b.cartId, b.productId, b.customerId, 6)).ok).toBe(true);
    await redisClient.set(productTotalKey(b.productId), '2');
    const compB = await compRepo.create(baseCreateInput({ cartId: b.cartId, productId: b.productId, customerId: b.customerId, operation: 'RELEASE_MIRROR', desiredQuantity: null }));
    expect(await reconciler.attemptRecovery(compB.id, new Date())).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', compensationId: compB.id });
    expect((await compRepo.findById(compB.id))?.reasonCode).toBe('ACCOUNTING_UNDERFLOW');
  });

  it('2. corrupted product totals & broken index invariants classify as ACCOUNTING_CORRUPTION -> BLOCKED_PRODUCT_SUSPECT', async () => {
    const a = await seedCartAndProduct(fixture);
    await cartRepo.addOrIncrementItem(a.cartId, a.productId, 4);
    await syncQty(a.cartId, a.productId, 4);
    await redisClient.set(productTotalKey(a.productId), 'not-an-int');
    expect(await inv.reserveOrRenew(a.cartId, a.productId, a.customerId, 4)).toEqual({ ok: false, code: 'RESERVATION_ACCOUNTING_CORRUPTION' });
    const rowA = await compRepo.create(baseCreateInput({ cartId: a.cartId, productId: a.productId, customerId: a.customerId }));
    await prisma.cartReservationCompensation.update({ where: { id: rowA.id }, data: { attemptCount: 4 } });
    expect(await reconciler.attemptRecovery(rowA.id, new Date())).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', compensationId: rowA.id });
    const afterA = await compRepo.findById(rowA.id);
    expect(afterA?.reasonCode).toBe('ACCOUNTING_UNDERFLOW');
    expect(afterA?.lastError).toBe('RESERVATION_ACCOUNTING_CORRUPTION');

    const b = await seedCartAndProduct(fixture);
    await syncQty(b.cartId, b.productId, 3);
    expect((await inv.reserveOrRenew(b.cartId, b.productId, b.customerId, 3)).ok).toBe(true);
    await redisClient.srem(cartIndexKey(b.cartId), b.productId);
    await syncQty(b.cartId, b.productId, 5);
    expect(await inv.reserveOrRenew(b.cartId, b.productId, b.customerId, 5)).toEqual({ ok: false, code: 'RESERVATION_ACCOUNTING_CORRUPTION' });
  });

  it('3. true RESOURCE_GENERATION_MISMATCH stays distinct, retries as UNKNOWN_INFRA_FAILURE, and never sets PRODUCT_SUSPECT', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const marker = await syncQty(cartId, productId, 4);
    await cartRepo.addOrIncrementItem(cartId, productId, 4);
    expect((await inv.reserveOrRenew(cartId, productId, customerId, 4)).ok).toBe(true);
    await patchRedisJson<ResourceGuardPayload>(resourceGuardKey(marker.id), (g) => {
      g.resource.generation = 999;
      g.resource.holdInstanceId = randomUUID();
    });

    expect(await facade.reserveForCart(cartId, productId, customerId, 4))
      .toEqual({ ok: true, mode: 'MIRROR', mirror: { status: 'FAILED', operation: 'RESERVE', reasonCode: 'UNKNOWN_INFRA_FAILURE' } });
    const row = await prisma.cartReservationCompensation.findFirst({ where: { cartId, productId } });
    expect(row?.reasonCode).toBe('UNKNOWN_INFRA_FAILURE');
    expect(row?.lastError).toBe('RESERVATION_RESOURCE_GENERATION_MISMATCH');

    expect((await reconciler.attemptRecovery(row!.id, new Date())).outcome).toBe('RETRY_SCHEDULED');
    await prisma.cartReservationSyncState.update({ where: { id: marker.id }, data: { expectedQuantity: 4 } });
    await prisma.cartReservationCompensation.update({ where: { id: row!.id }, data: { status: 'PENDING', attemptCount: 5, nextAttemptAt: new Date(Date.now() - 1000) } });
    expect(await reconciler.attemptRecovery(row!.id, new Date())).toEqual({ outcome: 'PERMANENT_FAILURE', compensationId: row!.id });
    expect((await compRepo.findById(row!.id))?.blockReason).toBeNull();

    await setFenceMode('CART_SCOPED');
    const b = await seedCartAndProduct(fixture);
    const markerB = await syncQty(b.cartId, b.productId, 4);
    expect((await inv.reserveOrRenew(b.cartId, b.productId, b.customerId, 4)).ok).toBe(true);
    await patchRedisJson<ResourceGuardPayload>(resourceGuardKey(markerB.id), (g) => {
      g.resource.generation = 999;
      g.resource.holdInstanceId = randomUUID();
    });
    expect(await facade.reserveForCart(b.cartId, b.productId, b.customerId, 4)).toEqual({ ok: false, code: 'RESERVATION_RESOURCE_GENERATION_MISMATCH' });
  });

  it('4. malformed reservation entry, future createdAt, and malformed resource guard classify as MALFORMED_RESOURCE -> BLOCKED_PRODUCT_SUSPECT', async () => {
    const a = await seedCartAndProduct(fixture);
    await cartRepo.addOrIncrementItem(a.cartId, a.productId, 2);
    await syncQty(a.cartId, a.productId, 2);
    await redisClient.set(reservationKey(a.cartId, a.productId), '{"broken-json');
    expect(await inv.reserveOrRenew(a.cartId, a.productId, a.customerId, 2)).toEqual({ ok: false, code: 'RESERVATION_MALFORMED_RESOURCE' });
    const row = await compRepo.create(baseCreateInput({ cartId: a.cartId, productId: a.productId, customerId: a.customerId }));
    expect(await reconciler.attemptRecovery(row.id, new Date())).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', compensationId: row.id });
    expect((await compRepo.findById(row.id))?.lastError).toBe('RESERVATION_MALFORMED_RESOURCE');

    const b = await seedCartAndProduct(fixture);
    const markerB = await syncQty(b.cartId, b.productId, 2);
    await redisClient.set(resourceGuardKey(markerB.id), '{not-valid-json');
    expect(await inv.reserveOrRenew(b.cartId, b.productId, b.customerId, 2)).toEqual({ ok: false, code: 'RESERVATION_MALFORMED_RESOURCE' });

    const c = await seedCartAndProduct(fixture);
    await syncQty(c.cartId, c.productId, 2);
    expect((await inv.reserveOrRenew(c.cartId, c.productId, c.customerId, 2)).ok).toBe(true);
    await patchRedisJson<CartScopedReservationEntry>(reservationKey(c.cartId, c.productId), (e) => {
      e.createdAt = Date.now() + 60_000;
      e.absoluteExpiresAt = e.createdAt + 3_600_000;
    });
    expect(await inv.reserveOrRenew(c.cartId, c.productId, c.customerId, 2)).toEqual({ ok: false, code: 'RESERVATION_MALFORMED_RESOURCE' });
  });

  it('5. checkout-pin and owned CHECKOUT_PENDING classify as CHECKOUT_IN_PROGRESS with bounded retry, not PRODUCT_SUSPECT', async () => {
    const a = await seedCartAndProduct(fixture);
    const markerA = await syncQty(a.cartId, a.productId, 3);
    await cartRepo.addOrIncrementItem(a.cartId, a.productId, 3);
    await redisClient.set(`reservation:fence:checkout-pin:${markerA.id}`, 'checkout-1', 'PX', 60_000);
    expect(await inv.reserveOrRenew(a.cartId, a.productId, a.customerId, 3)).toEqual({ ok: false, code: 'RESERVATION_CHECKOUT_IN_PROGRESS' });
    const compA = await compRepo.create(baseCreateInput({ cartId: a.cartId, productId: a.productId, customerId: a.customerId }));
    expect((await reconciler.attemptRecovery(compA.id, new Date())).outcome).toBe('RETRY_SCHEDULED');
    const afterA = await compRepo.findById(compA.id);
    expect(afterA?.reasonCode).toBe('CHECKOUT_IN_PROGRESS');
    expect(afterA?.lastError).toBeNull();

    const b = await seedCartAndProduct(fixture);
    await syncQty(b.cartId, b.productId, 2);
    expect((await inv.reserveOrRenew(b.cartId, b.productId, b.customerId, 2)).ok).toBe(true);
    await patchRedisJson<CartScopedReservationEntry>(reservationKey(b.cartId, b.productId), (e) => {
      e.status = 'CHECKOUT_PENDING';
      e.checkoutIdempotencyKey = randomUUID();
      e.checkoutPendingAt = Date.now();
      e.checkoutPendingExpiresAt = Date.now() + 60_000;
    });
    expect(await inv.reserveOrRenew(b.cartId, b.productId, b.customerId, 2)).toEqual({ ok: false, code: 'RESERVATION_CHECKOUT_IN_PROGRESS' });
  });

  it('6. product suspension (suspectKey) blocks increases while allowing valid reductions', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    await syncQty(cartId, productId, 5);
    expect((await inv.reserveOrRenew(cartId, productId, customerId, 5)).ok).toBe(true);
    await redisClient.set(productSuspectKey(productId), '1');

    await syncQty(cartId, productId, 2);
    expect((await inv.reserveOrRenew(cartId, productId, customerId, 2)).ok).toBe(true);

    await cartRepo.addOrIncrementItem(cartId, productId, 6);
    await syncQty(cartId, productId, 6);
    expect(await inv.reserveOrRenew(cartId, productId, customerId, 6)).toEqual({ ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' });
    const comp = await compRepo.create(baseCreateInput({ cartId, productId, customerId }));
    expect(await reconciler.attemptRecovery(comp.id, new Date())).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', compensationId: comp.id });
    expect((await compRepo.findById(comp.id))?.reasonCode).toBe('PRODUCT_SUSPENDED');
  });

  it('7. genuine Redis write+observe infrastructure failure returns UNCERTAIN_INFRASTRUCTURE and bounded retry', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    await cartRepo.addOrIncrementItem(cartId, productId, 3);
    await syncQty(cartId, productId, 3);

    const realEval = redisService.eval.bind(redisService);
    const spy = jest.spyOn(redisService, 'eval').mockImplementation(async (script, keys, args) => {
      if (typeof script === 'string' && script.includes('local function completeReason()')) throw new Error('ECONNRESET simulated');
      if (typeof script === 'string' && script.includes("KEYS[2]~='reservation:fence:w1:'..a.requestId") && !script.includes("'PX',5000,'NX'")) {
        throw new Error('ECONNRESET simulated');
      }
      return realEval(script, keys, args);
    });
    try {
      expect(await inv.reserveOrRenew(cartId, productId, customerId, 3)).toEqual({ ok: false, code: 'UNCERTAIN_INFRASTRUCTURE' });
      const row = await compRepo.create(baseCreateInput({ cartId, productId, customerId }));
      expect((await reconciler.attemptRecovery(row.id, new Date())).outcome).toBe('RETRY_SCHEDULED');
      expect((await compRepo.findById(row.id))?.lastError).toBe('UNCERTAIN_INFRASTRUCTURE');
    } finally {
      spy.mockRestore();
    }
  });

  it('8. concurrent W1 reservations preserve total; concurrent underflow classifies deterministically without false generation mismatch', async () => {
    const a = await seedCartAndProduct(fixture);
    const b = await seedSecondCart('conc-b');
    await syncQty(a.cartId, a.productId, 3);
    await syncQty(b.cartId, a.productId, 4);

    const [ra, rb] = await Promise.all([inv.reserveOrRenew(a.cartId, a.productId, a.customerId, 3), inv.reserveOrRenew(b.cartId, a.productId, b.customerId, 4)]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(await redisClient.get(productTotalKey(a.productId))).toBe('7');

    await redisClient.set(productTotalKey(a.productId), '1');
    await syncQty(a.cartId, a.productId, 1);
    await syncQty(b.cartId, a.productId, 2);
    const [ua, ub] = await Promise.all([inv.reserveOrRenew(a.cartId, a.productId, a.customerId, 1), inv.reserveOrRenew(b.cartId, a.productId, b.customerId, 2)]);
    expect(ua).toEqual({ ok: false, code: 'RESERVATION_ACCOUNTING_UNDERFLOW' });
    expect(ub).toEqual({ ok: false, code: 'RESERVATION_ACCOUNTING_UNDERFLOW' });
  });

  it('9. ReservationRecoveryConvergenceService blocks accounting/malformed and retries generation mismatch in CART_SCOPED', async () => {
    await setFenceMode('CART_SCOPED');
    const a = await seedCartAndProduct(fixture);
    const mA = await syncQty(a.cartId, a.productId, 5);
    expect((await inv.reserveOrRenew(a.cartId, a.productId, a.customerId, 5)).ok).toBe(true);
    await redisClient.set(productTotalKey(a.productId), '1');
    await syncQty(a.cartId, a.productId, 2);
    expect(await convergence.convergeCartScopedDirect({ cartId: a.cartId, productId: a.productId, customerId: a.customerId, desiredQuantity: 2 }))
      .toEqual({ outcome: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT' });

    await redisClient.set(productTotalKey(a.productId), '5');
    await patchRedisJson<ResourceGuardPayload>(resourceGuardKey(mA.id), (g) => {
      g.resource.generation = 888;
    });
    expect(await convergence.convergeCartScopedDirect({ cartId: a.cartId, productId: a.productId, customerId: a.customerId, desiredQuantity: 2 }))
      .toEqual({ outcome: 'RETRY', reasonCode: 'UNKNOWN_INFRA_FAILURE', lastError: 'RESERVATION_RESOURCE_GENERATION_MISMATCH' });
  });

  it('10. durable ProductReservationRestriction (PREPARED & ENFORCED) maps to RESERVATION_PRODUCT_SUSPENDED -> BLOCKED_PRODUCT_SUSPECT', async () => {
    const a = await seedCartAndProduct(fixture);
    const b = await seedSecondCart('restrict-b');
    const markerA = await syncQty(a.cartId, a.productId, 3);
    await syncQty(b.cartId, a.productId, 4);
    expect((await inv.reserveOrRenew(a.cartId, a.productId, a.customerId, 3)).ok).toBe(true);
    expect((await inv.reserveOrRenew(b.cartId, a.productId, b.customerId, 4)).ok).toBe(true);

    await redisClient.set(productTotalKey(a.productId), '1');
    const admission = new ProductReservationRestrictionAdmissionService(prisma, redisService);
    const restrictionService = new ProductReservationRestrictionService(prisma, redisService, admission);
    const token = await admission.observe(markerA.id);
    expect(token).not.toBeNull();
    const prepared = await restrictionService.prepare(token);
    expect(prepared?.state).toBe('PREPARED');

    await redisClient.set(productTotalKey(a.productId), '7');
    await cartRepo.addOrIncrementItem(a.cartId, a.productId, 5);
    await syncQty(a.cartId, a.productId, 5);
    expect(await inv.reserveOrRenew(a.cartId, a.productId, a.customerId, 5)).toEqual({ ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' });
    const comp = await compRepo.create(baseCreateInput({ cartId: a.cartId, productId: a.productId, customerId: a.customerId }));
    expect(await reconciler.attemptRecovery(comp.id, new Date())).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', compensationId: comp.id });
    expect((await compRepo.findById(comp.id))?.reasonCode).toBe('PRODUCT_SUSPENDED');

    expect(await restrictionService.install(prepared!.id)).toBe('ENFORCED');
    expect(await inv.reserveOrRenew(a.cartId, a.productId, a.customerId, 5)).toEqual({ ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' });
  });
});
