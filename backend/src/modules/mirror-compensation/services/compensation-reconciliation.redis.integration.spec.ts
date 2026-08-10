import { Redis } from 'ioredis';

import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { productSuspectKey, productTotalKey, reservationHashKey } from '../../inventory/constants/inventory.constants';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { connectRealRedis } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { CartRepository } from '../../cart/repositories/cart.repository';
import {
  CompensationTestFixture,
  baseCreateInput,
  seedCartAndProduct,
  setUpCompensationFixture,
  tearDownCompensationFixture,
} from '../repositories/compensation-repository-test-helpers';
import { CompensationRepository } from '../repositories/compensation.repository';
import { CompensationBlockedRecheckService } from './compensation-blocked-recheck.service';
import { CompensationReconciliationService } from './compensation-reconciliation.service';
import { CompensationService } from './compensation.service';

// Phase 16A.0-C4.3. End-to-end real-Postgres + real-Redis coverage. Both
// mocked spec files (compensation-reconciliation.service.spec.ts,
// compensation-reconciliation-mode-matrix.service.spec.ts,
// compensation-blocked-recheck.service.spec.ts) mock every dependency and
// can only verify routing logic - they cannot prove genuine Lua-script
// suspect/underflow detection, genuine Cart/CartItem reads, or genuine
// generation-race safety. ReservationEngineModeService is mocked
// (getCurrentMode only) - mode-transition mechanics are already covered
// by its own suites; this file proves the reconciler's Postgres/Redis-
// facing behavior, matching checkout-reservation-facade's established
// precedent for combining a real InventoryReservationsService with a
// mocked mode service. Requires a reachable Redis (REDIS_URL) and fails
// loudly rather than skipping.
jest.setTimeout(30_000);

const ISOLATED_DB_INDEX = 1;

describe('CompensationReconciliationService / CompensationBlockedRecheckService (real Postgres + Redis)', () => {
  let redisClient: Redis;
  let prisma: PrismaService;
  let fixture: CompensationTestFixture;
  let compensationRepository: CompensationRepository;
  let cartRepository: CartRepository;
  let inventoryReservations: InventoryReservationsService;
  let modeService: jest.Mocked<Pick<ReservationEngineModeService, 'getCurrentMode'>>;
  let compensationService: CompensationService;
  let reconciliationService: CompensationReconciliationService;
  let blockedRecheckService: CompensationBlockedRecheckService;

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
    compensationRepository = new CompensationRepository(prisma);
    cartRepository = new CartRepository(prisma);
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
  });

  it('1. reserve convergence: a CartItem with quantity 7 converges the cart-scoped mirror to 7', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    await cartRepository.addOrIncrementItem(cartId, productId, 7);
    const row = await compensationRepository.create(
      baseCreateInput({ cartId, productId, customerId, reasonCode: 'UNKNOWN_INFRA_FAILURE' }),
    );
    setMode('MIRROR');

    const result = await reconciliationService.attemptRecovery(row.id, new Date());

    expect(result).toEqual({ outcome: 'RESOLVED_CONVERGED', compensationId: row.id });
    expect(await redisClient.get(productTotalKey(productId))).toBe('7');
    const updated = await compensationRepository.findById(row.id);
    expect(updated?.status).toBe('RESOLVED');
  });

  it('2. release convergence: a removed CartItem drains a genuine leftover mirror hold to zero', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    await inventoryReservations.reserveOrRenew(cartId, productId, customerId, 4); // leftover mirror hold, no CartItem
    const row = await compensationRepository.create(
      baseCreateInput({ cartId, productId, customerId, operation: 'RELEASE_MIRROR', desiredQuantity: null }),
    );
    setMode('MIRROR');

    const result = await reconciliationService.attemptRecovery(row.id, new Date());

    expect(result).toEqual({ outcome: 'RESOLVED_CONVERGED', compensationId: row.id });
    expect(await inventoryReservations.getActiveReservation(cartId, productId)).toBeNull();
  });

  it('3. a genuine PRODUCT_SUSPECT block heals via real reconciliation and then converges', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    await cartRepository.addOrIncrementItem(cartId, productId, 3);
    await redisClient.set(productSuspectKey(productId), '1');
    const row = await compensationRepository.create(
      baseCreateInput({ cartId, productId, customerId, reasonCode: 'UNKNOWN_INFRA_FAILURE' }),
    );
    setMode('MIRROR');

    const blocked = await reconciliationService.attemptRecovery(row.id, new Date());
    expect(blocked).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', compensationId: row.id });
    expect((await compensationRepository.findById(row.id))?.blockReason).toBe('PRODUCT_SUSPECT');

    const unblocked = await blockedRecheckService.recheckBlocked(row.id, new Date());
    expect(unblocked).toEqual({ outcome: 'UNBLOCKED_PENDING', compensationId: row.id });
    expect(await redisClient.get(productSuspectKey(productId))).toBeNull();

    const converged = await reconciliationService.attemptRecovery(row.id, new Date());
    expect(converged).toEqual({ outcome: 'RESOLVED_CONVERGED', compensationId: row.id });
  });

  it('4. a genuine ACCOUNTING_UNDERFLOW block heals via real reconciliation and then converges', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    await inventoryReservations.reserveOrRenew(cartId, productId, customerId, 10);
    await redisClient.set(productTotalKey(productId), '2'); // corrupt below the upcoming negative delta
    await cartRepository.addOrIncrementItem(cartId, productId, 3); // delta -7 against a stored total of 2
    const row = await compensationRepository.create(
      baseCreateInput({ cartId, productId, customerId, reasonCode: 'UNKNOWN_INFRA_FAILURE' }),
    );
    setMode('MIRROR');

    const blocked = await reconciliationService.attemptRecovery(row.id, new Date());
    expect(blocked).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', compensationId: row.id });
    expect((await compensationRepository.findById(row.id))?.reasonCode).toBe('ACCOUNTING_UNDERFLOW');

    const unblocked = await blockedRecheckService.recheckBlocked(row.id, new Date());
    expect(unblocked).toEqual({ outcome: 'UNBLOCKED_PENDING', compensationId: row.id });

    const converged = await reconciliationService.attemptRecovery(row.id, new Date());
    expect(converged).toEqual({ outcome: 'RESOLVED_CONVERGED', compensationId: row.id });
  });

  it('5. a concurrent divergence arrival mid-recovery supersedes the attempt: old worker cannot resolve', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    await cartRepository.addOrIncrementItem(cartId, productId, 5);
    const row = await compensationRepository.create(
      baseCreateInput({ cartId, productId, customerId, reasonCode: 'UNKNOWN_INFRA_FAILURE' }),
    );
    setMode('MIRROR');

    const findItemSpy = jest.spyOn(cartRepository, 'findItemByCartAndProduct').mockImplementationOnce(
      async (...args) => {
        const real = await CartRepository.prototype.findItemByCartAndProduct.apply(cartRepository, args);
        // A newer divergence arrives while this attempt is still in flight.
        await compensationService.recordMirrorDivergence({
          operation: 'RESERVE_MIRROR',
          cartId,
          productId,
          customerId,
          desiredQuantity: 9,
          reasonCode: 'CHECKOUT_IN_PROGRESS',
          lastError: null,
          now: new Date(),
        });
        return real;
      },
    );

    const result = await reconciliationService.attemptRecovery(row.id, new Date());

    expect(result).toEqual({ outcome: 'REQUEUED_NEWER_DIVERGENCE', compensationId: row.id });
    const updated = await compensationRepository.findById(row.id);
    expect(updated?.status).toBe('PENDING');
    expect(updated?.generation).toBe(1);
    expect(updated?.reasonCode).toBe('CHECKOUT_IN_PROGRESS');
    findItemSpy.mockRestore();
  });

  it('6. repeated reconciliation is idempotent: a RESOLVED row is untouched by a second attempt', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    await cartRepository.addOrIncrementItem(cartId, productId, 2);
    const row = await compensationRepository.create(
      baseCreateInput({ cartId, productId, customerId, reasonCode: 'UNKNOWN_INFRA_FAILURE' }),
    );
    setMode('MIRROR');
    await reconciliationService.attemptRecovery(row.id, new Date());
    const totalAfterFirst = await redisClient.get(productTotalKey(productId));

    const second = await reconciliationService.attemptRecovery(row.id, new Date());

    expect(second).toEqual({ outcome: 'ALREADY_RESOLVED', compensationId: row.id });
    expect(await redisClient.get(productTotalKey(productId))).toBe(totalAfterFirst);
  });

  it('7. DRAINING with a positive desired quantity blocks without ever writing a reservation key', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    await cartRepository.addOrIncrementItem(cartId, productId, 6);
    const row = await compensationRepository.create(
      baseCreateInput({ cartId, productId, customerId, reasonCode: 'UNKNOWN_INFRA_FAILURE' }),
    );
    setMode('DRAINING');

    const result = await reconciliationService.attemptRecovery(row.id, new Date());

    expect(result).toEqual({ outcome: 'BLOCKED_MODE_NOT_ADMITTING', compensationId: row.id });
    expect(await inventoryReservations.getActiveReservation(cartId, productId)).toBeNull();
    expect(await redisClient.get(productTotalKey(productId))).toBeNull();
  });

  it('8. never writes the legacy hash-based reservation during recovery', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    await cartRepository.addOrIncrementItem(cartId, productId, 4);
    const row = await compensationRepository.create(
      baseCreateInput({ cartId, productId, customerId, reasonCode: 'UNKNOWN_INFRA_FAILURE' }),
    );
    setMode('MIRROR');

    await reconciliationService.attemptRecovery(row.id, new Date());

    expect(await redisClient.hget(reservationHashKey(productId), cartId)).toBeNull();
  });
});
