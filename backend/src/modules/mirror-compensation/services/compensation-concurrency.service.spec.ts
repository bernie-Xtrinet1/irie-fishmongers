import { PrismaService } from '../../../database/prisma.service';
import {
  CompensationTestFixture,
  seedCartAndProduct,
  setUpCompensationFixture,
  tearDownCompensationFixture,
} from '../repositories/compensation-repository-test-helpers';
import { CompensationRepository } from '../repositories/compensation.repository';
import { CompensationService } from './compensation.service';
import { RecordMirrorDivergenceInput } from '../types/compensation-service.types';

// Real-Postgres concurrency/race coverage for CompensationService (Phase
// 16A.0-C4.2). The unit suite mocks CompensationRepository entirely and
// can only verify routing logic; it cannot prove the partial unique
// index, generation-advance arithmetic, or genuine concurrent-write
// behavior against real Postgres. Matches compensation.repository.spec.ts's
// established convention: a real PrismaService, real seeded rows, no
// mocking. Corruption-case coverage (deliberately bypassing the partial
// index) is intentionally NOT included here - see the C4.2 review report
// for why.
describe('CompensationService (real Postgres concurrency)', () => {
  let prisma: PrismaService;
  let repository: CompensationRepository;
  let service: CompensationService;
  let fixture: CompensationTestFixture;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new CompensationRepository(prisma);
    service = new CompensationService(repository);
    fixture = await setUpCompensationFixture(prisma);
  });

  afterAll(async () => {
    await tearDownCompensationFixture(fixture);
    await prisma.onModuleDestroy();
  });

  function baseInput(overrides: Partial<RecordMirrorDivergenceInput> = {}): RecordMirrorDivergenceInput {
    return {
      operation: overrides.operation ?? 'RESERVE_MIRROR',
      cartId: overrides.cartId!,
      productId: overrides.productId!,
      customerId: overrides.customerId ?? null,
      desiredQuantity: overrides.desiredQuantity ?? 5,
      reasonCode: overrides.reasonCode ?? 'UNKNOWN_INFRA_FAILURE',
      lastError: overrides.lastError ?? null,
      now: overrides.now ?? new Date(),
    };
  }

  it('the partial unique index prevents two unresolved rows for the same pair', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);

    const first = await service.recordMirrorDivergence(baseInput({ cartId, productId, customerId }));
    const second = await service.recordMirrorDivergence(baseInput({ cartId, productId, customerId }));

    expect(first).toMatchObject({ ok: true, outcome: 'CREATED' });
    expect(second).toMatchObject({ ok: true, outcome: 'GENERATION_ADVANCED' });

    const unresolvedRows = await prisma.cartReservationCompensation.findMany({
      where: { cartId, productId, status: { in: ['PENDING', 'PROCESSING', 'BLOCKED'] } },
    });
    expect(unresolvedRows).toHaveLength(1);
    expect(unresolvedRows[0]!.generation).toBe(1);
  });

  it('two historical RESOLVED rows may coexist for the same pair, untouched by a new arrival', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const first = await repository.create({
      operation: 'RESERVE_MIRROR',
      cartId,
      productId,
      customerId,
      desiredQuantity: 5,
      reasonCode: 'UNKNOWN_INFRA_FAILURE',
      lastError: null,
    });
    await prisma.cartReservationCompensation.update({ where: { id: first.id }, data: { status: 'RESOLVED' } });

    const result = await service.recordMirrorDivergence(baseInput({ cartId, productId, customerId }));

    expect(result).toMatchObject({ ok: true, outcome: 'CREATED' });
    const untouchedFirst = await prisma.cartReservationCompensation.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(untouchedFirst.status).toBe('RESOLVED');
    expect(untouchedFirst.generation).toBe(0);
  });

  it('resolve-between-read-and-update: the service retries and creates a new row, the historical row is untouched', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const existing = await repository.create({
      operation: 'RESERVE_MIRROR',
      cartId,
      productId,
      customerId,
      desiredQuantity: 5,
      reasonCode: 'UNKNOWN_INFRA_FAILURE',
      lastError: null,
    });

    // Simulate "the row resolved between the service's read and its own
    // conditional update" by making the mocked findUnresolvedByCartAndProduct
    // call resolve the row as a side effect, immediately after returning
    // the (now-stale) value the service will act on next.
    const findSpy = jest
      .spyOn(repository, 'findUnresolvedByCartAndProduct')
      .mockImplementationOnce(async (...args) => {
        const real = await CompensationRepository.prototype.findUnresolvedByCartAndProduct.apply(
          repository,
          args,
        );
        await prisma.cartReservationCompensation.update({
          where: { id: existing.id },
          data: { status: 'RESOLVED', resolvedAt: new Date() },
        });
        return real;
      });

    const result = await service.recordMirrorDivergence(baseInput({ cartId, productId, customerId }));

    expect(result).toMatchObject({ ok: true, outcome: 'CREATED' });
    if (result.ok) {
      expect(result.compensationId).not.toBe(existing.id);
    }

    const untouchedExisting = await prisma.cartReservationCompensation.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(untouchedExisting.status).toBe('RESOLVED');

    findSpy.mockRestore();
  });

  it('concurrent duplicate arrivals: exactly one unresolved row survives, generation advances once per accepted arrival', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    await repository.create({
      operation: 'RESERVE_MIRROR',
      cartId,
      productId,
      customerId,
      desiredQuantity: 5,
      reasonCode: 'UNKNOWN_INFRA_FAILURE',
      lastError: null,
    });

    const [resultA, resultB] = await Promise.all([
      service.recordMirrorDivergence(
        baseInput({ cartId, productId, customerId, reasonCode: 'CHECKOUT_IN_PROGRESS', lastError: 'first' }),
      ),
      service.recordMirrorDivergence(
        baseInput({ cartId, productId, customerId, reasonCode: 'PRODUCT_SUSPENDED', lastError: 'second' }),
      ),
    ]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);

    const unresolvedRows = await prisma.cartReservationCompensation.findMany({
      where: { cartId, productId, status: { in: ['PENDING', 'PROCESSING', 'BLOCKED'] } },
    });
    expect(unresolvedRows).toHaveLength(1);
    expect(unresolvedRows[0]!.generation).toBe(2);
    expect(['first', 'second']).toContain(unresolvedRows[0]!.lastError);
  });

  it('a PROCESSING duplicate arrival advances generation but preserves PROCESSING', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const existing = await repository.create({
      operation: 'RESERVE_MIRROR',
      cartId,
      productId,
      customerId,
      desiredQuantity: 5,
      reasonCode: 'UNKNOWN_INFRA_FAILURE',
      lastError: null,
    });
    await prisma.cartReservationCompensation.update({
      where: { id: existing.id },
      data: { status: 'PROCESSING' },
    });

    const result = await service.recordMirrorDivergence(baseInput({ cartId, productId, customerId }));

    expect(result).toEqual({ ok: true, outcome: 'GENERATION_ADVANCED', compensationId: existing.id });
    const updated = await prisma.cartReservationCompensation.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.status).toBe('PROCESSING');
    expect(updated.generation).toBe(1);
  });

  it('BLOCKED + ACCOUNTING_UNDERFLOW arrival stays BLOCKED', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const existing = await repository.create({
      operation: 'RESERVE_MIRROR',
      cartId,
      productId,
      customerId,
      desiredQuantity: 5,
      reasonCode: 'ACCOUNTING_UNDERFLOW',
      lastError: null,
    });
    await prisma.cartReservationCompensation.update({ where: { id: existing.id }, data: { status: 'BLOCKED' } });

    const result = await service.recordMirrorDivergence(
      baseInput({ cartId, productId, customerId, reasonCode: 'ACCOUNTING_UNDERFLOW' }),
    );

    expect(result).toEqual({ ok: true, outcome: 'GENERATION_ADVANCED', compensationId: existing.id });
    const updated = await prisma.cartReservationCompensation.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.status).toBe('BLOCKED');
  });

  it('BLOCKED + ordinary reason arrival becomes PENDING', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const existing = await repository.create({
      operation: 'RESERVE_MIRROR',
      cartId,
      productId,
      customerId,
      desiredQuantity: 5,
      reasonCode: 'ACCOUNTING_UNDERFLOW',
      lastError: null,
    });
    await prisma.cartReservationCompensation.update({ where: { id: existing.id }, data: { status: 'BLOCKED' } });

    const result = await service.recordMirrorDivergence(
      baseInput({ cartId, productId, customerId, reasonCode: 'UNKNOWN_INFRA_FAILURE' }),
    );

    expect(result).toEqual({ ok: true, outcome: 'GENERATION_ADVANCED', compensationId: existing.id });
    const updated = await prisma.cartReservationCompensation.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.status).toBe('PENDING');
  });

  it('attemptCount and blockedCheckCount are unchanged by a divergence arrival', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);
    const existing = await repository.create({
      operation: 'RESERVE_MIRROR',
      cartId,
      productId,
      customerId,
      desiredQuantity: 5,
      reasonCode: 'UNKNOWN_INFRA_FAILURE',
      lastError: null,
    });
    await repository.claimForRecoveryAttempt(existing.id, new Date());

    const result = await service.recordMirrorDivergence(baseInput({ cartId, productId, customerId }));

    expect(result).toEqual({ ok: true, outcome: 'GENERATION_ADVANCED', compensationId: existing.id });
    const updated = await prisma.cartReservationCompensation.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.attemptCount).toBe(1);
    expect(updated.blockedCheckCount).toBe(0);
  });
});
