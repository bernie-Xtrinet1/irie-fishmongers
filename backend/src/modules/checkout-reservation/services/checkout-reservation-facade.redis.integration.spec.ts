import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import {
  productSuspectKey,
  productTotalKey,
  reservationHashKey,
} from '../../inventory/constants/inventory.constants';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { connectRealRedis, ids } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { CompensationService } from '../../mirror-compensation/services/compensation.service';
import { ReservationAvailabilityService } from '../../reservation-engine-mode/services/reservation-availability.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { CheckoutReservationFacade } from './checkout-reservation-facade.service';

// Phase 16A.0-C, Unit C3. Real-Redis integration coverage for
// CheckoutReservationFacade's write routing and mirror diagnostics. The
// unit suites mock InventoryReservationsService entirely and can only
// verify routing logic; they cannot prove real legacy-hash/cart-scoped-Lua
// arithmetic or that mirror underflow is genuinely detected. This suite
// requires a reachable Redis (REDIS_URL) and fails loudly rather than
// skipping - same convention as every other real-Redis spec in this
// codebase.
//
// ReservationEngineModeService is mocked (getCurrentMode only) - mode-
// transition mechanics are already covered by its own suites; this file
// exists to prove the facade's Redis-facing behavior. ReservationAvailabilityService
// is unused by any test here (getCartAdmissionAvailability is a pure
// delegation, already proven by mocked unit tests) and is constructed with
// a minimal stub. CompensationService (Phase 16A.0-DA, Unit DA.4) is
// likewise stubbed - this file has no real Postgres fixture and exists to
// prove Redis-facing behavior only; the genuine divergence-record ->
// C4.3 reconciliation -> resolved proof (real Postgres AND real Redis)
// lives in checkout-reservation-facade-divergence.postgres.integration.spec.ts.
//
// Test isolation - same dedicated logical Redis DB (1) and per-test
// FLUSHDB convention established by C1/C2's real-Redis suites.
jest.setTimeout(30_000);

const ISOLATED_DB_INDEX = 1;

describe('CheckoutReservationFacade (real Redis integration)', () => {
  let client: Redis;
  let inventoryReservations: InventoryReservationsService;
  let modeService: jest.Mocked<Pick<ReservationEngineModeService, 'getCurrentMode'>>;
  let facade: CheckoutReservationFacade;

  function setMode(mode: 'LEGACY' | 'MIRROR' | 'CART_SCOPED' | 'DRAINING'): void {
    modeService.getCurrentMode.mockResolvedValue(mode);
  }

  beforeAll(async () => {
    client = await connectRealRedis();
    await client.select(ISOLATED_DB_INDEX);
  });

  afterAll(async () => {
    await client.flushdb();
    await client.quit();
  });

  beforeEach(async () => {
    await client.flushdb();
    const redisService = new RedisService(client);
    inventoryReservations = new InventoryReservationsService(redisService);
    modeService = { getCurrentMode: jest.fn() };
    const availability = { getCartAdmissionAvailability: jest.fn() } as unknown as ReservationAvailabilityService;
    const compensation = {
      recordMirrorDivergence: jest.fn().mockResolvedValue({ ok: true, outcome: 'CREATED', compensationId: 'stub' }),
    } as unknown as CompensationService;
    facade = new CheckoutReservationFacade(
      modeService as unknown as ReservationEngineModeService,
      inventoryReservations,
      availability,
      compensation,
    );
  });

  it('1. LEGACY reserve writes the legacy hash only', async () => {
    const { cartId, productId, customerId } = ids();
    setMode('LEGACY');

    await facade.reserveForCart(cartId, productId, customerId, 5);

    expect(await client.hget(reservationHashKey(productId), cartId)).not.toBeNull();
    expect(await client.get(productTotalKey(productId))).toBeNull();
  });

  it('2. MIRROR reserve writes both systems for the same logical hold', async () => {
    const { cartId, productId, customerId } = ids();
    setMode('MIRROR');

    const result = await facade.reserveForCart(cartId, productId, customerId, 5);

    expect(result).toEqual({ ok: true, mode: 'MIRROR', mirror: { status: 'SYNCED' } });
    expect(await client.hget(reservationHashKey(productId), cartId)).not.toBeNull();
    expect(await client.get(productTotalKey(productId))).toBe('5');
  });

  it('3. CART_SCOPED reserve writes the new engine only', async () => {
    const { cartId, productId, customerId } = ids();
    setMode('CART_SCOPED');

    await facade.reserveForCart(cartId, productId, customerId, 5);

    expect(await client.get(productTotalKey(productId))).toBe('5');
    expect(await client.hget(reservationHashKey(productId), cartId)).toBeNull();
  });

  it('4. DRAINING reserve writes nothing', async () => {
    const { cartId, productId, customerId } = ids();
    setMode('DRAINING');

    const result = await facade.reserveForCart(cartId, productId, customerId, 5);

    expect(result).toEqual({ ok: false, mode: 'DRAINING', code: 'MODE_NOT_ADMITTING' });
    expect(await client.get(productTotalKey(productId))).toBeNull();
    expect(await client.hget(reservationHashKey(productId), cartId)).toBeNull();
  });

  it('5. DRAINING full release drains a genuine CART_SCOPED-era hold', async () => {
    const { cartId, productId, customerId } = ids();
    await inventoryReservations.reserveOrRenew(cartId, productId, customerId, 5);
    setMode('DRAINING');

    const result = await facade.releaseForCart(cartId, productId);

    expect(result).toEqual({ ok: true, mode: 'DRAINING', mirror: { status: 'NOT_ATTEMPTED' } });
    expect(await client.get(productTotalKey(productId))).toBe('0');
  });

  it('6. MIRROR release clears both systems', async () => {
    const { cartId, productId, customerId } = ids();
    setMode('MIRROR');
    await facade.reserveForCart(cartId, productId, customerId, 5);

    const result = await facade.releaseForCart(cartId, productId);

    expect(result).toEqual({ ok: true, mode: 'MIRROR', mirror: { status: 'SYNCED' } });
    expect(await client.hget(reservationHashKey(productId), cartId)).toBeNull();
    expect(await client.get(productTotalKey(productId))).toBe('0');
  });

  it('7. MIRROR new-engine PRODUCT_SUSPENDED leaves legacy authoritative and the customer result successful', async () => {
    const { cartId, productId, customerId } = ids();
    setMode('MIRROR');
    await client.set(productSuspectKey(productId), '1');

    const result = await facade.reserveForCart(cartId, productId, customerId, 5);

    expect(result).toEqual({
      ok: true,
      mode: 'MIRROR',
      mirror: { status: 'FAILED', operation: 'RESERVE', reasonCode: 'PRODUCT_SUSPENDED' },
    });
    const rawLegacy = await client.hget(reservationHashKey(productId), cartId);
    expect(rawLegacy).not.toBeNull();
    expect((JSON.parse(rawLegacy!) as { quantity: number }).quantity).toBe(5);
  });

  it('8. MIRROR reserve ACCOUNTING_UNDERFLOW leaves the legacy reservation correct', async () => {
    const { cartId, productId, customerId } = ids();
    await inventoryReservations.reserveOrRenew(cartId, productId, customerId, 10);
    await client.set(productTotalKey(productId), '2'); // corrupt below the upcoming negative delta
    setMode('MIRROR');

    const result = await facade.reserveForCart(cartId, productId, customerId, 3); // delta -7 against a stored total of 2

    expect(result).toEqual({
      ok: true,
      mode: 'MIRROR',
      mirror: { status: 'FAILED', operation: 'RESERVE', reasonCode: 'ACCOUNTING_UNDERFLOW' },
    });
    const rawLegacy = await client.hget(reservationHashKey(productId), cartId);
    expect((JSON.parse(rawLegacy!) as { quantity: number }).quantity).toBe(3);
  });

  it('9. MIRROR release ACCOUNTING_UNDERFLOW still leaves the customer result successful', async () => {
    const { cartId, productId, customerId } = ids();
    await inventoryReservations.reserveOrRenew(cartId, productId, customerId, 10);
    await facade.reserveForCart(cartId, productId, customerId, 10); // seeds a matching legacy hold too
    await client.set(productTotalKey(productId), '2'); // corrupt below the quantity release will subtract
    setMode('MIRROR');

    const result = await facade.releaseForCart(cartId, productId);

    expect(result).toEqual({
      ok: true,
      mode: 'MIRROR',
      mirror: { status: 'FAILED', operation: 'RELEASE', reasonCode: 'ACCOUNTING_UNDERFLOW' },
    });
    expect(await client.hget(reservationHashKey(productId), cartId)).toBeNull(); // legacy release still succeeded
  });

  it('10. cross-mode key isolation', async () => {
    const legacy = ids();
    setMode('LEGACY');
    await facade.reserveForCart(legacy.cartId, legacy.productId, legacy.customerId, 5);
    expect(await client.get(productTotalKey(legacy.productId))).toBeNull();

    const cartScoped = ids();
    setMode('CART_SCOPED');
    await facade.reserveForCart(cartScoped.cartId, cartScoped.productId, cartScoped.customerId, 5);
    expect(await client.hget(reservationHashKey(cartScoped.productId), cartScoped.cartId)).toBeNull();
  });
});
