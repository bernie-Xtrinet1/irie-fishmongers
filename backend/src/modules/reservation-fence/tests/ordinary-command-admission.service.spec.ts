import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaService } from '../../../database/prisma.service';
import { OrdinaryW1IssuanceService } from '../services/ordinary-w1-issuance.service';

describe('inactive controlled issuance API boundary', () => {
  const db = new PrismaService();
  const service = new OrdinaryW1IssuanceService(db);
  afterAll(async () => { await db.$disconnect(); });
  afterEach(() => jest.restoreAllMocks());
  const intent = { markerId: randomUUID(), cartId: randomUUID(), customerId: randomUUID(),
    productId: randomUUID(), generation: 0, mutationVersion: 0, quantity: 2 };

  it('preserves ordinary issuance shape and rejects invalid controlled intent before transaction', async () => {
    const transaction = jest.spyOn(db, '$transaction');
    const invalid = { ...intent, quantity: 0 };
    expect(await service.issue(invalid)).toEqual({ status: 'DENIED', reason: 'INVALID_INTENT' });
    expect(await service.issueForControlledDispatch(invalid)).toEqual({
      issuance: { status: 'DENIED', reason: 'INVALID_INTENT' }, admission: null });
    expect(transaction).not.toHaveBeenCalled();
  });
  it('transaction rejection cannot produce admission', async () => {
    jest.spyOn(db, '$transaction').mockRejectedValueOnce(new Error('transaction rejected'));
    expect(await service.issueForControlledDispatch(intent)).toEqual({
      issuance: { status: 'DENIED', reason: 'AUTHORITY_REJECTED' }, admission: null });
  });
  it.each([null, undefined, {}, { admitted: true }, 'token', 1])('rejects fabricated capability %j', candidate => {
    expect(service.consumeAdmission(candidate)).toBeNull();
  });
  it('contains no claim, coordinator, physical, Redis or closure dependency or production registration', () => {
    const source = readFileSync(resolve(__dirname, '../services/ordinary-w1-issuance.service.ts'), 'utf8');
    expect(source).not.toMatch(/RedisService|ioredis|@Injectable|OrdinaryCommandDispatchClaimRepository|OrdinaryCommandPhysicalService|OrdinaryCommandClosureService|OrdinaryCommandCoordinator|\.claim\(|\.execute\(|\.initialize\(|\.close\(/);
    for (const file of ['../reservation-fence.module.ts', '../../inventory/inventory.module.ts', '../../cart/cart.module.ts'])
      expect(readFileSync(resolve(__dirname, file), 'utf8')).not.toContain('OrdinaryW1IssuanceService');
  });
});
