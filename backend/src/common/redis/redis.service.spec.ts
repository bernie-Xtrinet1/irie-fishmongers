import { Redis } from 'ioredis';

import { RedisService } from './redis.service';

describe('RedisService', () => {
  let client: jest.Mocked<
    Pick<
      Redis,
      | 'set'
      | 'get'
      | 'del'
      | 'ping'
      | 'disconnect'
      | 'expire'
      | 'hset'
      | 'hget'
      | 'hgetall'
      | 'hdel'
      | 'eval'
      | 'evalsha'
      | 'script'
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
      eval: jest.fn(),
      evalsha: jest.fn(),
      script: jest.fn(),
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

  describe('eval', () => {
    it('forwards the script, key count, keys and args in exact order', async () => {
      client.eval.mockResolvedValue('eval-result');
      const result = await service.eval('return 1', ['key1', 'key2'], ['arg1', 2]);
      expect(client.eval).toHaveBeenCalledWith('return 1', 2, 'key1', 'key2', 'arg1', 2);
      expect(result).toBe('eval-result');
    });

    it('works with zero keys', async () => {
      client.eval.mockResolvedValue('ok');
      await service.eval('return 1', [], ['only-arg']);
      expect(client.eval).toHaveBeenCalledWith('return 1', 0, 'only-arg');
    });
  });

  describe('loadScript', () => {
    it('calls SCRIPT LOAD and returns the sha1', async () => {
      client.script.mockResolvedValue('abc123sha');
      await expect(service.loadScript('return 1')).resolves.toBe('abc123sha');
      expect(client.script).toHaveBeenCalledWith('LOAD', 'return 1');
    });

    it('throws if SCRIPT LOAD does not return a string', async () => {
      client.script.mockResolvedValue(null);
      await expect(service.loadScript('return 1')).rejects.toThrow(
        'SCRIPT LOAD did not return a string SHA1 digest',
      );
    });
  });

  describe('evalsha', () => {
    it('forwards the sha1, key count, keys and args in exact order', async () => {
      client.evalsha.mockResolvedValue('evalsha-result');
      const result = await service.evalsha('sha1value', ['key1'], ['arg1']);
      expect(client.evalsha).toHaveBeenCalledWith('sha1value', 1, 'key1', 'arg1');
      expect(result).toBe('evalsha-result');
    });
  });

  describe('runScript', () => {
    it('returns the evalsha result on the happy path without loading the script', async () => {
      client.evalsha.mockResolvedValue('happy-result');

      const result = await service.runScript('return 1', 'sha1value', ['key1'], ['arg1']);

      expect(client.evalsha).toHaveBeenCalledTimes(1);
      expect(client.script).not.toHaveBeenCalled();
      expect(result).toBe('happy-result');
    });

    it('reloads the script and retries once with the newly returned sha1 on NOSCRIPT', async () => {
      client.evalsha
        .mockRejectedValueOnce(new Error('NOSCRIPT No matching script. Please use EVAL.'))
        .mockResolvedValueOnce('retry-result');
      client.script.mockResolvedValue('new-sha1');

      const result = await service.runScript('return 1', 'stale-sha1', ['key1'], ['arg1']);

      expect(client.script).toHaveBeenCalledTimes(1);
      expect(client.script).toHaveBeenCalledWith('LOAD', 'return 1');
      expect(client.evalsha).toHaveBeenNthCalledWith(1, 'stale-sha1', 1, 'key1', 'arg1');
      expect(client.evalsha).toHaveBeenNthCalledWith(2, 'new-sha1', 1, 'key1', 'arg1');
      expect(result).toBe('retry-result');
    });

    it('propagates a non-NOSCRIPT error without loading or retrying', async () => {
      client.evalsha.mockRejectedValue(new Error('WRONGTYPE some other error'));

      await expect(
        service.runScript('return 1', 'sha1value', ['key1'], ['arg1']),
      ).rejects.toThrow('WRONGTYPE some other error');
      expect(client.script).not.toHaveBeenCalled();
      expect(client.evalsha).toHaveBeenCalledTimes(1);
    });

    it('propagates a second evalsha failure after reload without a further retry', async () => {
      client.evalsha
        .mockRejectedValueOnce(new Error('NOSCRIPT No matching script. Please use EVAL.'))
        .mockRejectedValueOnce(new Error('some other failure after reload'));
      client.script.mockResolvedValue('new-sha1');

      await expect(
        service.runScript('return 1', 'stale-sha1', ['key1'], ['arg1']),
      ).rejects.toThrow('some other failure after reload');
      expect(client.script).toHaveBeenCalledTimes(1);
      expect(client.evalsha).toHaveBeenCalledTimes(2);
    });

    it('recognizes a NOSCRIPT-like plain object with a message safely', async () => {
      client.evalsha
        .mockRejectedValueOnce({ message: 'NOSCRIPT No matching script. Please use EVAL.' })
        .mockResolvedValueOnce('retry-result');
      client.script.mockResolvedValue('new-sha1');

      const result = await service.runScript('return 1', 'stale-sha1', ['key1'], ['arg1']);

      expect(result).toBe('retry-result');
      expect(client.script).toHaveBeenCalledTimes(1);
    });
  });
});
