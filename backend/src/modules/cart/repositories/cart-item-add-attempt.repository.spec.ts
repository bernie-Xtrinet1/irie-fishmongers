import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartRepository } from './cart.repository';
import { CartItemAddAttemptRepository } from './cart-item-add-attempt.repository';

// Phase 16A.0-DA, Unit DA.2 (see the DA.2 design review). Direct real-
// Postgres proof of CartItemAddAttemptRepository's own primitives, in
// isolation from CartService's orchestration (covered end-to-end by
// cart-item-add-idempotency.integration.spec.ts).
describe('CartItemAddAttemptRepository (real Postgres)', () => {
  let prisma: PrismaService;
  let repository: CartItemAddAttemptRepository;
  let cartRepository: CartRepository;
  let productsRepository: ProductsRepository;
  let vendorId: string;
  let categoryId: string;
  let customerId: string;
  let vendorUserId: string;
  let category: Category;
  let cartId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new CartItemAddAttemptRepository(prisma);
    cartRepository = new CartRepository(prisma);
    productsRepository = new ProductsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });

    const customer = await usersRepository.create({
      email: `add-attempt-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Ada',
      lastName: 'Attempt',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `add-attempt-vendor-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Vera',
      lastName: 'Vendor',
      roleId: vendorRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    vendorUserId = vendorUser.id;

    const vendor: Vendor = await vendorsRepository.create({
      userId: vendorUserId,
      businessName: "Vera's Catch",
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });
    await prisma.vendor.update({ where: { id: vendor.id }, data: { status: 'APPROVED' } });
    vendorId = vendor.id;

    category = await categoriesRepository.create({
      name: `Add Attempt Test Category ${randomUUID()}`,
      slug: `add-attempt-test-category-${randomUUID()}`,
    });
    categoryId = category.id;

    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    cartId = cart.id;
  });

  afterAll(async () => {
    await prisma.cartItemAddAttempt.deleteMany({ where: { cartId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  async function createProduct(name: string) {
    return productsRepository.create({
      vendorId,
      categoryId,
      name: `${name} ${randomUUID()}`,
      description: 'A product used only for one CartItemAddAttemptRepository test case.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 50,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
  }

  // Collapses the repeated createOrGetByIdempotencyKey call shape used by
  // nearly every test below - each test only needs to vary productId and
  // occasionally now/requestedQuantity/customerId/cartId.
  function createAttempt(overrides: {
    productId: string;
    idempotencyKey?: string;
    requestedQuantity?: number;
    now?: Date;
    customerId?: string;
    cartId?: string;
  }) {
    return repository.createOrGetByIdempotencyKey({
      idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
      customerId: overrides.customerId ?? customerId,
      cartId: overrides.cartId ?? cartId,
      productId: overrides.productId,
      requestedQuantity: overrides.requestedQuantity ?? 1,
      now: overrides.now ?? new Date(),
    });
  }

  describe('createOrGetByIdempotencyKey', () => {
    it('creates a new PROCESSING row at attemptCount 1 for a fresh key', async () => {
      const product = await createProduct('Create Fresh');

      const { attempt, created } = await createAttempt({ productId: product.id, requestedQuantity: 3 });

      expect(created).toBe(true);
      expect(attempt.status).toBe('PROCESSING');
      expect(attempt.attemptCount).toBe(1);
      expect(attempt.productId).toBe(product.id);
      expect(attempt.requestedQuantity).toBe(3);
    });

    it('a concurrent create for the same (customerId, idempotencyKey) returns the winner, not a duplicate row', async () => {
      const product = await createProduct('Create Collision');
      const key = randomUUID();

      const [first, second] = await Promise.all([
        createAttempt({ productId: product.id, idempotencyKey: key, requestedQuantity: 4 }),
        createAttempt({ productId: product.id, idempotencyKey: key, requestedQuantity: 4 }),
      ]);

      const createdCount = [first.created, second.created].filter(Boolean).length;
      expect(createdCount).toBe(1); // exactly one winner
      expect(first.attempt.id).toBe(second.attempt.id); // both observe the same row

      const rows = await prisma.cartItemAddAttempt.findMany({ where: { customerId, idempotencyKey: key } });
      expect(rows).toHaveLength(1);
    });

    it('the same customer reusing the same key with a different product returns the existing row unchanged (fingerprint classification is the service\'s job, not this primitive\'s)', async () => {
      const productA = await createProduct('Fingerprint A');
      const productB = await createProduct('Fingerprint B');
      const key = randomUUID();

      const { attempt: first } = await createAttempt({ productId: productA.id, idempotencyKey: key });
      const { attempt: second, created } = await createAttempt({
        productId: productB.id,
        idempotencyKey: key,
        requestedQuantity: 9,
      });

      expect(created).toBe(false);
      expect(second.id).toBe(first.id);
      expect(second.productId).toBe(productA.id); // the FIRST attempt's stored fingerprint, unchanged
    });

    it('two different customers may reuse the identical UUID key without collision', async () => {
      const product = await createProduct('Cross Customer');
      const otherUsersRepository = new UsersRepository(prisma);
      const customerRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
      const otherCustomer = await otherUsersRepository.create({
        email: `add-attempt-other-customer-${randomUUID()}@example.com`,
        passwordHash: 'hashed',
        firstName: 'Ola',
        lastName: 'Other',
        roleId: customerRole.id,
        emailVerificationTokenHash: 'token-hash',
        emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
      });
      const otherCart = await cartRepository.findOrCreateByCustomerId(otherCustomer.id);
      const sharedKey = randomUUID();

      const { created: mineCreated, attempt: mine } = await createAttempt({ productId: product.id, idempotencyKey: sharedKey });
      const { created: theirsCreated, attempt: theirs } = await createAttempt({
        productId: product.id,
        idempotencyKey: sharedKey,
        customerId: otherCustomer.id,
        cartId: otherCart.id,
      });

      expect(mineCreated).toBe(true);
      expect(theirsCreated).toBe(true); // no cross-customer collision
      expect(mine.id).not.toBe(theirs.id);

      await prisma.cartItemAddAttempt.deleteMany({ where: { cartId: otherCart.id } });
      await prisma.user.delete({ where: { id: otherCustomer.id } });
    });
  });

  describe('reclaimIfStale', () => {
    it('reclaims a stale PROCESSING row, incrementing attemptCount', async () => {
      const product = await createProduct('Reclaim Stale');
      const staleTime = new Date(Date.now() - 60_000);
      const { attempt } = await createAttempt({ productId: product.id, now: staleTime });
      await prisma.cartItemAddAttempt.update({ where: { id: attempt.id }, data: { updatedAt: staleTime } });

      const result = await repository.reclaimIfStale(attempt.id, 1, new Date(Date.now() - 15_000), new Date());

      expect(result.count).toBe(1);
      const row = await prisma.cartItemAddAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.attemptCount).toBe(2);
    });

    it('never reclaims a row whose updatedAt is within the staleness window', async () => {
      const product = await createProduct('Reclaim Fresh');
      const { attempt } = await createAttempt({ productId: product.id });

      const result = await repository.reclaimIfStale(attempt.id, 1, new Date(Date.now() - 15_000), new Date());

      expect(result.count).toBe(0);
    });

    it('never reclaims against a stale attemptCount (fenced)', async () => {
      const product = await createProduct('Reclaim Fenced');
      const staleTime = new Date(Date.now() - 60_000);
      const { attempt } = await createAttempt({ productId: product.id, now: staleTime });
      await prisma.cartItemAddAttempt.update({ where: { id: attempt.id }, data: { updatedAt: staleTime } });

      const result = await repository.reclaimIfStale(attempt.id, 999, new Date(Date.now() - 15_000), new Date());

      expect(result.count).toBe(0); // captured attemptCount no longer matches
    });
  });

  describe('completeIfCurrentAttempt / rejectIfCurrentAttempt fencing', () => {
    it('completes a matching PROCESSING attempt exactly once', async () => {
      const product = await createProduct('Complete Once');
      const { attempt } = await createAttempt({ productId: product.id });

      const result = await prisma.$transaction((tx) =>
        repository.completeIfCurrentAttempt(
          tx,
          attempt.id,
          1,
          { cartItemId: 'item-x', quantity: 1, mutationVersion: 0, generation: 0 },
          new Date(),
        ),
      );

      expect(result.count).toBe(1);
      const row = await prisma.cartItemAddAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.status).toBe('COMPLETED');
      expect(row.resultCartItemId).toBe('item-x');
    });

    it('a completion attempt against a stale attemptCount is fenced out (count 0)', async () => {
      const product = await createProduct('Complete Fenced');
      const { attempt } = await createAttempt({ productId: product.id });

      const result = await prisma.$transaction((tx) =>
        repository.completeIfCurrentAttempt(
          tx,
          attempt.id,
          2, // wrong - row is still at attemptCount 1
          { cartItemId: 'item-x', quantity: 1, mutationVersion: 0, generation: 0 },
          new Date(),
        ),
      );

      expect(result.count).toBe(0);
      const row = await prisma.cartItemAddAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.status).toBe('PROCESSING'); // untouched
    });

    it('rejects a matching PROCESSING attempt with a typed code and message', async () => {
      const product = await createProduct('Reject Once');
      const { attempt } = await createAttempt({ productId: product.id });

      const result = await repository.rejectIfCurrentAttempt(
        attempt.id,
        1,
        'QUANTITY_NOT_AVAILABLE',
        'Only 1 unit(s) of this product are currently available',
        new Date(),
      );

      expect(result.count).toBe(1);
      const row = await prisma.cartItemAddAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.status).toBe('REJECTED');
      expect(row.rejectionCode).toBe('QUANTITY_NOT_AVAILABLE');
      expect(row.rejectionMessage).toBe('Only 1 unit(s) of this product are currently available');
    });

    it('a reject attempt against a stale attemptCount is fenced out (count 0)', async () => {
      const product = await createProduct('Reject Fenced');
      const { attempt } = await createAttempt({ productId: product.id });

      const result = await repository.rejectIfCurrentAttempt(
        attempt.id,
        2,
        'QUANTITY_NOT_AVAILABLE',
        'stale rejection attempt',
        new Date(),
      );

      expect(result.count).toBe(0);
      const row = await prisma.cartItemAddAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.status).toBe('PROCESSING');
    });

    it('completeIfCurrentAttempt rolls back with the rest of its transaction on failure', async () => {
      const product = await createProduct('Complete Rollback');
      const { attempt } = await createAttempt({ productId: product.id });

      await expect(
        prisma.$transaction(async (tx) => {
          await repository.completeIfCurrentAttempt(
            tx,
            attempt.id,
            1,
            { cartItemId: 'item-x', quantity: 1, mutationVersion: 0, generation: 0 },
            new Date(),
          );
          throw new Error('simulated failure after completion write, before commit');
        }),
      ).rejects.toThrow('simulated failure after completion write, before commit');

      const row = await prisma.cartItemAddAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.status).toBe('PROCESSING'); // the completion write never survived
    });
  });
});
