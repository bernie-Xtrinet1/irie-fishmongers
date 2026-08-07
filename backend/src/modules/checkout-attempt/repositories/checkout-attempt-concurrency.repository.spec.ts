import { randomUUID } from 'crypto';

import { Parish, Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CheckoutAttemptRepository } from './checkout-attempt.repository';

// Real-Postgres integration coverage for CheckoutAttemptRepository's
// concurrency, keyset-pagination, and transaction-boundary behavior
// (Phase 16A.0-A). Baseline create/heartbeat/fail scenarios live in
// checkout-attempt.repository.spec.ts - split to keep both files within
// the repository's 400-line cap.
describe('CheckoutAttemptRepository (concurrency, pagination, transactions)', () => {
  let prisma: PrismaService;
  let repository: CheckoutAttemptRepository;
  let customerId: string;
  let cartId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new CheckoutAttemptRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const cartRepository = new CartRepository(prisma);
    const customerRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.CUSTOMER },
    });

    const customer = await usersRepository.create({
      email: `checkout-attempt-concurrency-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Concurrent',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;
    cartId = (await cartRepository.findOrCreateByCustomerId(customerId)).id;
  });

  afterAll(async () => {
    await prisma.checkoutAttempt.deleteMany({ where: { customerId } });
    await prisma.order.deleteMany({ where: { customerId } });
    await prisma.cart.deleteMany({ where: { customerId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.onModuleDestroy();
  });

  function idem(): string {
    return `idem-${randomUUID()}`;
  }

  it('produces exactly one CREATED result under concurrent createOrGetByIdempotencyKey calls', async () => {
    const idempotencyKey = idem();
    const now = new Date();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        repository.createOrGetByIdempotencyKey({ idempotencyKey, cartId, customerId, now }),
      ),
    );

    const createdCount = results.filter((r) => r.created).length;
    const ids = new Set(results.map((r) => r.attempt.id));
    expect(createdCount).toBe(1);
    expect(ids.size).toBe(1);
  });

  it('paginates keyset-style with no duplicate rows across pages, including duplicate heartbeat timestamps', async () => {
    const sharedHeartbeat = new Date();
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        repository.createOrGetByIdempotencyKey({
          idempotencyKey: idem(),
          cartId,
          customerId,
          now: sharedHeartbeat,
        }),
      ),
    );
    const seededIds = new Set(attempts.map((a) => a.attempt.id));
    const heartbeatBefore = new Date(sharedHeartbeat.getTime() + 60_000);

    const collected: string[] = [];
    let cursor: { lastHeartbeatAt: Date; id: string } | null = null;
    for (let i = 0; i < 20; i += 1) {
      const page = await repository.findStaleProcessing({ heartbeatBefore, cursor, limit: 2 });
      const ourRows = page.filter((row) => seededIds.has(row.id));
      collected.push(...ourRows.map((row) => row.id));
      if (page.length === 0) break;
      const last = page[page.length - 1]!;
      const nextCursor = { lastHeartbeatAt: last.lastHeartbeatAt, id: last.id };
      if (cursor && nextCursor.lastHeartbeatAt.getTime() === cursor.lastHeartbeatAt.getTime() && nextCursor.id === cursor.id) {
        break;
      }
      cursor = nextCursor;
      if (page.length < 2) break;
    }

    expect(new Set(collected).size).toBe(collected.length); // no duplicates
    expect(seededIds.size).toBe(new Set([...collected].filter((id) => seededIds.has(id))).size);
  });

  it('rolls back both the Order and the COMMITTED transition together on failure', async () => {
    const idempotencyKey = idem();
    const now = new Date();
    const { attempt } = await repository.createOrGetByIdempotencyKey({
      idempotencyKey,
      cartId,
      customerId,
      now,
    });

    let orderId: string | undefined;
    await expect(
      prisma.$transaction(async (tx) => {
        const order = await tx.order.create({
          data: {
            customerId,
            deliveryAddressLine1: '1 Test Lane',
            deliveryParish: Parish.KINGSTON,
            deliveryPhone: '876-555-0000',
          },
        });
        orderId = order.id;
        await repository.markCommitted(tx, attempt.id, customerId, order.id, now);
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    const reread = await repository.findById(attempt.id);
    expect(reread?.status).toBe('PROCESSING');
    expect(reread?.orderId).toBeNull();
    if (orderId) {
      await expect(prisma.order.findUnique({ where: { id: orderId } })).resolves.toBeNull();
    }
  });

  it('commits both the Order and the COMMITTED transition together on success', async () => {
    const idempotencyKey = idem();
    const now = new Date();
    const { attempt } = await repository.createOrGetByIdempotencyKey({
      idempotencyKey,
      cartId,
      customerId,
      now,
    });

    const orderId = await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          customerId,
          deliveryAddressLine1: '1 Test Lane',
          deliveryParish: Parish.KINGSTON,
          deliveryPhone: '876-555-0000',
        },
      });
      await repository.markCommitted(tx, attempt.id, customerId, order.id, now);
      return order.id;
    });

    const reread = await repository.findById(attempt.id);
    expect(reread?.status).toBe('COMMITTED');
    expect(reread?.orderId).toBe(orderId);
    await expect(prisma.order.findUnique({ where: { id: orderId } })).resolves.not.toBeNull();
  });

  it('has the additive composite index required by the keyset query', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'checkout_attempts'
        AND indexname = 'checkout_attempts_status_lastHeartbeatAt_id_idx'
    `;
    expect(rows).toHaveLength(1);
  });
});
