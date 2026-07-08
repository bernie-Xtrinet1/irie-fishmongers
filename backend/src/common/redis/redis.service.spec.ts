import { Redis } from 'ioredis';

import { RedisService } from './redis.service';

describe('RedisService', () => {
  let client: jest.Mocked<
    Pick<
      Redis,
      'set' | 'get' | 'del' | 'ping' | 'disconnect' | 'expire' | 'hset' | 'hget' | 'hgetall' | 'hdel'
    >
  >;
  let service: RedisService;

  beforeEach(() => {
    client = {
      set: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
      ping: jest.fn(),
      disconnect: jest.fn(),
      expire: jest.fn(),
      hset: jest.fn(),
      hget: jest.fn(),
      hgetall: jest.fn(),
      hdel: jest.fn(),
    };
    service = new RedisService(client as unknown as Redis);
  });

  it('returns the underlying client', () => {
    expect(service.getClient()).toBe(client);
  });

  it('sets a value without a TTL', async () => {
    await service.set('key', 'value');
    expect(client.set).toHaveBeenCalledWith('key', 'value');
  });

  it('sets a value with a TTL', async () => {
    await service.set('key', 'value', 60);
    expect(client.set).toHaveBeenCalledWith('key', 'value', 'EX', 60);
  });

  it('gets a value', async () => {
    client.get.mockResolvedValue('value');
    await expect(service.get('key')).resolves.toBe('value');
    expect(client.get).toHaveBeenCalledWith('key');
  });

  it('deletes a value', async () => {
    client.del.mockResolvedValue(1);
    await expect(service.del('key')).resolves.toBe(1);
    expect(client.del).toHaveBeenCalledWith('key');
  });

  it('pings the server', async () => {
    client.ping.mockResolvedValue('PONG');
    await expect(service.ping()).resolves.toBe('PONG');
  });

  it('sets an expiry on a key', async () => {
    await service.expire('key', 60);
    expect(client.expire).toHaveBeenCalledWith('key', 60);
  });

  it('sets a hash field', async () => {
    await service.hset('hash-key', 'field', 'value');
    expect(client.hset).toHaveBeenCalledWith('hash-key', 'field', 'value');
  });

  it('gets a hash field', async () => {
    client.hget.mockResolvedValue('value');
    await expect(service.hget('hash-key', 'field')).resolves.toBe('value');
    expect(client.hget).toHaveBeenCalledWith('hash-key', 'field');
  });

  it('gets all hash fields', async () => {
    client.hgetall.mockResolvedValue({ field: 'value' });
    await expect(service.hgetall('hash-key')).resolves.toEqual({ field: 'value' });
    expect(client.hgetall).toHaveBeenCalledWith('hash-key');
  });

  it('deletes a hash field', async () => {
    await service.hdel('hash-key', 'field');
    expect(client.hdel).toHaveBeenCalledWith('hash-key', 'field');
  });

  it('disconnects on module destroy', () => {
    service.onModuleDestroy();
    expect(client.disconnect).toHaveBeenCalled();
  });
});
