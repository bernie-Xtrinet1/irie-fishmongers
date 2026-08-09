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

// Real-Postgres coverage for the complete latest-wins diagnostic snapshot
// (Phase 16A.0-C4.2, production correction): since deduplication is by
// (cartId, productId) alone, independent of operation, every accepted new
// divergence must overwrite operation/customerId/desiredQuantity too, not
// only reasonCode/lastError/nextAttemptAt - otherwise the row could end up
// self-contradictory (e.g. operation:'RESERVE_MIRROR' with a since-
// superseded RELEASE_MIRROR's null desiredQuantity). Split from
// compensation-concurrency.service.spec.ts to keep both files within the
// 400-line cap.
describe('CompensationService (latest-wins diagnostic snapshot)', () => {
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
      desiredQuantity: overrides.desiredQuantity ?? null,
      reasonCode: overrides.reasonCode ?? 'UNKNOWN_INFRA_FAILURE',
      lastError: overrides.lastError ?? null,
      now: overrides.now ?? new Date(),
    };
  }

  it('an unresolved RESERVE_MIRROR row becomes RELEASE_MIRROR when a RELEASE_MIRROR divergence arrives', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);

    const first = await service.recordMirrorDivergence(
      baseInput({ cartId, productId, operation: 'RESERVE_MIRROR', customerId, desiredQuantity: 5 }),
    );
    expect(first).toMatchObject({ ok: true, outcome: 'CREATED' });

    const second = await service.recordMirrorDivergence(
      baseInput({ cartId, productId, operation: 'RELEASE_MIRROR', customerId: null, desiredQuantity: null }),
    );
    expect(second).toMatchObject({ ok: true, outcome: 'GENERATION_ADVANCED' });

    const row = await prisma.cartReservationCompensation.findUniqueOrThrow({
      where: { id: (second as { compensationId: string }).compensationId },
    });
    expect(row.operation).toBe('RELEASE_MIRROR');
    expect(row.customerId).toBeNull();
    expect(row.desiredQuantity).toBeNull();
  });

  it('an unresolved RELEASE_MIRROR row becomes RESERVE_MIRROR when a RESERVE_MIRROR divergence arrives, persisting its customerId/desiredQuantity', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);

    const first = await service.recordMirrorDivergence(
      baseInput({ cartId, productId, operation: 'RELEASE_MIRROR', customerId: null, desiredQuantity: null }),
    );
    expect(first).toMatchObject({ ok: true, outcome: 'CREATED' });

    const second = await service.recordMirrorDivergence(
      baseInput({ cartId, productId, operation: 'RESERVE_MIRROR', customerId, desiredQuantity: 7 }),
    );
    expect(second).toMatchObject({ ok: true, outcome: 'GENERATION_ADVANCED' });

    const row = await prisma.cartReservationCompensation.findUniqueOrThrow({
      where: { id: (second as { compensationId: string }).compensationId },
    });
    expect(row.operation).toBe('RESERVE_MIRROR');
    expect(row.customerId).toBe(customerId);
    expect(row.desiredQuantity).toBe(7);
  });

  it('the same operation arriving again with a new desiredQuantity: the latest desiredQuantity wins', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);

    await service.recordMirrorDivergence(
      baseInput({ cartId, productId, operation: 'RESERVE_MIRROR', customerId, desiredQuantity: 3 }),
    );
    const second = await service.recordMirrorDivergence(
      baseInput({ cartId, productId, operation: 'RESERVE_MIRROR', customerId, desiredQuantity: 9 }),
    );

    const row = await prisma.cartReservationCompensation.findUniqueOrThrow({
      where: { id: (second as { compensationId: string }).compensationId },
    });
    expect(row.desiredQuantity).toBe(9);
    expect(row.generation).toBe(1);
  });

  it('the later committed divergence deterministically overwrites the earlier diagnostic snapshot', async () => {
    const { cartId, productId, customerId } = await seedCartAndProduct(fixture);

    await service.recordMirrorDivergence(
      baseInput({
        cartId,
        productId,
        operation: 'RESERVE_MIRROR',
        customerId,
        desiredQuantity: 2,
        reasonCode: 'PRODUCT_SUSPENDED',
        lastError: 'first observed error',
      }),
    );
    const later = await service.recordMirrorDivergence(
      baseInput({
        cartId,
        productId,
        operation: 'RESERVE_MIRROR',
        customerId,
        desiredQuantity: 6,
        reasonCode: 'UNKNOWN_INFRA_FAILURE',
        lastError: 'second, later error',
      }),
    );

    const row = await prisma.cartReservationCompensation.findUniqueOrThrow({
      where: { id: (later as { compensationId: string }).compensationId },
    });
    expect(row.desiredQuantity).toBe(6);
    expect(row.reasonCode).toBe('UNKNOWN_INFRA_FAILURE');
    expect(row.lastError).toBe('second, later error');
    expect(row.generation).toBe(1);
  });
});
