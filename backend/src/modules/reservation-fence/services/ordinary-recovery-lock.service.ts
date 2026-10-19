import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  ORDINARY_RECOVERY_LOCK_NAMESPACE,
  ORDINARY_RECOVERY_LOCK_ID,
  OrdinaryRecoveryOwnershipLost,
  OrdinaryRecoveryLockCleanupError,
  OrdinaryRecoveryExecutionPermit,
  OrdinaryRecoveryLockOutcome,
  IOrdinaryRecoveryLockService,
} from '../types/ordinary-recovery-lock.types';

export interface PrismaSessionClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: any[]): Promise<T>;
  $disconnect(): Promise<void>;
}

export type PrismaSessionFactory = (url: string) => PrismaSessionClient;

/**
 * Phase C — Distributed Ordinary Recovery Lock Service.
 *
 * Implements PostgreSQL session-level advisory locking (CHKT, 2) on a dedicated,
 * unpooled database connection. Provides cooperative execution permits with
 * AbortSignal and explicit assertion checkpoints.
 *
 * Safety & Isolation Properties:
 * - Non-blocking acquisition via pg_try_advisory_lock(1128811348, 2).
 * - Direct-session validation: rejects transaction pooling (pgbouncer=true or port 6543).
 * - Dedicated single-connection pool (connection_limit=1).
 * - Backend PID binding: records pg_backend_pid() and verifies exact session in pg_locks (objsubid = 2).
 * - Preserves original callback errors even if unlock/disconnect fails during teardown.
 * - Fails closed on ownership uncertainty.
 */
@Injectable()
export class OrdinaryRecoveryLockService implements IOrdinaryRecoveryLockService {
  private readonly logger = new Logger(OrdinaryRecoveryLockService.name);
  private readonly clientFactory: PrismaSessionFactory;

  constructor(
    private readonly config: ConfigService,
    clientFactory?: PrismaSessionFactory,
  ) {
    this.clientFactory =
      clientFactory ??
      ((url: string) =>
        new PrismaClient({
          datasources: { db: { url } },
        }));
  }

  private resolveDirectDatabaseUrl(): string {
    const directUrl = this.config.get<string>('DIRECT_DATABASE_URL');
    const dbUrl = directUrl || this.config.getOrThrow<string>('DATABASE_URL');

    let parsed: URL;
    try {
      parsed = new URL(dbUrl);
    } catch {
      throw new Error('Invalid database connection URL configured for ordinary recovery lock');
    }

    // Reject transaction pooling configurations
    if (parsed.searchParams.get('pgbouncer') === 'true' || parsed.port === '6543') {
      throw new Error('Ordinary recovery requires a direct PostgreSQL session');
    }

    parsed.searchParams.set('connection_limit', '1');
    parsed.searchParams.set('pool_timeout', '5');
    parsed.searchParams.set('connect_timeout', '5');

    return parsed.toString();
  }

  async withExclusiveLock<T>(
    operation: (permit: OrdinaryRecoveryExecutionPermit) => Promise<T>,
  ): Promise<OrdinaryRecoveryLockOutcome<T>> {
    const url = this.resolveDirectDatabaseUrl();
    const session = this.clientFactory(url);

    let ownerPid: number | null = null;
    let owned = false;
    const acquisitionId = randomUUID();
    const abortController = new AbortController();
    let permitInvalidated = false;

    let callbackExecuted = false;
    let callbackResult: T | undefined;
    let callbackError: unknown | undefined;

    try {
      // 1. Nonblocking lock acquisition query
      const rows = await session.$queryRaw<{ acquired: boolean; pid: number }[]>`
        SELECT pg_try_advisory_lock(${ORDINARY_RECOVERY_LOCK_NAMESPACE}::int, ${ORDINARY_RECOVERY_LOCK_ID}::int) AS acquired,
               pg_backend_pid() AS pid`;

      if (!rows || !rows[0] || !rows[0].acquired) {
        return { status: 'LOCK_BUSY' };
      }

      ownerPid = rows[0].pid;
      owned = true;

      // 2. Build the cooperative execution permit
      const permit: OrdinaryRecoveryExecutionPermit = {
        signal: abortController.signal,
        ownerPid,
        acquisitionId,
        assertHeld: async () => {
          if (permitInvalidated || abortController.signal.aborted) {
            throw new OrdinaryRecoveryOwnershipLost('Execution permit has been invalidated');
          }
          try {
            const state = await session.$queryRaw<{ held: boolean }[]>`
              SELECT pg_backend_pid() = ${ownerPid}::int AND EXISTS (
                SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted
                  AND pid = pg_backend_pid() AND classid = ${ORDINARY_RECOVERY_LOCK_NAMESPACE}::oid
                  AND objid = ${ORDINARY_RECOVERY_LOCK_ID}::oid AND objsubid = 2
              ) AS held`;

            if (!state || !state[0] || !state[0].held) {
              permitInvalidated = true;
              abortController.abort();
              throw new OrdinaryRecoveryOwnershipLost();
            }
          } catch (err) {
            permitInvalidated = true;
            abortController.abort();
            if (err instanceof OrdinaryRecoveryOwnershipLost) {
              throw err;
            }
            throw new OrdinaryRecoveryOwnershipLost(
              `Lock ownership assertion failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      };

      // 3. Verify ownership immediately before invoking callback
      await permit.assertHeld();

      // 4. Execute protected callback
      try {
        callbackResult = await operation(permit);
        callbackExecuted = true;
      } catch (opErr) {
        callbackError = opErr;
      }
    } catch (acqOrAssertErr) {
      // Acquisition or pre-callback assertion error
      callbackError = acqOrAssertErr;
    } finally {
      // Terminal invalidation: permit is permanently invalidated on all exit paths
      permitInvalidated = true;
      if (!abortController.signal.aborted) {
        abortController.abort();
      }

      // 5. Cleanup phase
      let unlockError: unknown | undefined;
      let disconnectError: unknown | undefined;

      if (owned && ownerPid !== null) {
        try {
          const unlockRows = await session.$queryRaw<{ unlocked: boolean }[]>`
            SELECT pg_advisory_unlock(${ORDINARY_RECOVERY_LOCK_NAMESPACE}::int, ${ORDINARY_RECOVERY_LOCK_ID}::int) AS unlocked
            WHERE pg_backend_pid() = ${ownerPid}::int`;

          if (!unlockRows || !unlockRows[0] || !unlockRows[0].unlocked) {
            unlockError = new OrdinaryRecoveryLockCleanupError(
              'pg_advisory_unlock returned false; lock was not held or session changed',
            );
          }
        } catch (unlErr) {
          unlockError = unlErr;
        }
      }

      try {
        await session.$disconnect();
      } catch (discErr) {
        disconnectError = discErr;
      }

      // Cleanup error precedence handling:
      // Case A: Callback threw an error
      if (callbackError !== undefined) {
        // If cleanup also failed, preserve callbackError and attach cleanup diagnostics
        if (unlockError || disconnectError) {
          const cleanupMsg = `Cleanup failure after callback error: unlock=${String(unlockError)}, disconnect=${String(disconnectError)}`;
          this.logger.error(cleanupMsg);
          try {
            (callbackError as any).cleanupError = unlockError || disconnectError;
          } catch {
            // Non-extensible error, ignore attachment failure
          }
        }
        throw callbackError;
      }

      // Case B: Callback succeeded, but cleanup failed
      if (unlockError) {
        throw unlockError instanceof Error
          ? unlockError
          : new OrdinaryRecoveryLockCleanupError(`Lock release query failed: ${String(unlockError)}`);
      }

      if (disconnectError) {
        throw disconnectError instanceof Error
          ? disconnectError
          : new OrdinaryRecoveryLockCleanupError(`Client disconnect failed: ${String(disconnectError)}`);
      }
    }

    if (!callbackExecuted) {
      throw new Error('Lock acquisition failed without returning LOCK_BUSY');
    }

    return {
      status: 'EXECUTED',
      value: callbackResult as T,
    };
  }
}
