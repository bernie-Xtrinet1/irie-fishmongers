import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Redis } from 'ioredis';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { OrdinaryCommandPhysicalService } from '../services/ordinary-command-physical.service';

describe('inactive physical command service boundary', () => {
  const db = new PrismaService();
  const client = new Redis('redis://127.0.0.1:16479/11', { lazyConnect: true });
  const redis = new RedisService(client);
  const service = new OrdinaryCommandPhysicalService(db, redis);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { client.disconnect(); await db.$disconnect(); });
  it.each(['', 'not-a-command', '00000000-0000-0000-0000-000000000000\n'])('rejects invalid command ID %j without Redis', async id => {
    const evalSpy = jest.spyOn(redis, 'eval');
    expect(await service.execute(id)).toEqual({ code: 'REJECTED' });
    expect(evalSpy).not.toHaveBeenCalled();
  });
  it('does not register when the authority transaction rejects', async () => {
    jest.spyOn(db, '$transaction').mockRejectedValueOnce(new Error('transaction rejected'));
    const evalSpy = jest.spyOn(redis, 'eval');
    expect(await service.execute('00000000-0000-0000-0000-000000000000')).toEqual({ code: 'REJECTED' });
    expect(evalSpy).not.toHaveBeenCalled();
  });
  it('is unwired and contains no issuance or PostgreSQL write API', () => {
    const source = readFileSync(resolve(__dirname, '../services/ordinary-command-physical.service.ts'), 'utf8');
    expect(source).not.toMatch(/@Injectable|OrdinaryW1IssuanceService|\.acknowledge\(|\.recordDispatch\(|(?:tx|prisma)\.\w+\.(?:update|create|delete|upsert)/);
    for (const file of ['../reservation-fence.module.ts', '../../inventory/inventory.module.ts'])
      expect(readFileSync(resolve(__dirname, file), 'utf8')).not.toContain('OrdinaryCommandPhysicalService');
    expect(readFileSync(resolve(__dirname, '../lua/ordinary-command-physical.lua.ts'), 'utf8')).toContain('Standalone Redis only');
  });
});
