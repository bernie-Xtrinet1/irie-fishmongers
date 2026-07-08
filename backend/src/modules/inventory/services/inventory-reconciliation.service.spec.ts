import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import { InventoryReconciliationService } from './inventory-reconciliation.service';
import { InventoryReservationsService } from './inventory-reservations.service';

function entryJson(quantity: number, expiresAt: number): string {
  return JSON.stringify({ quantity, expiresAt });
}

describe('InventoryReconciliationService', () => {
  let redis: jest.Mocked<Pick<RedisService, 'hgetall' | 'getClient'>>;
  let reservations: jest.Mocked<Pick<InventoryReservationsService, 'release'>>;
  let prisma: { cartItem: { findFirst: jest.Mock } };
  let service: InventoryReconciliationService;

  beforeEach(() => {
    redis = { hgetall: jest.fn(), getClient: jest.fn() };
    reservations = { release: jest.fn() };
    prisma = { cartItem: { findFirst: jest.fn() } };
    service = new InventoryReconciliationService(
      redis as unknown as RedisService,
      reservations as unknown as InventoryReservationsService,
      prisma as unknown as PrismaService,
    );
  });

  it('releases an orphaned reservation with no matching cart item', async () => {
    redis.hgetall.mockResolvedValue({ 'cart-1': entryJson(3, Date.now() + 60_000) });
    prisma.cartItem.findFirst.mockResolvedValue(null);

    const summary = await service.reconcile('product-1');

    expect(reservations.release).toHaveBeenCalledWith('product-1', 'cart-1');
    expect(summary).toEqual({ productsChecked: 1, reservationsReleased: 1 });
  });

  it('releases a reservation whose cart item quantity dropped below what was reserved', async () => {
    redis.hgetall.mockResolvedValue({ 'cart-1': entryJson(5, Date.now() + 60_000) });
    prisma.cartItem.findFirst.mockResolvedValue({ id: 'item-1', quantity: 2 });

    const summary = await service.reconcile('product-1');

    expect(reservations.release).toHaveBeenCalledWith('product-1', 'cart-1');
    expect(summary.reservationsReleased).toBe(1);
  });

  it('leaves a reservation alone when it matches a live cart item', async () => {
    redis.hgetall.mockResolvedValue({ 'cart-1': entryJson(3, Date.now() + 60_000) });
    prisma.cartItem.findFirst.mockResolvedValue({ id: 'item-1', quantity: 3 });

    const summary = await service.reconcile('product-1');

    expect(reservations.release).not.toHaveBeenCalled();
    expect(summary.reservationsReleased).toBe(0);
  });

  it('skips an already-expired reservation without touching the database', async () => {
    redis.hgetall.mockResolvedValue({ 'cart-1': entryJson(3, Date.now() - 1000) });

    const summary = await service.reconcile('product-1');

    expect(prisma.cartItem.findFirst).not.toHaveBeenCalled();
    expect(reservations.release).not.toHaveBeenCalled();
    expect(summary.reservationsReleased).toBe(0);
  });

  it('scans for all reserved products when no productId filter is given', async () => {
    const scan = jest
      .fn()
      .mockResolvedValueOnce(['0', ['inv:reserved:product-1', 'inv:reserved:product-2']]);
    redis.getClient.mockReturnValue({ scan } as never);
    redis.hgetall.mockResolvedValue({});

    const summary = await service.reconcile();

    expect(scan).toHaveBeenCalledWith('0', 'MATCH', 'inv:reserved:*', 'COUNT', 100);
    expect(summary.productsChecked).toBe(2);
  });
});
