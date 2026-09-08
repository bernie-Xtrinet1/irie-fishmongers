import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';
import {
  CheckoutRecoveryLockService,
  CHECKOUT_RECOVERY_LOCK_NAMESPACE,
  CHECKOUT_RECOVERY_LOCK_ID,
} from './checkout-recovery-lock.service';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('Checkout recovery distributed session ownership (Postgres)', () => {
  const prisma = new PrismaService();
  const makeLock = () =>
    new CheckoutRecoveryLockService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }));
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('allows one racing owner, holds ownership during work, and releases after completion', async () => {
    const entered = gate();
    const finish = gate();
    let workCount = 0;
    const work = async () => {
      workCount++;
      entered.release();
      await finish.promise;
    };
    const first = makeLock().runExclusive(work);
    const second = makeLock().runExclusive(work);
    try {
      await entered.promise;
      expect(await Promise.race([first, second])).toBe(false);
      expect(await makeLock().runExclusive(() => Promise.reject(new Error('must skip')))).toBe(
        false,
      );
    } finally {
      finish.release();
    }
    expect((await Promise.all([first, second])).sort()).toEqual([false, true]);
    expect(workCount).toBe(1);
    expect(
      await makeLock().runExclusive(async (lease) => {
        await lease.assertHeld();
      }),
    ).toBe(true);
  });

  it('releases ownership when the protected worker throws', async () => {
    await expect(
      makeLock().runExclusive(() => Promise.reject(new Error('worker failed'))),
    ).rejects.toThrow('worker failed');
    expect(await makeLock().runExclusive(() => Promise.resolve())).toBe(true);
  });

  it('releases on backend termination; a replacement owner acquires and the old owner cannot continue', async () => {
    const entered = gate();
    const resume = gate();
    let continued = false;
    const old = makeLock().runExclusive(async (lease) => {
      entered.release();
      await resume.promise;
      await lease.assertHeld();
      continued = true;
    });
    const rejection = expect(old).rejects.toThrow();
    try {
      await entered.promise;
      const owners = await prisma.$queryRaw<{ pid: number }[]>`
        SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted
          AND classid = ${CHECKOUT_RECOVERY_LOCK_NAMESPACE}::oid AND objid = ${CHECKOUT_RECOVERY_LOCK_ID}::oid
          AND objsubid = 2 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
      expect(owners).toHaveLength(1);
      await prisma.$queryRaw`SELECT pg_terminate_backend(${owners[0]!.pid}::int)`;
      expect(
        await makeLock().runExclusive(async (lease) => {
          await lease.assertHeld();
        }),
      ).toBe(true);
    } finally {
      resume.release();
    }
    await rejection;
    expect(continued).toBe(false);
  });

  it('fails closed for explicitly configured transaction-pooling mode', async () => {
    const lock = new CheckoutRecoveryLockService(
      new ConfigService({ DATABASE_URL: 'postgresql://test@localhost/test?pgbouncer=true' }),
    );
    await expect(lock.runExclusive(() => Promise.resolve())).rejects.toThrow(
      'direct PostgreSQL session',
    );
  });
});
