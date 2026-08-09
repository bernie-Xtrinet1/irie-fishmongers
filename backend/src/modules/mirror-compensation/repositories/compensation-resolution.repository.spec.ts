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

  it('requeueAfterAttempt moves PROCESSING back to PENDING without touching attemptCount', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));
    await repository.claimForRecoveryAttempt(row.id, new Date());
    const nextAttemptAt = new Date(Date.now() + 30_000);

    const { count } = await repository.requeueAfterAttempt(row.id, nextAttemptAt);

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.status).toBe('PENDING');
    expect(updated?.attemptCount).toBe(1);
    expect(updated?.nextAttemptAt.getTime()).toBe(nextAttemptAt.getTime());
  });

  it('unblockIfGenerationMatches moves BLOCKED to PENDING without touching blockedCheckCount', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(
      baseCreateInput({ cartId, productId, customerId, reasonCode: 'ACCOUNTING_UNDERFLOW' }),
    );
    await prisma.cartReservationCompensation.update({
      where: { id: row.id },
      data: { status: 'BLOCKED', blockedCheckCount: 3 },
    });

    const { count } = await repository.unblockIfGenerationMatches(row.id, 0, new Date());

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.status).toBe('PENDING');
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
