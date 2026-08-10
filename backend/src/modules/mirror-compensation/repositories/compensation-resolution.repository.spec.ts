import { PrismaService } from '../../../database/prisma.service';
import { CompensationRepository } from './compensation.repository';
import {
  CompensationTestFixture,
  baseCreateInput,
  seedCartAndProduct,
  setUpCompensationFixture,
  tearDownCompensationFixture,
} from './compensation-repository-test-helpers';

// Real-Postgres integration coverage for CompensationRepository's
// resolution, permanent-failure, requeue, blocked-unblock, and
// uniqueness-constraint primitives (Phase 16A.0-C4.1). Create/find/
// arrival/claim coverage lives in compensation.repository.spec.ts - split
// to keep both files within the repository's 400-line cap.
describe('CompensationRepository (resolve/permanent-failure/requeue/blocked/uniqueness)', () => {
  let prisma: PrismaService;
  let repository: CompensationRepository;
  let fixture: CompensationTestFixture;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new CompensationRepository(prisma);
    fixture = await setUpCompensationFixture(prisma);
  });

  afterAll(async () => {
    await tearDownCompensationFixture(fixture);
    await prisma.onModuleDestroy();
  });

  it('resolveIfGenerationMatches marks RESOLVED when generation matches', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));
    await repository.claimForRecoveryAttempt(row.id, new Date());

    const { count } = await repository.resolveIfGenerationMatches(row.id, 0, new Date());

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.status).toBe('RESOLVED');
    expect(updated?.resolvedAt).not.toBeNull();
  });

  it('resolveIfGenerationMatches matches zero rows when generation differs', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));
    await repository.claimForRecoveryAttempt(row.id, new Date());

    const { count } = await repository.resolveIfGenerationMatches(row.id, 99, new Date());

    expect(count).toBe(0);
    expect((await repository.findById(row.id))?.status).toBe('PROCESSING');
  });

  it('markPermanentFailureIfGenerationMatches marks PERMANENT_FAILURE when generation matches', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));
    await repository.claimForRecoveryAttempt(row.id, new Date());

    const { count } = await repository.markPermanentFailureIfGenerationMatches(row.id, 0, new Date());

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.status).toBe('PERMANENT_FAILURE');
    expect(updated?.permanentFailureAt).not.toBeNull();
  });

  it('markPermanentFailureIfGenerationMatches matches zero rows when generation differs', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));
    await repository.claimForRecoveryAttempt(row.id, new Date());

    const { count } = await repository.markPermanentFailureIfGenerationMatches(row.id, 99, new Date());

    expect(count).toBe(0);
  });

  it('requeueAfterAttemptIfGenerationMatches moves PROCESSING back to PENDING, persists the latest diagnostic, without touching attemptCount', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));
    await repository.claimForRecoveryAttempt(row.id, new Date());
    const nextAttemptAt = new Date(Date.now() + 30_000);

    const { count } = await repository.requeueAfterAttemptIfGenerationMatches(row.id, 0, {
      reasonCode: 'CHECKOUT_IN_PROGRESS',
      lastError: 'checkout still in progress',
      nextAttemptAt,
    });

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.status).toBe('PENDING');
    expect(updated?.attemptCount).toBe(1);
    expect(updated?.reasonCode).toBe('CHECKOUT_IN_PROGRESS');
    expect(updated?.lastError).toBe('checkout still in progress');
    expect(updated?.nextAttemptAt.getTime()).toBe(nextAttemptAt.getTime());
  });

  it('requeueAfterAttemptIfGenerationMatches matches zero rows when generation differs (newer divergence superseded this attempt)', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));
    await repository.claimForRecoveryAttempt(row.id, new Date());

    const { count } = await repository.requeueAfterAttemptIfGenerationMatches(row.id, 99, {
      reasonCode: 'UNKNOWN_INFRA_FAILURE',
      lastError: null,
      nextAttemptAt: new Date(),
    });

    expect(count).toBe(0);
    expect((await repository.findById(row.id))?.status).toBe('PROCESSING');
  });

  it('releaseStaleClaim moves PROCESSING back to PENDING without touching generation, reasonCode, or lastError', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(
      baseCreateInput({ cartId, productId, customerId, reasonCode: 'UNKNOWN_INFRA_FAILURE', lastError: null }),
    );
    await repository.claimForRecoveryAttempt(row.id, new Date());
    // Simulate a concurrent divergence arrival advancing generation while
    // still PROCESSING (advanceGenerationPreservingStatus never touches
    // status) - the exact scenario releaseStaleClaim exists for.
    await repository.advanceGenerationPreservingStatus(row.id, {
      operation: 'RESERVE_MIRROR',
      customerId,
      desiredQuantity: 9,
      reasonCode: 'PRODUCT_SUSPENDED',
      lastError: 'newer arrival diagnostic',
      now: new Date(),
    });
    const nextAttemptAt = new Date();

    const { count } = await repository.releaseStaleClaim(row.id, nextAttemptAt);

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.status).toBe('PENDING');
    expect(updated?.generation).toBe(1);
    expect(updated?.reasonCode).toBe('PRODUCT_SUSPENDED');
    expect(updated?.lastError).toBe('newer arrival diagnostic');
    expect(updated?.nextAttemptAt.getTime()).toBe(nextAttemptAt.getTime());
  });

  it('unblockIfGenerationMatches moves BLOCKED to PENDING, clears blockReason, without touching blockedCheckCount', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(
      baseCreateInput({ cartId, productId, customerId, reasonCode: 'ACCOUNTING_UNDERFLOW' }),
    );
    await prisma.cartReservationCompensation.update({
      where: { id: row.id },
      data: { status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT', blockedCheckCount: 3 },
    });

    const { count } = await repository.unblockIfGenerationMatches(row.id, 0, new Date());

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.status).toBe('PENDING');
    expect(updated?.blockReason).toBeNull();
    expect(updated?.blockedCheckCount).toBe(3);
  });

  it('unblockIfGenerationMatches matches zero rows when generation differs (stale check)', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(
      baseCreateInput({ cartId, productId, customerId, reasonCode: 'ACCOUNTING_UNDERFLOW' }),
    );
    await prisma.cartReservationCompensation.update({ where: { id: row.id }, data: { status: 'BLOCKED' } });

    const { count } = await repository.unblockIfGenerationMatches(row.id, 99, new Date());

    expect(count).toBe(0);
    expect((await repository.findById(row.id))?.status).toBe('BLOCKED');
  });

  it('rescheduleBlockedCheckIfGenerationMatches increments blockedCheckCount, never attemptCount', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(
      baseCreateInput({ cartId, productId, customerId, reasonCode: 'ACCOUNTING_UNDERFLOW' }),
    );
    await prisma.cartReservationCompensation.update({ where: { id: row.id }, data: { status: 'BLOCKED' } });
    const nextAttemptAt = new Date(Date.now() + 60_000);

    const { count } = await repository.rescheduleBlockedCheckIfGenerationMatches(row.id, 0, nextAttemptAt);

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.status).toBe('BLOCKED');
    expect(updated?.blockedCheckCount).toBe(1);
    expect(updated?.attemptCount).toBe(0);
    expect(updated?.nextAttemptAt.getTime()).toBe(nextAttemptAt.getTime());
  });

  it('rescheduleBlockedCheckIfGenerationMatches matches zero rows when generation differs', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(
      baseCreateInput({ cartId, productId, customerId, reasonCode: 'ACCOUNTING_UNDERFLOW' }),
    );
    await prisma.cartReservationCompensation.update({ where: { id: row.id }, data: { status: 'BLOCKED' } });

    const { count } = await repository.rescheduleBlockedCheckIfGenerationMatches(
      row.id,
      99,
      new Date(Date.now() + 60_000),
    );

    expect(count).toBe(0);
  });

  it('only one unresolved row may exist per (cartId, productId) - partial unique index enforced', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    await repository.create(baseCreateInput({ cartId, productId, customerId }));

    await expect(repository.create(baseCreateInput({ cartId, productId, customerId }))).rejects.toThrow();
  });

  it('a RESOLVED historical row does not block a fresh unresolved row for the same pair', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const first = await repository.create(baseCreateInput({ cartId, productId, customerId }));
    await prisma.cartReservationCompensation.update({ where: { id: first.id }, data: { status: 'RESOLVED' } });

    const second = await repository.create(baseCreateInput({ cartId, productId, customerId }));

    expect(second.id).not.toBe(first.id);
  });

  it('blockIfGenerationMatches moves PROCESSING to BLOCKED, sets blockReason and reasonCode, leaves generation/attemptCount/blockedCheckCount/operation/customerId/desiredQuantity untouched', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(
      baseCreateInput({ cartId, productId, customerId, desiredQuantity: 5, reasonCode: 'UNKNOWN_INFRA_FAILURE' }),
    );
    await repository.claimForRecoveryAttempt(row.id, new Date());
    const nextAttemptAt = new Date(Date.now() + 60_000);

    const { count } = await repository.blockIfGenerationMatches(row.id, 0, {
      blockReason: 'PRODUCT_SUSPECT',
      reasonCode: 'ACCOUNTING_UNDERFLOW',
      lastError: 'accounting underflow detected during recovery',
      nextAttemptAt,
    });

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.status).toBe('BLOCKED');
    expect(updated?.blockReason).toBe('PRODUCT_SUSPECT');
    expect(updated?.reasonCode).toBe('ACCOUNTING_UNDERFLOW');
    expect(updated?.lastError).toBe('accounting underflow detected during recovery');
    expect(updated?.nextAttemptAt.getTime()).toBe(nextAttemptAt.getTime());
    expect(updated?.generation).toBe(0);
    expect(updated?.attemptCount).toBe(1);
    expect(updated?.blockedCheckCount).toBe(0);
    expect(updated?.operation).toBe('RESERVE_MIRROR');
    expect(updated?.customerId).toBe(customerId);
    expect(updated?.desiredQuantity).toBe(5);
  });

  it('blockIfGenerationMatches with no reasonCode (mode-blocked) leaves the existing diagnostic reasonCode untouched', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(
      baseCreateInput({ cartId, productId, customerId, reasonCode: 'UNKNOWN_INFRA_FAILURE' }),
    );
    await repository.claimForRecoveryAttempt(row.id, new Date());

    const { count } = await repository.blockIfGenerationMatches(row.id, 0, {
      blockReason: 'MODE_NOT_ADMITTING',
      lastError: null,
      nextAttemptAt: new Date(),
    });

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.status).toBe('BLOCKED');
    expect(updated?.blockReason).toBe('MODE_NOT_ADMITTING');
    expect(updated?.reasonCode).toBe('UNKNOWN_INFRA_FAILURE');
  });

  it('blockIfGenerationMatches matches zero rows when generation differs', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));
    await repository.claimForRecoveryAttempt(row.id, new Date());

    const { count } = await repository.blockIfGenerationMatches(row.id, 99, {
      blockReason: 'PRODUCT_SUSPECT',
      reasonCode: 'PRODUCT_SUSPENDED',
      lastError: null,
      nextAttemptAt: new Date(),
    });

    expect(count).toBe(0);
    expect((await repository.findById(row.id))?.status).toBe('PROCESSING');
  });

  it('the partial unique index exists with the exact unresolved-status predicate', async () => {
    const rows = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'one_unresolved_compensation_per_cart_product'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain('WHERE');
    expect(rows[0]!.indexdef).toContain('PENDING');
    expect(rows[0]!.indexdef).toContain('PROCESSING');
    expect(rows[0]!.indexdef).toContain('BLOCKED');
  });
});
