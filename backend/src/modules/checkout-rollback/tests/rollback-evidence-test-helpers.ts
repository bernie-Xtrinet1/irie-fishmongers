import { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { CheckoutAttemptService } from '../../checkout-attempt/services/checkout-attempt.service';
import { CheckoutAttemptStaleFencingService } from '../../checkout-attempt/services/checkout-attempt-stale-fencing.service';
import { CheckoutRecoveryWorkerService } from '../../checkout-recovery/services/checkout-recovery-worker.service';
import { CheckoutRecoveryLockService } from '../../checkout-recovery/services/checkout-recovery-lock.service';
import { CheckoutRecoveryTelemetryService } from '../../checkout-recovery/services/checkout-recovery-telemetry.service';
import { CheckoutReservationRecoveryService } from '../../inventory/services/checkout-reservation-recovery.service';
import { cartIndexKey, productTotalKey, reservationKey, productSuspectKey } from '../../inventory/constants/inventory.constants';

// Test-only, explicit fixture scope. Never scans or resets the ambient keyspace.
// These sequential observations are NOT an atomic cross-store drain certificate.
export const EVIDENCE_LIMIT = 250;
export function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

export function assertDisposableRedisTarget(value: string | undefined) {
  // Match the explicit endpoint before URL normalization can hide an alias.
  if (!value || value !== value.trim() || !/^redis:\/\/127\.0\.0\.1:16479(?:\/(?:[0-9]+)?)?$/.test(value)) {
    throw new Error('G.4a requires disposable Redis at redis://127.0.0.1:16479');
  }
}

export function assertDisposableEnvironment() {
  assertDisposableRedisTarget(process.env.REDIS_URL);
  const db = new URL(process.env.DATABASE_URL ?? '');
  if (process.env.NODE_ENV !== 'test' ||
      !['localhost', '127.0.0.1'].includes(db.hostname) ||
      !/isolated|test/.test(db.pathname)) {
    throw new Error('G.4a requires an explicitly configured local disposable test environment');
  }
}

// Attempt every cleanup, even if an earlier action throws synchronously.
// Preserve the primary failure as cause while reporting all cleanup failures.
export async function withCleanup<T>(work: () => Promise<T>, cleanups: (() => Promise<unknown>)[]): Promise<T> {
  let primary: unknown;
  let failed = false;
  let value: T | undefined;
  try { value = await work(); }
  catch (error) { failed = true; primary = error; }
  const results = await Promise.allSettled(cleanups.map(cleanup => Promise.resolve().then(cleanup)));
  const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason as unknown);
  if (errors.length) {
    const error = new Error(failed ? 'G.4a primary failure followed by cleanup failure' : 'G.4a cleanup failure');
    Object.assign(error, { cause: failed ? primary : errors[0], cleanupErrors: errors });
    throw error;
  }
  if (failed) throw primary;
  return value as T;
}

function bounded<T>(rows: T[]): T[] {
  if (rows.length > EVIDENCE_LIMIT) throw new Error('Evidence scope exceeded; narrow fixture scope');
  return rows;
}

export async function collectRollbackEvidence(
  prisma: PrismaService,
  redis: Redis,
  scope: { customerIds: string[]; holds: { cartId: string; productId: string }[] },
) {
  bounded(scope.customerIds); bounded(scope.holds);
  if (!scope.customerIds.length) throw new Error('Explicit customer scope required');
  const customers = { in: scope.customerIds };
  const operations = bounded(await prisma.checkoutOperation.findMany({
    where: { customerId: customers }, take: EVIDENCE_LIMIT + 1,
    select: { id: true, operationKey: true, selectedPath: true, priceLockFingerprint: true },
    orderBy: { id: 'asc' },
  }));
  const attempts = bounded(await prisma.checkoutAttempt.findMany({
    where: { customerId: customers }, take: EVIDENCE_LIMIT + 1, orderBy: { id: 'asc' },
    select: { id: true, idempotencyKey: true, status: true, selectedPath: true,
      orderId: true, failureCode: true, lastHeartbeatAt: true },
  }));
  const orders = bounded(await prisma.order.findMany({
    where: { customerId: customers }, take: EVIDENCE_LIMIT + 1, select: { id: true },
  }));
  const payments = bounded(await prisma.payment.findMany({
    where: { order: { customerId: customers } }, take: EVIDENCE_LIMIT + 1,
    select: { orderId: true, status: true, initiationStatus: true, providerReference: true },
  }));
  const processing = attempts.filter(a => a.selectedPath === 'CART_SCOPED' && a.status === 'PROCESSING');
  const failed: Record<string, number> = {};
  for (const a of attempts) if (a.status === 'FAILED') {
    const reason = a.failureCode === null ? 'NULL' :
      ['STALE_RECOVERY_FENCED', 'ORDER_TRANSACTION_FAILED_REVERT_INCOMPLETE', 'ORDER_TRANSACTION_FAILED'].includes(a.failureCode)
        ? a.failureCode : 'OTHER';
    failed[reason] = (failed[reason] ?? 0) + 1;
  }
  const paths = { NULL: 0, LEGACY: 0, CART_SCOPED: 0 };
  for (const o of operations) paths[o.selectedPath ?? 'NULL']++;
  const controls = await prisma.checkoutRolloutControlRevision.findFirst({ orderBy: { revision: 'desc' }, select: { revision: true, newAdmissionStopped: true, behavior: true } });
  const mode = await prisma.reservationEngineModeConfig.findFirst({ orderBy: { revision: 'desc' }, select: { revision: true, mode: true } });
  const barrier = await prisma.cartMutationBarrierConfig.findFirst({ orderBy: { revision: 'desc' }, select: { revision: true, active: true } });
  const sync = await prisma.cartReservationSyncState.groupBy({ by: ['status'], where: { cart: { customerId: customers }, resolvedAt: null }, _count: true });
  const compensation = await prisma.cartReservationCompensation.groupBy({ by: ['status'], where: { cart: { customerId: customers } }, _count: true });
  const holds = [];
  for (const hold of scope.holds) {
    const raw = await redis.get(reservationKey(hold.cartId, hold.productId));
    let status = 'ABSENT';
    if (raw !== null) {
      try {
        const entry = JSON.parse(raw) as { status?: string; quantity?: number; version?: number };
        status = entry && ['ACTIVE', 'CHECKOUT_PENDING'].includes(entry.status ?? '') &&
          typeof entry.quantity === 'number' && entry.quantity > 0 && entry.version === 1
          ? entry.status! : 'MALFORMED';
      } catch { status = 'MALFORMED'; }
    }
    // Bounded membership read, not unbounded SMEMBERS; only declared fixture keys.
    const total = await redis.get(productTotalKey(hold.productId));
    holds.push({ alias: `HOLD_${holds.length + 1}`, present: raw !== null, status,
      indexed: await redis.sismember(cartIndexKey(hold.cartId), hold.productId),
      total: total === null ? null : /^(?:0|[1-9][0-9]{0,14})$/.test(total) ? total : 'MALFORMED',
      suspect: (await redis.get(productSuspectKey(hold.productId))) !== null,
    });
  }
  const attemptAlias = (id: string) => `ATTEMPT_${attempts.findIndex(a => a.id === id) + 1}`;
  return { atomic: false as const, controls, mode, barrier, paths,
    operations: operations.map((o, i) => ({ alias: `OP_${i + 1}`, selectedPath: o.selectedPath, fingerprintPresent: o.priceLockFingerprint !== null })),
    attempts: attempts.map(a => ({ alias: attemptAlias(a.id), status: a.status, selectedPath: a.selectedPath })),
    orders: orders.map((_, i) => ({ alias: `ORDER_${i + 1}` })),
    payments: payments.map((p, i) => ({ alias: `PAYMENT_${i + 1}`, status: p.status, initiationStatus: p.initiationStatus, providerReferencePresent: p.providerReference !== null })),
    ownership: operations.map((o, i) => ({ operationAlias: `OP_${i + 1}`, path: o.selectedPath,
      attemptAlias: attempts.find(a => a.idempotencyKey === o.operationKey) ? attemptAlias(attempts.find(a => a.idempotencyKey === o.operationKey)!.id) : null })),
    processingCount: processing.length,
    oldestHeartbeat: processing.length ? new Date(Math.min(...processing.map(a => a.lastHeartbeatAt.getTime()))) : null,
    failed, sync, compensation, holds,
    committed: attempts.filter(a => a.status === 'COMMITTED').map(a => ({
      attemptAlias: attemptAlias(a.id), orderPresent: orders.some(o => o.id === a.orderId),
      payment: payments.find(p => p.orderId === a.orderId)?.initiationStatus ?? 'MISSING',
    })),
  };
}

// A new Prisma pool and Redis connection per invocation models process restart.
// Real session ownership protects the entire actual worker cycle.
export async function runFreshRecovery() {
  assertDisposableEnvironment();
  const prisma = new PrismaService();
  const redis = new Redis(process.env.REDIS_URL!);
  const repo = new CheckoutAttemptRepository(prisma);
  return withCleanup(async () => {
    await prisma.$connect();
    const cleanupPage = jest.spyOn(repo, 'findFencedCleanupPage');
    const attemptService = new CheckoutAttemptService(repo);
    const stalePage = jest.spyOn(attemptService, 'findStalePage');
    const recovery = new CheckoutReservationRecoveryService(new RedisService(redis));
    const cleanup = jest.spyOn(recovery, 'checkoutRevert');
    const telemetry = new CheckoutRecoveryTelemetryService();
    const events = jest.spyOn(telemetry, 'record');
    const worker = new CheckoutRecoveryWorkerService(attemptService, repo,
      new CheckoutAttemptStaleFencingService(repo), recovery, telemetry);
    const lock = new CheckoutRecoveryLockService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }));
    const acquired = await lock.runExclusive(lease => worker.runCycle(lease));
    const cleanupPages = await Promise.all(cleanupPage.mock.results.map(r => r.value as ReturnType<typeof repo.findFencedCleanupPage>));
    const stalePages = await Promise.all(stalePage.mock.results.map(r => r.value as ReturnType<typeof attemptService.findStalePage>));
    return { acquired, cleanupQueries: cleanupPages.length, staleQueries: stalePages.length,
      cleanupCandidates: cleanupPages.reduce((n, page) => n + page.length, 0),
      staleCandidates: stalePages.reduce((n, page) => n + (page.ok ? page.page.items.length : 0), 0),
      discoveryErrors: stalePages.filter(page => !page.ok).length,
      cleanupCalls: cleanup.mock.calls.length,
      processingErrors: events.mock.calls.filter(([event]) => event === 'checkout_recovery_failed').length,
      skipped: events.mock.calls.filter(([event]) => event === 'checkout_recovery_skipped').length };
  }, [() => redis.quit(), () => prisma.$disconnect()]);
}
