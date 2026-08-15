import { Prisma, ReservationEngineMode, ReservationEngineModeConfig } from '@prisma/client';

import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import { ReservationEngineModeConfigRepository } from '../repositories/reservation-engine-mode-config.repository';
import { ReservationEngineModeService } from './reservation-engine-mode.service';

type ScanReply = [string, string[]];

describe('ReservationEngineModeService', () => {
  let prisma: jest.Mocked<Pick<PrismaService, '$transaction'>>;
  let repository: jest.Mocked<Pick<ReservationEngineModeConfigRepository, 'findCurrent' | 'create'>>;
  let redis: jest.Mocked<Pick<RedisService, 'getClient'>>;
  let inventoryReservations: jest.Mocked<Pick<InventoryReservationsService, 'getActiveReservation'>>;
  let scan: jest.Mock<Promise<ScanReply>, [string, string, string, string, number]>;
  let get: jest.Mock<Promise<string | null>, [string]>;
  let smembers: jest.Mock<Promise<string[]>, [string]>;
  let executeRaw: jest.Mock<Promise<number>, unknown[]>;
  let service: ReservationEngineModeService;

  const now = new Date('2026-08-08T00:00:00.000Z');
  const updatedById = 'admin-1';
  const tx = { $executeRaw: (...args: unknown[]) => executeRaw(...args) } as unknown as Prisma.TransactionClient;

  beforeEach(() => {
    executeRaw = jest.fn<Promise<number>, unknown[]>().mockResolvedValue(0);
    prisma = { $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)) } as never;
    repository = { findCurrent: jest.fn(), create: jest.fn() };
    scan = jest
      .fn<Promise<ScanReply>, [string, string, string, string, number]>()
      .mockResolvedValue(['0', []]);
    get = jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null);
    smembers = jest.fn<Promise<string[]>, [string]>().mockResolvedValue([]);
    redis = { getClient: jest.fn().mockReturnValue({ scan, get, smembers }) };
    inventoryReservations = { getActiveReservation: jest.fn() };
    service = new ReservationEngineModeService(
      prisma as unknown as PrismaService,
      repository as unknown as ReservationEngineModeConfigRepository,
      redis as unknown as RedisService,
      inventoryReservations as unknown as InventoryReservationsService,
    );
  });

  function buildConfig(mode: ReservationEngineMode, revision = 1): ReservationEngineModeConfig {
    return { id: 'config-1', revision, mode, updatedById, createdAt: now };
  }

  function mockActiveReservation() {
    return {
      version: 1,
      quantity: 1,
      cartId: 'cart-1',
      customerId: 'customer-1',
      status: 'ACTIVE' as const,
      createdAt: now.getTime(),
      lastRenewedAt: now.getTime(),
      expiresAt: now.getTime() + 900_000,
      absoluteExpiresAt: now.getTime() + 3_600_000,
      checkoutIdempotencyKey: null,
      checkoutPendingAt: null,
      checkoutPendingExpiresAt: null,
    };
  }

  describe('getCurrentMode', () => {
    it('returns LEGACY when no config row exists yet', async () => {
      repository.findCurrent.mockResolvedValue(null);

      await expect(service.getCurrentMode()).resolves.toBe('LEGACY');
    });

    it("returns the current row's mode when one exists", async () => {
      repository.findCurrent.mockResolvedValue(buildConfig('MIRROR'));

      await expect(service.getCurrentMode()).resolves.toBe('MIRROR');
    });
  });

  describe('setMode - valid transitions', () => {
    it.each<[ReservationEngineMode, ReservationEngineMode]>([
      ['LEGACY', 'MIRROR'],
      ['MIRROR', 'LEGACY'],
      ['MIRROR', 'CART_SCOPED'],
      ['CART_SCOPED', 'DRAINING'],
      ['DRAINING', 'CART_SCOPED'],
    ])('allows %s -> %s', async (from, to) => {
      repository.findCurrent.mockResolvedValue(from === 'LEGACY' ? null : buildConfig(from));
      repository.create.mockResolvedValue(buildConfig(to));

      const result = await service.setMode({ targetMode: to, updatedById });

      expect(result).toEqual({ ok: true, id: 'config-1', mode: to, createdAt: now });
      expect(repository.create).toHaveBeenCalledWith({ mode: to, updatedById }, tx);
      expect(executeRaw).toHaveBeenCalledTimes(1);
    });

    it('allows DRAINING -> LEGACY when the rollback gate is clear', async () => {
      repository.findCurrent.mockResolvedValue(buildConfig('DRAINING'));
      repository.create.mockResolvedValue(buildConfig('LEGACY'));

      const result = await service.setMode({ targetMode: 'LEGACY', updatedById });

      expect(result).toEqual({ ok: true, id: 'config-1', mode: 'LEGACY', createdAt: now });
      expect(repository.create).toHaveBeenCalledWith({ mode: 'LEGACY', updatedById }, tx);
    });
  });

  describe('setMode - invalid transitions', () => {
    it.each<[ReservationEngineMode, ReservationEngineMode]>([
      ['LEGACY', 'LEGACY'],
      ['MIRROR', 'MIRROR'],
      ['CART_SCOPED', 'CART_SCOPED'],
      ['DRAINING', 'DRAINING'],
      ['LEGACY', 'CART_SCOPED'],
      ['LEGACY', 'DRAINING'],
      ['CART_SCOPED', 'LEGACY'],
      ['CART_SCOPED', 'MIRROR'],
      ['DRAINING', 'MIRROR'],
      ['MIRROR', 'DRAINING'],
    ])('rejects %s -> %s without writing', async (from, to) => {
      repository.findCurrent.mockResolvedValue(from === 'LEGACY' ? null : buildConfig(from));

      const result = await service.setMode({ targetMode: to, updatedById });

      expect(result).toEqual({ ok: false, code: 'INVALID_TRANSITION', from, to });
      expect(repository.create).not.toHaveBeenCalled();
    });

    // Case 6: CART_SCOPED -> LEGACY directly (skipping the required DRAINING
    // intermediate) is rejected exactly like any other invalid pair - no
    // special-casing, confirming the state machine has no shortcut around
    // the rollback-pause requirement.
    it('rejects CART_SCOPED -> LEGACY directly, without an intermediate DRAINING state', async () => {
      repository.findCurrent.mockResolvedValue(buildConfig('CART_SCOPED'));

      const result = await service.setMode({ targetMode: 'LEGACY', updatedById });

      expect(result).toEqual({ ok: false, code: 'INVALID_TRANSITION', from: 'CART_SCOPED', to: 'LEGACY' });
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('setMode - DRAINING -> LEGACY rollback gate', () => {
    it('returns ROLLBACK_BLOCKED when a product is outstanding in both signals', async () => {
      repository.findCurrent.mockResolvedValue(buildConfig('DRAINING'));
      scan.mockImplementation((_cursor: string, _match: string, pattern: string) => {
        if (pattern === 'inv:reserved:product-total:{*}') {
          return Promise.resolve(['0', ['inv:reserved:product-total:{product-1}']] as ScanReply);
        }
        if (pattern === 'inv:reserved:cart-index:{*}') {
          return Promise.resolve(['0', ['inv:reserved:cart-index:{cart-1}']] as ScanReply);
        }
        return Promise.resolve(['0', []] as ScanReply);
      });
      get.mockResolvedValue('3');
      smembers.mockResolvedValue(['product-1']);
      inventoryReservations.getActiveReservation.mockResolvedValue(mockActiveReservation());

      const result = await service.setMode({ targetMode: 'LEGACY', updatedById });

      expect(result).toEqual({ ok: false, code: 'ROLLBACK_BLOCKED', outstandingProductIds: ['product-1'] });
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('returns ROLLBACK_STRUCTURE_DRIFT when the total signal disagrees with the index signal', async () => {
      repository.findCurrent.mockResolvedValue(buildConfig('DRAINING'));
      scan.mockImplementation((_cursor: string, _match: string, pattern: string) => {
        if (pattern === 'inv:reserved:product-total:{*}') {
          return Promise.resolve(['0', ['inv:reserved:product-total:{product-1}']] as ScanReply);
        }
        return Promise.resolve(['0', []] as ScanReply);
      });
      get.mockResolvedValue('3');

      const result = await service.setMode({ targetMode: 'LEGACY', updatedById });

      expect(result).toEqual({
        ok: false,
        code: 'ROLLBACK_STRUCTURE_DRIFT',
        structureDriftProductIds: ['product-1'],
      });
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('does not treat a stale index member (no longer live) as blocking', async () => {
      repository.findCurrent.mockResolvedValue(buildConfig('DRAINING'));
      scan.mockImplementation((_cursor: string, _match: string, pattern: string) => {
        if (pattern === 'inv:reserved:cart-index:{*}') {
          return Promise.resolve(['0', ['inv:reserved:cart-index:{cart-1}']] as ScanReply);
        }
        return Promise.resolve(['0', []] as ScanReply);
      });
      smembers.mockResolvedValue(['product-1']);
      inventoryReservations.getActiveReservation.mockResolvedValue(null);
      repository.create.mockResolvedValue(buildConfig('LEGACY'));

      const result = await service.setMode({ targetMode: 'LEGACY', updatedById });

      expect(result).toEqual({ ok: true, id: 'config-1', mode: 'LEGACY', createdAt: now });
    });
  });

  describe('verifyRollbackSafe', () => {
    it('reports clear when both structures are empty', async () => {
      await expect(service.verifyRollbackSafe()).resolves.toEqual({
        clear: true,
        outstandingProductIds: [],
        structureDriftProductIds: [],
      });
    });

    it('reports outstanding when both signals agree a product is held', async () => {
      scan.mockImplementation((_cursor: string, _match: string, pattern: string) => {
        if (pattern === 'inv:reserved:product-total:{*}') {
          return Promise.resolve(['0', ['inv:reserved:product-total:{product-1}']] as ScanReply);
        }
        if (pattern === 'inv:reserved:cart-index:{*}') {
          return Promise.resolve(['0', ['inv:reserved:cart-index:{cart-1}']] as ScanReply);
        }
        return Promise.resolve(['0', []] as ScanReply);
      });
      get.mockResolvedValue('1');
      smembers.mockResolvedValue(['product-1']);
      inventoryReservations.getActiveReservation.mockResolvedValue(mockActiveReservation());

      await expect(service.verifyRollbackSafe()).resolves.toEqual({
        clear: false,
        outstandingProductIds: ['product-1'],
        structureDriftProductIds: [],
      });
    });

    it('reports drift when the total is non-zero but the index shows no live hold', async () => {
      scan.mockImplementation((_cursor: string, _match: string, pattern: string) => {
        if (pattern === 'inv:reserved:product-total:{*}') {
          return Promise.resolve(['0', ['inv:reserved:product-total:{product-1}']] as ScanReply);
        }
        return Promise.resolve(['0', []] as ScanReply);
      });
      get.mockResolvedValue('5');

      await expect(service.verifyRollbackSafe()).resolves.toEqual({
        clear: false,
        outstandingProductIds: [],
        structureDriftProductIds: ['product-1'],
      });
    });

    it('reports drift when the index shows a live hold but the total is zero', async () => {
      scan.mockImplementation((_cursor: string, _match: string, pattern: string) => {
        if (pattern === 'inv:reserved:cart-index:{*}') {
          return Promise.resolve(['0', ['inv:reserved:cart-index:{cart-1}']] as ScanReply);
        }
        return Promise.resolve(['0', []] as ScanReply);
      });
      smembers.mockResolvedValue(['product-1']);
      inventoryReservations.getActiveReservation.mockResolvedValue(mockActiveReservation());

      await expect(service.verifyRollbackSafe()).resolves.toEqual({
        clear: false,
        outstandingProductIds: [],
        structureDriftProductIds: ['product-1'],
      });
    });

    it('checks a product only once across multiple carts holding it, skipping the redundant getActiveReservation lookup', async () => {
      scan.mockImplementation((_cursor: string, _match: string, pattern: string) => {
        if (pattern === 'inv:reserved:cart-index:{*}') {
          return Promise.resolve([
            '0',
            ['inv:reserved:cart-index:{cart-1}', 'inv:reserved:cart-index:{cart-2}'],
          ] as ScanReply);
        }
        return Promise.resolve(['0', []] as ScanReply);
      });
      smembers.mockResolvedValue(['product-1']);
      inventoryReservations.getActiveReservation.mockResolvedValue(mockActiveReservation());

      const result = await service.verifyRollbackSafe();

      expect(result).toEqual({
        clear: false,
        outstandingProductIds: [],
        structureDriftProductIds: ['product-1'],
      });
      expect(inventoryReservations.getActiveReservation).toHaveBeenCalledTimes(1);
      expect(inventoryReservations.getActiveReservation).toHaveBeenCalledWith('cart-1', 'product-1');
    });

    it('skips a scanned key that does not match the product-total key shape', async () => {
      scan.mockImplementation((_cursor: string, _match: string, pattern: string) => {
        if (pattern === 'inv:reserved:product-total:{*}') {
          return Promise.resolve(['0', ['inv:reserved:product-total:unexpected-shape']]);
        }
        return Promise.resolve(['0', []]);
      });

      const result = await service.verifyRollbackSafe();

      expect(result).toEqual({ clear: true, outstandingProductIds: [], structureDriftProductIds: [] });
      expect(get).not.toHaveBeenCalled();
    });

    it('skips a scanned key that does not match the cart-index key shape', async () => {
      scan.mockImplementation((_cursor: string, _match: string, pattern: string) => {
        if (pattern === 'inv:reserved:cart-index:{*}') {
          return Promise.resolve(['0', ['inv:reserved:cart-index:unexpected-shape']]);
        }
        return Promise.resolve(['0', []]);
      });

      const result = await service.verifyRollbackSafe();

      expect(result).toEqual({ clear: true, outstandingProductIds: [], structureDriftProductIds: [] });
      expect(smembers).not.toHaveBeenCalled();
    });
  });

  // Phase 16A.0-DA, Unit DA.4B (see the DA.4B frozen plan).
  describe('getCurrentModeSnapshot', () => {
    it('returns the implicit-LEGACY snapshot when no config row exists yet', async () => {
      repository.findCurrent.mockResolvedValue(null);

      await expect(service.getCurrentModeSnapshot()).resolves.toEqual({
        mode: 'LEGACY',
        revisionId: null,
        revision: null,
      });
    });

    it("returns the current row's mode, id, and revision when one exists", async () => {
      repository.findCurrent.mockResolvedValue(buildConfig('CART_SCOPED', 7));

      await expect(service.getCurrentModeSnapshot()).resolves.toEqual({
        mode: 'CART_SCOPED',
        revisionId: 'config-1',
        revision: 7,
      });
    });

    it('passes an externally-supplied transaction client through to the repository read', async () => {
      repository.findCurrent.mockResolvedValue(buildConfig('MIRROR', 2));

      await service.getCurrentModeSnapshot(tx);

      expect(repository.findCurrent).toHaveBeenCalledWith(tx);
    });
  });

  describe('verifyModeRevisionUnchanged', () => {
    it('acquires the shared advisory lock on the same key setMode() holds exclusively', async () => {
      repository.findCurrent.mockResolvedValue(buildConfig('MIRROR', 3));

      await service.verifyModeRevisionUnchanged(tx, { revisionId: 'config-1', revision: 3 });

      expect(executeRaw).toHaveBeenCalledTimes(1);
    });

    it('returns true when both revisionId and revision still match', async () => {
      repository.findCurrent.mockResolvedValue(buildConfig('CART_SCOPED', 5));

      await expect(
        service.verifyModeRevisionUnchanged(tx, { revisionId: 'config-1', revision: 5 }),
      ).resolves.toBe(true);
    });

    it('returns false when revisionId no longer matches', async () => {
      repository.findCurrent.mockResolvedValue({ ...buildConfig('CART_SCOPED', 5), id: 'config-2' });

      await expect(
        service.verifyModeRevisionUnchanged(tx, { revisionId: 'config-1', revision: 5 }),
      ).resolves.toBe(false);
    });

    it('returns false when revision no longer matches, even if revisionId did (defensive - should never happen given revision is unique)', async () => {
      repository.findCurrent.mockResolvedValue(buildConfig('CART_SCOPED', 6));

      await expect(
        service.verifyModeRevisionUnchanged(tx, { revisionId: 'config-1', revision: 5 }),
      ).resolves.toBe(false);
    });

    it('returns true when the implicit-LEGACY identity (no row) is still current', async () => {
      repository.findCurrent.mockResolvedValue(null);

      await expect(
        service.verifyModeRevisionUnchanged(tx, { revisionId: null, revision: null }),
      ).resolves.toBe(true);
    });

    it('returns false when the very first transition committed since the implicit-LEGACY snapshot was taken', async () => {
      repository.findCurrent.mockResolvedValue(buildConfig('MIRROR', 1));

      await expect(
        service.verifyModeRevisionUnchanged(tx, { revisionId: null, revision: null }),
      ).resolves.toBe(false);
    });
  });
});
