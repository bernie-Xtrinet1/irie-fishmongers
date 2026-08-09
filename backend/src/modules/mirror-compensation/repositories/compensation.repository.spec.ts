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
      reasonCode: 'CHECKOUT_IN_PROGRESS',
      lastError: 'newer error',
      now: new Date(),
    });

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.generation).toBe(1);
    expect(updated?.status).toBe('PENDING');
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
      reasonCode: 'ACCOUNTING_UNDERFLOW',
      lastError: null,
      now: new Date(),
    });

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.status).toBe('BLOCKED');
    expect(updated?.generation).toBe(1);
  });

  it('advanceGenerationPreservingStatus matches zero rows once the row is RESOLVED', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));
    await prisma.cartReservationCompensation.update({ where: { id: row.id }, data: { status: 'RESOLVED' } });

    const { count } = await repository.advanceGenerationPreservingStatus(row.id, {
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
      reasonCode: 'UNKNOWN_INFRA_FAILURE',
      lastError: null,
      now: new Date(),
    });

    expect(count).toBe(1);
    const updated = await repository.findById(row.id);
    expect(updated?.status).toBe('PENDING');
    expect(updated?.generation).toBe(1);
    expect(updated?.reasonCode).toBe('UNKNOWN_INFRA_FAILURE');
  });

  it('advanceGenerationAndUnblock matches zero rows when the row is not BLOCKED', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const row = await repository.create(baseCreateInput({ cartId, productId, customerId }));

    const { count } = await repository.advanceGenerationAndUnblock(row.id, {
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
});
