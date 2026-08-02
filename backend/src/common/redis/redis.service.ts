import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import { REDIS_CLIENT } from './redis.constants';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  getClient(): Redis {
    return this.client;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.client.expire(key, ttlSeconds);
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.client.hset(key, field, value);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  async hdel(key: string, field: string): Promise<void> {
    await this.client.hdel(key, field);
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  async eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    return this.client.eval(script, keys.length, ...keys, ...args);
  }

  async loadScript(script: string): Promise<string> {
    const sha1 = await this.client.script('LOAD', script);
    if (typeof sha1 !== 'string') {
      throw new Error('SCRIPT LOAD did not return a string SHA1 digest');
    }
    return sha1;
  }

  async evalsha(sha1: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    return this.client.evalsha(sha1, keys.length, ...keys, ...args);
  }

  // NOSCRIPT reload-and-retry: a caller only ever holds a script's sha1, so
  // if Redis has evicted its script cache (restart, SCRIPT FLUSH) the first
  // evalsha fails with NOSCRIPT. This reloads the script text once and
  // retries with the freshly returned sha1 - never the stale one - rather
  // than surfacing NOSCRIPT to every caller or silently falling back to a
  // plain EVAL. Retries at most once; any other error, or a failure on the
  // retry itself, propagates unchanged.
  async runScript(
    script: string,
    sha1: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    try {
      return await this.evalsha(sha1, keys, args);
    } catch (error) {
      if (!RedisService.isNoScriptError(error)) {
        throw error;
      }
      const loadedSha1 = await this.loadScript(script);
      return this.evalsha(loadedSha1, keys, args);
    }
  }

  private static isNoScriptError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' && message.startsWith('NOSCRIPT');
  }

  onModuleDestroy(): void {
    this.client.disconnect();
    this.logger.log('Redis connection closed');
  }
}
