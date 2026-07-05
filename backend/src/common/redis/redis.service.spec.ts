import { Redis } from 'ioredis';

import { RedisService } from './redis.service';

describe('RedisService', () => {
  let client: jest.Mocked<Pick<Redis, 'set' | 'get' | 'del' | 'ping' | 'disconnect'>>;
  let service: RedisService;

  beforeEach(() => {
    client = {
      set: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
      ping: jest.fn(),
      disconnect: jest.fn(),
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

  it('disconnects on module destroy', () => {
    service.onModuleDestroy();
    expect(client.disconnect).toHaveBeenCalled();
  });
});
