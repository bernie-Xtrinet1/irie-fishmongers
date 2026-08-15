import { Redis } from 'ioredis';

import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { productSuspectKey, productTotalKey, reservationHashKey } from '../../inventory/constants/inventory.constants';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { connectRealRedis } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { CartRepository } from '../../cart/repositories/cart.repository';
import {
  CompensationTestFixture,
  seedCartAndProduct,
  setUpCompensationFixture,
  tearDownCompensationFixture,
} from '../../mirror-compensation/repositories/compensation-repository-test-helpers';
import { CompensationRepository } from '../../mirror-compensation/repositories/compensation.repository';
import { CompensationBlockedRecheckService } from '../../mirror-compensation/services/compensation-blocked-recheck.service';
import { CompensationReconciliationService } from '../../mirror-compensation/services/compensation-reconciliation.service';
import { CompensationService } from '../../mirror-compensation/services/compensation.service';
import { ReservationAvailabilityService } from '../../reservation-engine-mode/services/reservation-availability.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { CheckoutReservationFacade } from './checkout-reservation-facade.service';

// Phase 16A.0-DA, Unit DA.4 (see the DA.4 frozen plan and read-only
// report). End-to-end real-Postgres + real-Redis proof that the MIRROR
// compensation entry-point gap identified by the DA.4 read-only report is
// actually closed: a genuine secondary-write failure observed by
// CheckoutReservationFacade now reaches a durable CartReservationCompensation
// row, and the already-shipped C4.3 reconciler (CompensationReconciliationService/
// CompensationBlockedRecheckService) - completely unmodified by this unit -
// resolves it to a terminal state. Reuses the exact fixture helpers C4.3's
// own real-Postgres+Redis suite established
// (compensation-repository-test-helpers.ts) rather than duplicating fixture
// setup. ReservationEngineModeService is mocked (getCurrentMode only),
// matching every other real-Redis facade/reconciliation suite's convention.
// Requires a reachable Redis (REDIS_URL) and fails loudly rather than
// skipping.
jest.setTimeout(30_000);

const ISOLATED_DB_INDEX = 1;

describe('CheckoutReservationFacade -> CompensationService -> C4.3 reconciliation (real Postgres + Redis)', () => {
  let redisClient: Redis;
  let prisma: PrismaService;
  let fixture: CompensationTestFixture;
  let cartRepository: CartRepository;
  let compensationRepository: CompensationRepository;
  let inventoryReservations: InventoryReservationsService;
  let modeService: jest.Mocked<Pick<ReservationEngineModeService, 'getCurrentMode'>>;
  let compensationService: CompensationService;
  let reconciliationService: CompensationReconciliationService;
  let blockedRecheckService: CompensationBlockedRecheckService;
  let facade: CheckoutReservationFacade;

  function setMode(mode: 'LEGACY' | 'MIRROR' | 'CART_SCOPED' | 'DRAINING'): void {
    modeService.getCurrentMode.mockResolvedValue(mode);
  }

  beforeAll(async () => {
    redisClient = await connectRealRedis();
    await redisClient.select(ISOLATED_DB_INDEX);
    prisma = new PrismaService();
    await prisma.onModuleInit();
    fixture = await setUpCompensationFixture(prisma);
  });

  afterAll(async () => {
    await tearDownCompensationFixture(fixture);
    await prisma.onModuleDestroy();
    await redisClient.flushdb();
    await redisClient.quit();
  });

  beforeEach(async () => {
    await redisClient.flushdb();
    cartRepository = new CartRepository(prisma);
    compensationRepository = new CompensationRepository(prisma);
    const redisService = new RedisService(redisClient);
    inventoryReservations = new InventoryReservationsService(redisService);
    modeService = { getCurrentMode: jest.fn().mockResolvedValue('MIRROR') };
    compensationService = new CompensationService(compensationRepository);
    reconciliationService = new CompensationReconciliationService(
      compensationRepository,
      cartRepository,
      inventoryReservations,
      modeService as unknown as ReservationEngineModeService,
    );
    blockedRecheckService = new CompensationBlockedRecheckService(
      compensationRepository,
      cartRepository,
      inventoryReservations,
      modeService as unknown as ReservationEngineModeService,
    );
    const availability = { getCartAdmissionAvailability: jest.fn() } as unknown as ReservationAvailabilityService;
    facade = new CheckoutReservationFacade(
      modeService as unknown as ReservationEngineModeService,
      inventoryReservations,
      availability,
      compensationService,
    );
  });

  it('1. a genuine PRODUCT_SUSPENDED mirror-write failure reaches a durable compensation row, which the existing C4.3 reconciler resolves to RESOLVED', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    await cartRepository.addOrIncrementItem(cartId, productId, 5);
    await redisClient.set(productSuspectKey(productId), '1');
    setMode('MIRROR');

    const result = await facade.reserveForCart(cartId, productId, customerId, 5);

    expect(result).toEqual({
      ok: true,
      mode: 'MIRROR',
      mirror: { status: 'FAILED', operation: 'RESERVE', reasonCode: 'PRODUCT_SUSPENDED' },
    });
    // The authoritative LEGACY leg still succeeded.
    const rawLegacy = await redisClient.hget(reservationHashKey(productId), cartId);
    expect(rawLegacy).not.toBeNull();
    expect((JSON.parse(rawLegacy!) as { quantity: number }).quantity).toBe(5);

    const row = await prisma.cartReservationCompensation.findFirst({ where: { cartId, productId } });
    expect(row).not.toBeNull();
    expect(row?.operation).toBe('RESERVE_MIRROR');
    // recordMirrorDivergence only creates the diagnostic row (always
    // PENDING - see CompensationRepository.create's own contract); the
    // BLOCKED transition happens later, inside attemptRecovery itself.
    expect(row?.status).toBe('PENDING');
    expect(row?.reasonCode).toBe('PRODUCT_SUSPENDED');

    // The existing, unmodified-by-this-unit C4.3 reconciler takes it from
    // here: PENDING -> blocked (product still suspended in real Redis) ->
    // unblocked once the suspect flag clears -> converged.
    const stillBlocked = await reconciliationService.attemptRecovery(row!.id, new Date());
    expect(stillBlocked).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', compensationId: row!.id });

    await redisClient.del(productSuspectKey(productId));
    const unblocked = await blockedRecheckService.recheckBlocked(row!.id, new Date());
    expect(unblocked).toEqual({ outcome: 'UNBLOCKED_PENDING', compensationId: row!.id });

    const converged = await reconciliationService.attemptRecovery(row!.id, new Date());
    expect(converged).toEqual({ outcome: 'RESOLVED_CONVERGED', compensationId: row!.id });

    const finalRow = await prisma.cartReservationCompensation.findUniqueOrThrow({ where: { id: row!.id } });
    expect(finalRow.status).toBe('RESOLVED');
  });

  it('2. a genuine cart-scoped release divergence reaches a durable row and resolves the same way', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    // Seed a genuine leftover cart-scoped hold with no matching CartItem,
    // then corrupt the product total so the mirror release underflows -
    // a real Lua-detected accounting condition, not a mocked one.
    await inventoryReservations.reserveOrRenew(cartId, productId, customerId, 4);
    await facade.reserveForCart(cartId, productId, customerId, 4); // seed a matching legacy hold too
    setMode('MIRROR');
    await redisClient.set(productTotalKey(productId), '1');

    const result = await facade.releaseForCart(cartId, productId);

    expect(result).toEqual({
      ok: true,
      mode: 'MIRROR',
      mirror: { status: 'FAILED', operation: 'RELEASE', reasonCode: 'ACCOUNTING_UNDERFLOW' },
    });
    // Legacy release still succeeded.
    expect(await redisClient.hget(reservationHashKey(productId), cartId)).toBeNull();

    const row = await prisma.cartReservationCompensation.findFirst({ where: { cartId, productId } });
    expect(row).not.toBeNull();
    expect(row?.operation).toBe('RELEASE_MIRROR');
    expect(row?.status).toBe('PENDING');
    expect(row?.reasonCode).toBe('ACCOUNTING_UNDERFLOW');

    // Desired state re-derives to "release" (no CartItem exists - the
    // facade never touches Postgres CartItem rows), so the real C4.3
    // reconciler converges it directly on the first attempt, no BLOCKED
    // detour needed for this particular divergence.
    const converged = await reconciliationService.attemptRecovery(row!.id, new Date());
    expect(converged).toEqual({ outcome: 'RESOLVED_CONVERGED', compensationId: row!.id });
  });

  it('3. a persistence failure while recording a genuine mirror divergence does not undo the successful LEGACY write, and leaves no compensation row', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    await redisClient.set(productSuspectKey(productId), '1'); // guarantees a genuine FAILED mirror diagnostic
    setMode('MIRROR');
    const persistSpy = jest
      .spyOn(compensationService, 'recordMirrorDivergence')
      .mockRejectedValue(new Error('P2028: transaction timeout'));

    const result = await facade.reserveForCart(cartId, productId, customerId, 5);

    expect(result).toEqual({
      ok: true,
      mode: 'MIRROR',
      mirror: { status: 'FAILED', operation: 'RESERVE', reasonCode: 'PRODUCT_SUSPENDED' },
    });
    const rawLegacy = await redisClient.hget(reservationHashKey(productId), cartId);
    expect(rawLegacy).not.toBeNull();
    expect((JSON.parse(rawLegacy!) as { quantity: number }).quantity).toBe(5);

    const row = await prisma.cartReservationCompensation.findFirst({ where: { cartId, productId } });
    expect(row).toBeNull();

    persistSpy.mockRestore();
  });
});
