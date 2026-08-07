import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CheckoutAttemptRepository } from './checkout-attempt.repository';

// Real-Postgres integration coverage for CheckoutAttemptRepository's core
// behavior (Phase 16A.0-A): createOrGetByIdempotencyKey, ownership
// visibility across a mismatched key reuse, and the conditional
// heartbeat/commit/fail transitions. Concurrency, keyset pagination, and
// transaction rollback/commit scenarios live in
// checkout-attempt-concurrency.repository.spec.ts - split to keep both
// files within the repository's 400-line cap. Matches
// cart.repository.spec.ts's established convention: a real PrismaService,
// real seeded rows, no mocking.
describe('CheckoutAttemptRepository', () => {
  let prisma: PrismaService;
  let repository: CheckoutAttemptRepository;
  let cartRepository: CartRepository;
  let customerId: string;
  let otherCustomerId: string;
  let cartId: string;
  let otherCartId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new CheckoutAttemptRepository(prisma);
    cartRepository = new CartRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const customerRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.CUSTOMER },
    });

    const customer = await usersRepository.create({
      email: `checkout-attempt-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const otherCustomer = await usersRepository.create({
      email: `checkout-attempt-other-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Ollie',
      lastName: 'Other',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    otherCustomerId = otherCustomer.id;

    cartId = (await cartRepository.findOrCreateByCustomerId(customerId)).id;
    otherCartId = (await cartRepository.findOrCreateByCustomerId(otherCustomerId)).id;
  });

  afterAll(async () => {
    await prisma.checkoutAttempt.deleteMany({ where: { customerId: { in: [customerId, otherCustomerId] } } });
    await prisma.cart.deleteMany({ where: { customerId: { in: [customerId, otherCustomerId] } } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: otherCustomerId } });
    await prisma.onModuleDestroy();
  });

  function idem(): string {
    return `idem-${randomUUID()}`;
  }

  describe('createOrGetByIdempotencyKey', () => {
    it('creates a new row on first call', async () => {
      const idempotencyKey = idem();
      const now = new Date();

      const { attempt, created } = await repository.createOrGetByIdempotencyKey({
        idempotencyKey,
        cartId,
        customerId,
        now,
      });

      expect(created).toBe(true);
      expect(attempt.idempotencyKey).toBe(idempotencyKey);
      expect(attempt.cartId).toBe(cartId);
      expect(attempt.customerId).toBe(customerId);
      expect(attempt.status).toBe('PROCESSING');
      expect(attempt.createdAt).toEqual(now);
      expect(attempt.lastHeartbeatAt).toEqual(now);
    });

    it('resumes the same row on a same key/same ownership retry, without mutating it', async () => {
      const idempotencyKey = idem();
      const now = new Date();
      const first = await repository.createOrGetByIdempotencyKey({ idempotencyKey, cartId, customerId, now });

      const second = await repository.createOrGetByIdempotencyKey({
        idempotencyKey,
        cartId,
        customerId,
        now: new Date(now.getTime() + 5_000),
      });

      expect(second.created).toBe(false);
      expect(second.attempt.id).toBe(first.attempt.id);
      expect(second.attempt.lastHeartbeatAt).toEqual(now); // untouched by the resume
    });

    it('surfaces the original owner on a cross-customer key reuse, for the caller to classify', async () => {
      const idempotencyKey = idem();
      const now = new Date();
      const original = await repository.createOrGetByIdempotencyKey({
        idempotencyKey,
        cartId,
        customerId,
        now,
      });

      const reused = await repository.createOrGetByIdempotencyKey({
        idempotencyKey,
        cartId: otherCartId,
        customerId: otherCustomerId,
        now,
      });

      expect(reused.created).toBe(false);
      expect(reused.attempt.id).toBe(original.attempt.id);
      expect(reused.attempt.customerId).toBe(customerId); // the ORIGINAL owner, not the reuser
    });

    it('surfaces the original owner on a cross-cart key reuse, for the caller to classify', async () => {
      const idempotencyKey = idem();
      const now = new Date();
      const original = await repository.createOrGetByIdempotencyKey({
        idempotencyKey,
        cartId,
        customerId,
        now,
      });

      const reused = await repository.createOrGetByIdempotencyKey({
        idempotencyKey,
        cartId: otherCartId,
        customerId,
        now,
      });

      expect(reused.created).toBe(false);
      expect(reused.attempt.id).toBe(original.attempt.id);
      expect(reused.attempt.cartId).toBe(cartId);
    });
  });

  describe('updateHeartbeatIfProcessing', () => {
    it('updates a PROCESSING row owned by the given customer', async () => {
      const now = new Date();
      const { attempt } = await repository.createOrGetByIdempotencyKey({
        idempotencyKey: idem(),
        cartId,
        customerId,
        now,
      });

      const later = new Date(now.getTime() + 60_000);
      const { count } = await repository.updateHeartbeatIfProcessing(attempt.id, customerId, later);

      expect(count).toBe(1);
      const reread = await repository.findById(attempt.id);
      expect(reread?.lastHeartbeatAt).toEqual(later);
    });

    it('matches zero rows for a regressive heartbeat', async () => {
      const now = new Date();
      const { attempt } = await repository.createOrGetByIdempotencyKey({
        idempotencyKey: idem(),
        cartId,
        customerId,
        now,
      });

      const earlier = new Date(now.getTime() - 1_000);
      const { count } = await repository.updateHeartbeatIfProcessing(attempt.id, customerId, earlier);

      expect(count).toBe(0);
    });

    it('matches zero rows for a different customer', async () => {
      const now = new Date();
      const { attempt } = await repository.createOrGetByIdempotencyKey({
        idempotencyKey: idem(),
        cartId,
        customerId,
        now,
      });

      const { count } = await repository.updateHeartbeatIfProcessing(attempt.id, otherCustomerId, now);

      expect(count).toBe(0);
    });
  });

  describe('markFailed', () => {
    it('transitions PROCESSING to FAILED', async () => {
      const now = new Date();
      const { attempt } = await repository.createOrGetByIdempotencyKey({
        idempotencyKey: idem(),
        cartId,
        customerId,
        now,
      });

      const { count } = await repository.markFailed(
        attempt.id,
        customerId,
        'CHECKOUT_MARK_FAILED',
        'the cart changed',
        now,
      );

      expect(count).toBe(1);
      const reread = await repository.findById(attempt.id);
      expect(reread?.status).toBe('FAILED');
      expect(reread?.failureCode).toBe('CHECKOUT_MARK_FAILED');
    });

    it('matches zero rows once already FAILED', async () => {
      const now = new Date();
      const { attempt } = await repository.createOrGetByIdempotencyKey({
        idempotencyKey: idem(),
        cartId,
        customerId,
        now,
      });
      await repository.markFailed(attempt.id, customerId, 'CODE_A', null, now);

      const { count } = await repository.markFailed(attempt.id, customerId, 'CODE_B', null, now);

      expect(count).toBe(0);
    });
  });
});
