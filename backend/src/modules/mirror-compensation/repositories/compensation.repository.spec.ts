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
// create/find/arrival/claim primitives (Phase 16A.0-C4.1). Resolution,
// permanent-failure, requeue, blocked-unblock, and uniqueness-constraint
// coverage live in compensation-resolution.repository.spec.ts - split to
// keep both files within the repository's 400-line cap. Matches
// checkout-attempt.repository.spec.ts's established convention: a real
// PrismaService, real seeded rows, no mocking.
describe('CompensationRepository (create/find/arrival/claim)', () => {
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

  it('create writes a PENDING row with generation 0', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));

    expect(row.status).toBe('PENDING');
    expect(row.generation).toBe(0);
    expect(row.attemptCount).toBe(0);
    expect(row.blockedCheckCount).toBe(0);
  });

  it('findUnresolvedByCartAndProduct finds a PENDING/PROCESSING/BLOCKED row but not RESOLVED', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));

    expect(await repository.findUnresolvedByCartAndProduct(cartId, productId)).toMatchObject({ id: row.id });

    await prisma.cartReservationCompensation.update({ where: { id: row.id }, data: { status: 'RESOLVED' } });
    expect(await repository.findUnresolvedByCartAndProduct(cartId, productId)).toBeNull();
  });

  it('advanceGenerationPreservingStatus advances generation and leaves status untouched for PENDING', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));

    const { count } = await repository.advanceGenerationPreservingStatus(row.id, {
      operation: 'RELEASE_MIRROR',
      customerId: null,
      desiredQuantity: null,
      reasonCode: 'CHECKOUT_IN_PROGRESS',
      lastError: 'newer error',
      now: new Date(),
    });

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.generation).toBe(1);
    expect(updated?.status).toBe('PENDING');
    expect(updated?.operation).toBe('RELEASE_MIRROR');
    expect(updated?.customerId).toBeNull();
    expect(updated?.desiredQuantity).toBeNull();
    expect(updated?.reasonCode).toBe('CHECKOUT_IN_PROGRESS');
    expect(updated?.lastError).toBe('newer error');
  });

  it('advanceGenerationPreservingStatus leaves a BLOCKED+ACCOUNTING_UNDERFLOW row BLOCKED', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(
      baseCreateInput({ cartId, productId, customerId, reasonCode: 'ACCOUNTING_UNDERFLOW' }),
    );
    await prisma.cartReservationCompensation.update({ where: { id: row.id }, data: { status: 'BLOCKED' } });

    const { count } = await repository.advanceGenerationPreservingStatus(row.id, {
      operation: 'RESERVE_MIRROR',
      customerId,
      desiredQuantity: 9,
      reasonCode: 'ACCOUNTING_UNDERFLOW',
      lastError: null,
      now: new Date(),
    });

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.status).toBe('BLOCKED');
    expect(updated?.generation).toBe(1);
    expect(updated?.desiredQuantity).toBe(9);
  });

  it('advanceGenerationPreservingStatus matches zero rows once the row is RESOLVED', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));
    await prisma.cartReservationCompensation.update({ where: { id: row.id }, data: { status: 'RESOLVED' } });

    const { count } = await repository.advanceGenerationPreservingStatus(row.id, {
      operation: 'RESERVE_MIRROR',
      customerId,
      desiredQuantity: 5,
      reasonCode: 'UNKNOWN_INFRA_FAILURE',
      lastError: null,
      now: new Date(),
    });

    expect(count).toBe(0);
  });

  it('advanceGenerationAndUnblock moves BLOCKED to PENDING while advancing generation', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(
      baseCreateInput({ cartId, productId, customerId, reasonCode: 'ACCOUNTING_UNDERFLOW' }),
    );
    await prisma.cartReservationCompensation.update({ where: { id: row.id }, data: { status: 'BLOCKED' } });

    const { count } = await repository.advanceGenerationAndUnblock(row.id, {
      operation: 'RELEASE_MIRROR',
      customerId: null,
      desiredQuantity: null,
      reasonCode: 'UNKNOWN_INFRA_FAILURE',
      lastError: null,
      now: new Date(),
    });

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.status).toBe('PENDING');
    expect(updated?.generation).toBe(1);
    expect(updated?.operation).toBe('RELEASE_MIRROR');
    expect(updated?.customerId).toBeNull();
    expect(updated?.desiredQuantity).toBeNull();
    expect(updated?.reasonCode).toBe('UNKNOWN_INFRA_FAILURE');
  });

  it('advanceGenerationAndUnblock matches zero rows when the row is not BLOCKED', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));

    const { count } = await repository.advanceGenerationAndUnblock(row.id, {
      operation: 'RESERVE_MIRROR',
      customerId,
      desiredQuantity: 5,
      reasonCode: 'UNKNOWN_INFRA_FAILURE',
      lastError: null,
      now: new Date(),
    });

    expect(count).toBe(0);
  });

  it('claimForRecoveryAttempt claims a due PENDING row and increments attemptCount', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));

    const { count } = await repository.claimForRecoveryAttempt(row.id, new Date());

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.status).toBe('PROCESSING');
    expect(updated?.attemptCount).toBe(1);
  });

  it('claimForRecoveryAttempt does not claim a PENDING row whose nextAttemptAt is in the future', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));
    await prisma.cartReservationCompensation.update({
      where: { id: row.id },
      data: { nextAttemptAt: new Date(Date.now() + 60_000) },
    });

    const { count } = await repository.claimForRecoveryAttempt(row.id, new Date());

    expect(count).toBe(0);
  });

  it('claimForRecoveryAttempt reclaims a stale PROCESSING row and consumes a real attempt', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));
    await prisma.cartReservationCompensation.update({
      where: { id: row.id },
      data: { status: 'PROCESSING', attemptCount: 1, lastAttemptAt: new Date(Date.now() - 6 * 60 * 1000) },
    });

    const { count } = await repository.claimForRecoveryAttempt(row.id, new Date());

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.status).toBe('PROCESSING');
    expect(updated?.attemptCount).toBe(2);
  });

  it('claimForRecoveryAttempt does not reclaim a fresh (non-stale) PROCESSING row', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));
    await prisma.cartReservationCompensation.update({
      where: { id: row.id },
      data: { status: 'PROCESSING', attemptCount: 1, lastAttemptAt: new Date() },
    });

    const { count } = await repository.claimForRecoveryAttempt(row.id, new Date());

    expect(count).toBe(0);
  });

  // findBatchCandidateIds queries the whole table (no cartId/productId
  // scope, unlike every other method in this file) - every assertion below
  // filters the result down to this test's own known ids before checking
  // membership/order, so it stays correct even if other concurrently
  // running spec files have their own due rows sitting in the same shared
  // table.
  describe('findBatchCandidateIds', () => {
    const LARGE_LIMIT = 10_000;

    // Regression guard for a real bug found while implementing this
    // method: these columns are Postgres `timestamp without time zone`,
    // and this database session runs in a non-UTC timezone (confirmed:
    // America/New_York). Binding the boundary parameter as a native JS
    // Date object (rather than an ISO string explicitly cast to
    // ::timestamp) makes Prisma send it as a typed timestamptz value,
    // which Postgres then silently shifts by the session's UTC offset
    // when compared against the naive column - reproduced directly via
    // `NOW() <= <same-instant naive column value>` evaluating false. A
    // row due "now" (created moments ago, the single most common due-row
    // shape in production) is exactly the case this previously broke: it
    // was invisible to the query even though it was genuinely due. If
    // findBatchCandidateIds's ::timestamp cast is ever removed or a Date
    // object is passed directly again, this test fails.
    it('regression: finds a row due "now" (created moments ago) - the exact shape the timezone/binding bug hid', async () => {
      const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
      const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));

      const rows = await repository.findBatchCandidateIds(new Date(), LARGE_LIMIT);

      expect(rows.map((r) => r.id)).toContain(row.id);
    });

    it('includes a due PENDING row and excludes a not-yet-due PENDING row', async () => {
      const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
      const due = await repository.create(baseCreateInput({ cartId, productId, customerId }));
      const other = await seedCartAndProduct(fixture);
      const notDue = await repository.create(baseCreateInput(other));
      await prisma.cartReservationCompensation.update({
        where: { id: notDue.id },
        data: { nextAttemptAt: new Date(Date.now() + 60_000) },
      });

      const rows = await repository.findBatchCandidateIds(new Date(), LARGE_LIMIT);
      const ids = rows.map((r) => r.id);

      expect(ids).toContain(due.id);
      expect(ids).not.toContain(notDue.id);
    });

    it('includes a stale PROCESSING row and excludes a fresh PROCESSING row', async () => {
      const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
      const stale = await repository.create(baseCreateInput({ cartId, productId, customerId }));
      await prisma.cartReservationCompensation.update({
        where: { id: stale.id },
        data: { status: 'PROCESSING', lastAttemptAt: new Date(Date.now() - 6 * 60 * 1000) },
      });
      const other = await seedCartAndProduct(fixture);
      const fresh = await repository.create(baseCreateInput(other));
      await prisma.cartReservationCompensation.update({
        where: { id: fresh.id },
        data: { status: 'PROCESSING', lastAttemptAt: new Date() },
      });

      const rows = await repository.findBatchCandidateIds(new Date(), LARGE_LIMIT);
      const ids = rows.map((r) => r.id);

      expect(ids).toContain(stale.id);
      expect(ids).not.toContain(fresh.id);
    });

    it('includes a due BLOCKED row and excludes a not-yet-due BLOCKED row', async () => {
      const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
      const due = await repository.create(baseCreateInput({ cartId, productId, customerId }));
      await prisma.cartReservationCompensation.update({
        where: { id: due.id },
        data: { status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT', nextAttemptAt: new Date(Date.now() - 1000) },
      });
      const other = await seedCartAndProduct(fixture);
      const notDue = await repository.create(baseCreateInput(other));
      await prisma.cartReservationCompensation.update({
        where: { id: notDue.id },
        data: {
          status: 'BLOCKED',
          blockReason: 'PRODUCT_SUSPECT',
          nextAttemptAt: new Date(Date.now() + 60_000),
        },
      });

      const rows = await repository.findBatchCandidateIds(new Date(), LARGE_LIMIT);
      const ids = rows.map((r) => r.id);

      expect(ids).toContain(due.id);
      expect(ids).not.toContain(notDue.id);
    });

    it('excludes RESOLVED and PERMANENT_FAILURE rows', async () => {
      const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
      const resolved = await repository.create(baseCreateInput({ cartId, productId, customerId }));
      await prisma.cartReservationCompensation.update({
        where: { id: resolved.id },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      });
      const other = await seedCartAndProduct(fixture);
      const failed = await repository.create(baseCreateInput(other));
      await prisma.cartReservationCompensation.update({
        where: { id: failed.id },
        data: { status: 'PERMANENT_FAILURE', permanentFailureAt: new Date() },
      });

      const rows = await repository.findBatchCandidateIds(new Date(), LARGE_LIMIT);
      const ids = rows.map((r) => r.id);

      expect(ids).not.toContain(resolved.id);
      expect(ids).not.toContain(failed.id);
    });

    it('respects the limit parameter', async () => {
      const rows = await repository.findBatchCandidateIds(new Date(), 1);
      expect(rows.length).toBeLessThanOrEqual(1);
    });

    it('orders by normalized eligibleAt ascending across mixed categories, id ascending as tie-breaker', async () => {
      const now = new Date();

      // A PENDING row due 3 minutes ago (eligibleAt = nextAttemptAt).
      const pending = await seedCartAndProduct(fixture);
      const pendingRow = await repository.create(baseCreateInput(pending));
      await prisma.cartReservationCompensation.update({
        where: { id: pendingRow.id },
        data: { nextAttemptAt: new Date(now.getTime() - 3 * 60 * 1000) },
      });

      // A PROCESSING row whose lastAttemptAt is 10 minutes ago, so its
      // normalized eligibleAt (lastAttemptAt + 5min timeout) is 5 minutes
      // ago - earlier than the PENDING row above, so it must sort first
      // even though its raw lastAttemptAt/nextAttemptAt fields alone would
      // not reveal that ordering.
      const processing = await seedCartAndProduct(fixture);
      const processingRow = await repository.create(baseCreateInput(processing));
      await prisma.cartReservationCompensation.update({
        where: { id: processingRow.id },
        data: { status: 'PROCESSING', lastAttemptAt: new Date(now.getTime() - 10 * 60 * 1000) },
      });

      const rows = await repository.findBatchCandidateIds(now, LARGE_LIMIT);
      const relevantIds = rows.map((r) => r.id).filter((id) => id === pendingRow.id || id === processingRow.id);

      expect(relevantIds).toEqual([processingRow.id, pendingRow.id]);
    });

    it('breaks ties in eligibleAt deterministically by id ascending', async () => {
      const now = new Date();
      const sameNextAttemptAt = new Date(now.getTime() - 1000);

      const a = await seedCartAndProduct(fixture);
      const rowA = await repository.create(baseCreateInput(a));
      const b = await seedCartAndProduct(fixture);
      const rowB = await repository.create(baseCreateInput(b));
      await prisma.cartReservationCompensation.updateMany({
        where: { id: { in: [rowA.id, rowB.id] } },
        data: { nextAttemptAt: sameNextAttemptAt },
      });

      const rows = await repository.findBatchCandidateIds(now, LARGE_LIMIT);
      const relevantIds = rows.map((r) => r.id).filter((id) => id === rowA.id || id === rowB.id);
      const expected = [rowA.id, rowB.id].sort();

      expect(relevantIds).toEqual(expected);
    });
  });
});
