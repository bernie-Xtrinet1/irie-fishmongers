import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import { AppThrottlerGuard } from './app-throttler.guard';

describe('AppThrottlerGuard', () => {
  function buildGuard(nodeEnv: string): AppThrottlerGuard {
    const configService = { get: jest.fn().mockReturnValue(nodeEnv) };
    return new AppThrottlerGuard(
      [{ name: 'default', ttl: 60_000, limit: 100 }],
      { increment: jest.fn() },
      new Reflector(),
      configService as unknown as ConfigService,
    );
  }

  it('skips throttling in the test environment', async () => {
    const guard = buildGuard('test');
    await expect(
      (guard as unknown as { shouldSkip: (ctx: ExecutionContext) => Promise<boolean> }).shouldSkip(
        {} as ExecutionContext,
      ),
    ).resolves.toBe(true);
  });

  it('does not skip throttling outside the test environment', async () => {
    const guard = buildGuard('production');
    await expect(
      (guard as unknown as { shouldSkip: (ctx: ExecutionContext) => Promise<boolean> }).shouldSkip(
        {} as ExecutionContext,
      ),
    ).resolves.toBe(false);
  });
});
