import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { CartMutationBarrierConfigRepository } from '../../cart-mutation-barrier/repositories/cart-mutation-barrier-config.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { ReservationEngineModeConfigRepository } from '../repositories/reservation-engine-mode-config.repository';
import { ReservationEngineModeService } from './reservation-engine-mode.service';
import { ReservationModeFenceCoordinatorService } from './reservation-mode-fence-coordinator.service';

describe('ReservationEngineModeService coordinated lock & fence wiring', () => {
  it('acquires (1380339280, 1) before TRANSITION_LOCK_KEY in one canonical query on EXISTING_PUBLIC_PATH', async () => {
    const executedSql: string[] = [];
    const tx = {
      $executeRaw: jest.fn((strings: TemplateStringsArray) => {
        executedSql.push(strings.join('?'));
        return Promise.resolve(1);
      }),
    };
    const prisma = {
      $transaction: jest.fn((fn: (client: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const repository = {
      findCurrent: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: 'cfg-1',
        revision: 1,
        mode: 'MIRROR',
        updatedById: '00000000-0000-4000-8000-000000000001',
        createdAt: new Date(),
      }),
    } as unknown as ReservationEngineModeConfigRepository;

    const service = new ReservationEngineModeService(
      prisma,
      repository,
      {} as RedisService,
      {} as InventoryReservationsService,
      {} as CartMutationBarrierConfigRepository,
    );

    const result = await service.setMode({
      targetMode: 'MIRROR',
      updatedById: '00000000-0000-4000-8000-000000000001',
    });

    expect(result.ok).toBe(true);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(executedSql[0]).toContain('pg_advisory_xact_lock(1380339280, 1)');
    expect(executedSql[0]).toContain('pg_advisory_xact_lock(hashtext(');
    expect(executedSql[0]!.indexOf('pg_advisory_xact_lock(hashtext(')).toBeLessThan(
      executedSql[0]!.indexOf('pg_advisory_xact_lock(1380339280, 1)'),
    );
  });

  it('delegates setMode, checkModeFenceConsistency, and reconcilePendingTransition when fence coordination is active', async () => {
    const prisma = { reservationFenceTransition: {} } as unknown as PrismaService;
    const realRepo = new ReservationEngineModeConfigRepository(prisma);
    const redis = { eval: jest.fn(), getClient: jest.fn() } as unknown as RedisService;
    const coordinator = {
      shouldCoordinate: jest.fn().mockReturnValue(true),
      executeCoordinatedSetMode: jest.fn().mockResolvedValue({
        ok: true,
        id: 'cfg-2',
        mode: 'MIRROR',
        createdAt: new Date(),
      }),
      checkConsistency: jest.fn().mockResolvedValue(false),
      reconcilePendingTransition: jest.fn().mockResolvedValue({
        ok: true,
        mode: 'DRAINING',
        modeRevision: 3,
        phase: 'DRAINING',
        reconciled: true,
      }),
    } as unknown as ReservationModeFenceCoordinatorService;

    const service = new ReservationEngineModeService(
      prisma,
      realRepo,
      redis,
      {} as InventoryReservationsService,
      {} as CartMutationBarrierConfigRepository,
      coordinator,
    );

    const setResult = await service.setMode({
      targetMode: 'MIRROR',
      updatedById: '00000000-0000-4000-8000-000000000001',
    });
    expect(setResult).toMatchObject({ ok: true, id: 'cfg-2', mode: 'MIRROR' });
    await expect(service.checkModeFenceConsistency()).resolves.toBe(false);
    await expect(service.reconcilePendingTransition()).resolves.toEqual({
      ok: true,
      mode: 'DRAINING',
      modeRevision: 3,
      phase: 'DRAINING',
      reconciled: true,
    });
  });

  it('returns true for checkModeFenceConsistency when fence coordination is inactive (unit / uncoordinated repo)', async () => {
    const service = new ReservationEngineModeService(
      {} as PrismaService,
      {} as ReservationEngineModeConfigRepository,
      {} as RedisService,
      {} as InventoryReservationsService,
      {} as CartMutationBarrierConfigRepository,
    );

    await expect(service.checkModeFenceConsistency()).resolves.toBe(true);
  });
});
