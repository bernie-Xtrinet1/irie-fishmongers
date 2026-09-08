import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

// Two-int advisory namespace: ASCII CHKT, checkout recovery worker version 1.
export const CHECKOUT_RECOVERY_LOCK_NAMESPACE = 1128811348;
export const CHECKOUT_RECOVERY_LOCK_ID = 1;
export class CheckoutRecoveryOwnershipLost extends Error {}
export interface CheckoutRecoveryLease {
  assertHeld(): Promise<void>;
}

@Injectable()
export class CheckoutRecoveryLockService {
  constructor(private readonly config: ConfigService) {}

  async runExclusive(work: (lease: CheckoutRecoveryLease) => Promise<void>): Promise<boolean> {
    const url = new URL(this.config.getOrThrow<string>('DATABASE_URL'));
    if (url.searchParams.get('pgbouncer') === 'true') {
      throw new Error('Checkout recovery requires a direct PostgreSQL session');
    }
    // Separate one-connection pool: never lend the lock session to application
    // queries. The G.PR0 fence must commit BEFORE external Redis cleanup, not
    // inside a surrounding transaction that could roll it back after cleanup.
    url.searchParams.set('connection_limit', '1');
    url.searchParams.set('pool_timeout', '5');
    url.searchParams.set('connect_timeout', '5');
    const session = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    let ownerPid: number | null = null;
    let owned = false;
    try {
      const rows = await session.$queryRaw<{ acquired: boolean; pid: number }[]>`
        SELECT pg_try_advisory_lock(${CHECKOUT_RECOVERY_LOCK_NAMESPACE}::int, ${CHECKOUT_RECOVERY_LOCK_ID}::int) AS acquired,
               pg_backend_pid() AS pid`;
      if (!rows[0]?.acquired) return false;
      ownerPid = rows[0].pid;
      owned = true;
      const lease: CheckoutRecoveryLease = {
        assertHeld: async () => {
          try {
            const state = await session.$queryRaw<{ held: boolean }[]>`
            SELECT pg_backend_pid() = ${ownerPid}::int AND EXISTS (
              SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted
                AND pid = pg_backend_pid() AND classid = ${CHECKOUT_RECOVERY_LOCK_NAMESPACE}::oid
                AND objid = ${CHECKOUT_RECOVERY_LOCK_ID}::oid AND objsubid = 2
            ) AS held`;
            if (!state[0]?.held) throw new CheckoutRecoveryOwnershipLost();
          } catch {
            throw new CheckoutRecoveryOwnershipLost();
          }
        },
      };
      await lease.assertHeld();
      await work(lease);
      await lease.assertHeld();
      return true;
    } finally {
      try {
        if (owned) {
          await session.$queryRaw`
            SELECT pg_advisory_unlock(${CHECKOUT_RECOVERY_LOCK_NAMESPACE}::int, ${CHECKOUT_RECOVERY_LOCK_ID}::int)
            WHERE pg_backend_pid() = ${ownerPid}::int`;
        }
      } finally {
        // Closing this dedicated session also releases the lock if unlock fails.
        await session.$disconnect();
      }
    }
  }
}
