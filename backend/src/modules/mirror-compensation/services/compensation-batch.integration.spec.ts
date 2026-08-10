import { Redis } from 'ioredis';

import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { productTotalKey } from '../../inventory/constants/inventory.constants';
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
import { CompensationBatchService } from './compensation-batch.service';
import { CompensationBlockedRecheckService } from './compensation-blocked-recheck.service';
import { CompensationReconciliationService } from './compensation-reconciliation.service';

// Phase 16A.0-C4.4. Real-Postgres + real-Redis coverage for
// CompensationBatchService, in particular the concurrency claims the
// approved contract makes (and does NOT make):
//
// PENDING / stale PROCESSING: overlapping batch workers may select the
// same candidate; exactly one atomic recovery claim succeeds; duplicate
// recovery mutation does not occur. Tested separately from BLOCKED.
//
// BLOCKED: overlapping rechecks may both perform precondition reads;
// harmless duplicate bookkeeping is possible; generation/status guards
// preserve convergence safety. This suite does NOT assert exactly-once
// BLOCKED processing - that claim is deliberately not made (see the
// approved C4.4 concurrency analysis).
//
// ReservationEngineModeService is mocked (getCurrentMode only), matching
// C4.3's own established precedent for this combined-backend spec shape.
jest.setTimeout(30_000);

// Deliberately NOT database index 1 - that is the shared convention used
// by every other real-Redis integration spec in this codebase
// (checkout-reservation-facade, reservation-availability,
// reservation-engine-mode-rollback, compensation-reconciliation). A real
// collision was reproduced during C4.4 validation: when two files
// sharing index 1 run in genuinely overlapping Jest workers, one file's
// per-test flushdb() can wipe another file's just-written key before its
// own assertion runs - a pre-existing risk in that shared-index
// convention, not a production defect (this file's own claim/attemptCount
// assertions proved the underlying logic correct even when the Redis
// assertion collided). Using a dedicated index sidesteps the collision
// for this file without touching the pre-existing convention elsewhere.
const ISOLATED_DB_INDEX = 2;

describe('CompensationBatchService.runBatch (real Postgres + Redis)', () => {
  let redisClient: Redis;
  let prisma: PrismaService;
  let fixture: CompensationTestFixture;
  let compensationRepository: CompensationRepository;
  let cartRepository: CartRepository;
  let inventoryReservations: InventoryReservationsService;
  let modeService: jest.Mocked<Pick<ReservationEngineModeService, 'getCurrentMode'>>;
  let reconciliationService: CompensationReconciliationService;
  let blockedRecheckService: CompensationBlockedRecheckService;
  let batchService: CompensationBatchService;

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
    batchService = new CompensationBatchService(compensationRepository, reconciliationService, blockedRecheckService);
  });

  it('1. end-to-end: converges a due PENDING row, reclaims a stale PROCESSING row, and unblocks a due BLOCKED row in one run', async () => {
    const pending = await seedCartAndProduct(fixture);
    await cartRepository.addOrIncrementItem(pending.cartId, pending.productId, 4);
    const pendingRow = await compensationRepository.create(
      baseCreateInput({ ...pending, reasonCode: 'UNKNOWN_INFRA_FAILURE' }),
    );

    const stale = await seedCartAndProduct(fixture);
    await cartRepository.addOrIncrementItem(stale.cartId, stale.productId, 2);
    const staleRow = await compensationRepository.create(
      baseCreateInput({ ...stale, reasonCode: 'UNKNOWN_INFRA_FAILURE' }),
    );
    await prisma.cartReservationCompensation.update({
      where: { id: staleRow.id },
      data: { status: 'PROCESSING', lastAttemptAt: new Date(Date.now() - 6 * 60 * 1000) },
    });

    const blocked = await seedCartAndProduct(fixture);
    await cartRepository.addOrIncrementItem(blocked.cartId, blocked.productId, 3);
    const blockedRow = await compensationRepository.create(
      baseCreateInput({ ...blocked, reasonCode: 'PRODUCT_SUSPENDED' }),
    );
    await prisma.cartReservationCompensation.update({
      where: { id: blockedRow.id },
      data: { status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT', nextAttemptAt: new Date(Date.now() - 1000) },
    });

    const result = await batchService.runBatch({ now: new Date(), limit: 200 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.candidatesFound).toBeGreaterThanOrEqual(3);
    expect(result.result.resolved).toBeGreaterThanOrEqual(2); // pendingRow + staleRow converge
    expect(result.result.unblocked).toBeGreaterThanOrEqual(1); // blockedRow unblocks (healthy product accounting)

    expect(await redisClient.get(productTotalKey(pending.productId))).toBe('4');
    expect(await redisClient.get(productTotalKey(stale.productId))).toBe('2');
    const updatedPending = await compensationRepository.findById(pendingRow.id);
    const updatedStale = await compensationRepository.findById(staleRow.id);
    const updatedBlocked = await compensationRepository.findById(blockedRow.id);
    expect(updatedPending?.status).toBe('RESOLVED');
    expect(updatedStale?.status).toBe('RESOLVED');
    // Unblocked to PENDING (not yet RESOLVED - that's a second, separate
    // attemptRecovery pass, exactly what the follow-up call below proves
    // and also drains it so it can't pollute a later test's whole-table
    // candidate scan as a stray due row).
    expect(updatedBlocked?.status).toBe('PENDING');

    const followUp = await batchService.runBatch({ now: new Date(), limit: 200 });
    expect(followUp.ok).toBe(true);
    const finalBlocked = await compensationRepository.findById(blockedRow.id);
    expect(finalBlocked?.status).toBe('RESOLVED');
  });

  describe('PENDING atomic-claim exclusion under concurrent workers', () => {
    it('2. two concurrent batch runs selecting the same due PENDING row: exactly one converges it, the other finds nothing left to do', async () => {
      const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
      await cartRepository.addOrIncrementItem(cartId, productId, 6);
      const row = await compensationRepository.create(
        baseCreateInput({ cartId, productId, customerId, reasonCode: 'UNKNOWN_INFRA_FAILURE' }),
      );
      const now = new Date();

      const [first, second] = await Promise.all([
        batchService.runBatch({ now, limit: 200 }),
        batchService.runBatch({ now, limit: 200 }),
      ]);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);

      // Row-scoped proof, deliberately not based on the aggregate
      // resolved counters - findBatchCandidateIds scans the whole table,
      // so an aggregate count can be inflated by unrelated due rows left
      // by other concurrently-running spec files sharing this database.
      // claimForRecoveryAttempt increments attemptCount exactly once per
      // successful claim and never touches it on a failed (count=0)
      // claim, so attemptCount===1 is direct proof that only one of the
      // two concurrent claims for THIS row ever succeeded.
      const updated = await compensationRepository.findById(row.id);
      expect(updated?.status).toBe('RESOLVED');
      expect(updated?.attemptCount).toBe(1);
      expect(await redisClient.get(productTotalKey(productId))).toBe('6');
    });
  });

  describe('stale PROCESSING atomic-claim exclusion under concurrent workers', () => {
    it('3. two concurrent batch runs selecting the same stale PROCESSING row: exactly one reclaims and converges it', async () => {
      const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
      await cartRepository.addOrIncrementItem(cartId, productId, 5);
      const row = await compensationRepository.create(
        baseCreateInput({ cartId, productId, customerId, reasonCode: 'UNKNOWN_INFRA_FAILURE' }),
      );
      await prisma.cartReservationCompensation.update({
        where: { id: row.id },
        data: { status: 'PROCESSING', lastAttemptAt: new Date(Date.now() - 6 * 60 * 1000) },
      });
      const now = new Date();

      const [first, second] = await Promise.all([
        batchService.runBatch({ now, limit: 200 }),
        batchService.runBatch({ now, limit: 200 }),
      ]);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);

      // Row-scoped proof, same rationale as the PENDING case above -
      // attemptCount===1 proves only one of the two concurrent stale
      // reclaims for THIS row ever succeeded, independent of whatever
      // else the whole-table scan may have picked up.
      const updated = await compensationRepository.findById(row.id);
      expect(updated?.status).toBe('RESOLVED');
      expect(updated?.attemptCount).toBe(1);
    });
  });

  describe('BLOCKED overlapping recheck behavior (no exactly-once claim)', () => {
    it('4. two concurrent batch runs recheck the same due BLOCKED row: convergence is safe, exactly-once is not required', async () => {
      const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
      await cartRepository.addOrIncrementItem(cartId, productId, 3);
      const row = await compensationRepository.create(
        baseCreateInput({ cartId, productId, customerId, reasonCode: 'PRODUCT_SUSPENDED' }),
      );
      await prisma.cartReservationCompensation.update({
        where: { id: row.id },
        data: { status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT', nextAttemptAt: new Date(Date.now() - 1000) },
      });
      const now = new Date();

      const [first, second] = await Promise.all([
        batchService.runBatch({ now, limit: 200 }),
        batchService.runBatch({ now, limit: 200 }),
      ]);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);

      // Deliberately not asserting on the aggregate unblocked counters
      // (pollution-sensitive in a whole-table scan, same rationale as
      // above) and deliberately NOT asserting exactly-once processing -
      // both runs may legitimately report UNBLOCKED_PENDING for this row
      // (harmless duplicate bookkeeping: neither unblockIfGenerationMatches
      // nor rescheduleBlockedCheckIfGenerationMatches advances generation,
      // so two concurrent reads of the same generation can both satisfy
      // their own WHERE clause). Only the row's own final state matters.

      const updated = await compensationRepository.findById(row.id);
      expect(updated?.status).toBe('PENDING');
      expect(updated?.blockReason).toBeNull();
    });
  });

  it('5. respects the limit parameter across a real candidate set larger than the limit', async () => {
    const rows = [];
    for (let i = 0; i < 3; i += 1) {
      const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
      await cartRepository.addOrIncrementItem(cartId, productId, 1);
      const row = await compensationRepository.create(
        baseCreateInput({ cartId, productId, customerId, reasonCode: 'UNKNOWN_INFRA_FAILURE' }),
      );
      rows.push(row);
    }

    const result = await batchService.runBatch({ now: new Date(), limit: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.candidatesFound).toBe(1);
  });
});
