import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaService } from '../../../database/prisma.service';
import { OrdinaryW1Intent, OrdinaryW1IssuanceService } from '../services/ordinary-w1-issuance.service';

describe('unwired ordinary W1 Stage A boundary', () => {
  const intent: OrdinaryW1Intent = { markerId: randomUUID(), cartId: randomUUID(), customerId: randomUUID(),
    productId: randomUUID(), generation: 0, mutationVersion: 0, quantity: 2 };
  const db = new PrismaService();
  const service = new OrdinaryW1IssuanceService(db);
  afterAll(async () => { await db.$disconnect(); });

  it.each([
    { generation: -1 }, { generation: 2147483648 }, { mutationVersion: 0.5 }, { quantity: 0 },
    { quantity: NaN }, { quantity: Infinity }, { markerId: 'invalid' }, { cartId: '' },
    { customerId: 'wrong' }, { productId: `${randomUUID()}\n` }, { requestId: randomUUID() },
  ])('rejects malformed exact intent before opening a transaction: %j', async change => {
    const transaction = jest.spyOn(db, '$transaction');
    expect(await service.issue({ ...intent, ...change })).toEqual({ status: 'DENIED', reason: 'INVALID_INTENT' });
    expect(transaction).not.toHaveBeenCalled();
    transaction.mockRestore();
  });

  it('does not expose authority when the transaction fails', async () => {
    const transaction = jest.spyOn(db, '$transaction').mockRejectedValueOnce(new Error('commit failed'));
    expect(await service.issue(intent)).toEqual({ status: 'DENIED', reason: 'AUTHORITY_REJECTED' });
    transaction.mockRestore();
  });

  it('has only persistence dependencies and no production module registration', () => {
    const source = readFileSync(resolve(__dirname, '../services/ordinary-w1-issuance.service.ts'), 'utf8');
    expect(source).not.toMatch(/RedisService|ioredis|ordinary-reservation-lua|InventoryReservationsService|OrdinaryReservationService|ReservationFencedExecutor|@Injectable/);
    for (const file of ['../reservation-fence.module.ts', '../../inventory/inventory.module.ts', '../../cart/cart.module.ts']) {
      expect(readFileSync(resolve(__dirname, file), 'utf8')).not.toContain('OrdinaryW1IssuanceService');
    }
  });
});
