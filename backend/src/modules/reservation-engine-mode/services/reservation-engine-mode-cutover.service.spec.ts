import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import { CartMutationBarrierConfigRepository } from '../../cart-mutation-barrier/repositories/cart-mutation-barrier-config.repository';
import { ReservationEngineModeConfigRepository } from '../repositories/reservation-engine-mode-config.repository';
import { CutoverAttestation } from '../types/reservation-engine-mode.types';
import { CUTOVER_TRANSITION_TX_TIMEOUT_MS, ReservationEngineModeService } from './reservation-engine-mode.service';

// CART_SCOPED activation-boundary gate (see the gate design review's final,
// approved atomic-freshness design). Mocked unit coverage for setMode's
// new MIRROR -> CART_SCOPED cutover branch, split from
// reservation-engine-mode.service.spec.ts purely to keep both files within
// the repository's 400-line limit. Real-Postgres/Redis proof of the same
// branch (barrier-revision race, backlog draining, freshness boundary)
// lives in cart-scoped-cutover.postgres.integration.spec.ts.
describe('ReservationEngineModeService.setMode CART_SCOPED cutover branch', () => {
  let repository: jest.Mocked<Pick<ReservationEngineModeConfigRepository, 'findCurrent' | 'create'>>;
  let mutationBarrierRepository: jest.Mocked<Pick<CartMutationBarrierConfigRepository, 'findCurrent'>>;
  let tx: {
    $executeRaw: jest.Mock;
    cartReservationSyncState: { count: jest.Mock };
    cartReservationCompensation: { count: jest.Mock };
    cartItem: { count: jest.Mock };
  };
  let prisma: jest.Mocked<Pick<PrismaService, '$transaction'>>;
  let service: ReservationEngineModeService;

  const updatedById = 'admin-1';
  const now = Date.now();

  function buildAttestation(overrides: Partial<CutoverAttestation> = {}): CutoverAttestation {
    return {
      barrierRevision: 5,
      targetCount: 3,
      minimumExpiresAt: now + 900_000,
      completedAt: now,
      ...overrides,
    };
  }

  beforeEach(() => {
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      cartReservationSyncState: { count: jest.fn().mockResolvedValue(0) },
      cartReservationCompensation: { count: jest.fn().mockResolvedValue(0) },
      cartItem: { count: jest.fn().mockResolvedValue(3) },
    };
    prisma = { $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)) } as never;
    repository = {
      findCurrent: jest.fn().mockResolvedValue({ id: 'cfg-1', mode: 'MIRROR', revision: 1, createdAt: new Date() }),
      create: jest.fn().mockResolvedValue({ id: 'cfg-2', mode: 'CART_SCOPED', createdAt: new Date() }),
    };
    mutationBarrierRepository = {
      findCurrent: jest.fn().mockResolvedValue({ id: 'barrier-1', active: true, revision: 5, createdAt: new Date() }),
    };
    service = new ReservationEngineModeService(
      prisma as unknown as PrismaService,
      repository as unknown as ReservationEngineModeConfigRepository,
      {} as unknown as RedisService,
      {} as unknown as InventoryReservationsService,
      mutationBarrierRepository as unknown as CartMutationBarrierConfigRepository,
    );
  });

  it('passes CUTOVER_TRANSITION_TX_TIMEOUT_MS explicitly as the transaction timeout', async () => {
    await service.setMode({ targetMode: 'CART_SCOPED', updatedById, cutoverAttestation: buildAttestation() });

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: CUTOVER_TRANSITION_TX_TIMEOUT_MS });
  });

  it('accepts and creates the CART_SCOPED row when every precondition passes', async () => {
    const result = await service.setMode({ targetMode: 'CART_SCOPED', updatedById, cutoverAttestation: buildAttestation() });

    expect(result).toMatchObject({ ok: true, mode: 'CART_SCOPED' });
    expect(repository.create).toHaveBeenCalledWith({ mode: 'CART_SCOPED', updatedById }, tx);
  });

  it('rejects with CUTOVER_ATTESTATION_REQUIRED when no attestation is supplied', async () => {
    const result = await service.setMode({ targetMode: 'CART_SCOPED', updatedById });

    expect(result).toEqual({ ok: false, code: 'CUTOVER_ATTESTATION_REQUIRED' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rejects with CUTOVER_BARRIER_REVISION_MISMATCH when the barrier is not active', async () => {
    mutationBarrierRepository.findCurrent.mockResolvedValue({
      id: 'barrier-1',
      active: false,
      revision: 5,
      createdAt: new Date(),
    } as never);

    const result = await service.setMode({ targetMode: 'CART_SCOPED', updatedById, cutoverAttestation: buildAttestation() });

    expect(result).toEqual({ ok: false, code: 'CUTOVER_BARRIER_REVISION_MISMATCH' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rejects with CUTOVER_BARRIER_REVISION_MISMATCH when the current revision differs from the attested one (N vs N+1)', async () => {
    mutationBarrierRepository.findCurrent.mockResolvedValue({
      id: 'barrier-2',
      active: true,
      revision: 6,
      createdAt: new Date(),
    } as never);

    const result = await service.setMode({
      targetMode: 'CART_SCOPED',
      updatedById,
      cutoverAttestation: buildAttestation({ barrierRevision: 5 }),
    });

    expect(result).toEqual({ ok: false, code: 'CUTOVER_BARRIER_REVISION_MISMATCH' });
  });

  it('rejects with CUTOVER_SYNC_BACKLOG when DA.1B unresolved markers remain', async () => {
    tx.cartReservationSyncState.count.mockResolvedValue(2);

    const result = await service.setMode({ targetMode: 'CART_SCOPED', updatedById, cutoverAttestation: buildAttestation() });

    expect(result).toEqual({ ok: false, code: 'CUTOVER_SYNC_BACKLOG', unresolvedCount: 2 });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rejects with CUTOVER_COMPENSATION_BACKLOG when C4 rows remain, including PERMANENT_FAILURE', async () => {
    tx.cartReservationCompensation.count.mockResolvedValue(1);

    const result = await service.setMode({ targetMode: 'CART_SCOPED', updatedById, cutoverAttestation: buildAttestation() });

    expect(result).toEqual({ ok: false, code: 'CUTOVER_COMPENSATION_BACKLOG', unresolvedCount: 1 });
    // The query itself must include PERMANENT_FAILURE in its status filter -
    // zero C4 backlog is necessary but never sufficient on its own (see the
    // gate design review), so this must never be silently narrowed to just
    // the "still working on it" statuses.
    expect(tx.cartReservationCompensation.count).toHaveBeenCalledWith({
      where: { status: { in: ['PENDING', 'PROCESSING', 'BLOCKED', 'PERMANENT_FAILURE'] } },
    });
  });

  it('rejects with CUTOVER_TARGET_COUNT_MISMATCH when the current positive-CartItem count differs from the attestation', async () => {
    tx.cartItem.count.mockResolvedValue(4);

    const result = await service.setMode({
      targetMode: 'CART_SCOPED',
      updatedById,
      cutoverAttestation: buildAttestation({ targetCount: 3 }),
    });

    expect(result).toEqual({ ok: false, code: 'CUTOVER_TARGET_COUNT_MISMATCH', expected: 3, actual: 4 });
  });

  it('rejects with CUTOVER_BACKFILL_STALE when the freshness bound has already been reached', async () => {
    const result = await service.setMode({
      targetMode: 'CART_SCOPED',
      updatedById,
      cutoverAttestation: buildAttestation({ minimumExpiresAt: Date.now() - 1 }),
    });

    expect(result).toEqual({ ok: false, code: 'CUTOVER_BACKFILL_STALE' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('accepts when minimumExpiresAt is comfortably beyond postLockNow + the transaction timeout', async () => {
    const result = await service.setMode({
      targetMode: 'CART_SCOPED',
      updatedById,
      cutoverAttestation: buildAttestation({ minimumExpiresAt: Date.now() + CUTOVER_TRANSITION_TX_TIMEOUT_MS + 60_000 }),
    });

    expect(result).toMatchObject({ ok: true });
  });

  it('never evaluates cutover preconditions for any other transition (e.g. LEGACY -> MIRROR)', async () => {
    repository.findCurrent.mockResolvedValue(null); // implicit LEGACY

    const result = await service.setMode({ targetMode: 'MIRROR', updatedById });

    expect(result).toMatchObject({ ok: true });
    expect(mutationBarrierRepository.findCurrent).not.toHaveBeenCalled();
    expect(tx.cartReservationSyncState.count).not.toHaveBeenCalled();
  });
});
