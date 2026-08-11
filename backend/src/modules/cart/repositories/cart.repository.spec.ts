import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartRepository } from './cart.repository';

describe('CartRepository', () => {
  let prisma: PrismaService;
  let repository: CartRepository;
  let productId: string;
  let customerId: string;
  let vendorUserId: string;
  let category: Category;
  let vendor: Vendor;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new CartRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    const productsRepository = new ProductsRepository(prisma);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.CUSTOMER },
    });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });

    const customer = await usersRepository.create({
      email: `cart-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `cart-vendor-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Vera',
      lastName: 'Vendor',
      roleId: vendorRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    vendorUserId = vendorUser.id;

    vendor = await vendorsRepository.create({
      userId: vendorUserId,
      businessName: "Vera's Catch",
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });
    category = await categoriesRepository.create({
      name: `Cart Test Category ${randomUUID()}`,
      slug: `cart-test-category-${randomUUID()}`,
    });
    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Cart Test Snapper',
      description: 'A product used only for cart repository tests.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 20,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
    productId = product.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  it('creates an empty cart on first access and returns the same cart afterwards', async () => {
    const cart = await repository.findOrCreateByCustomerId(customerId);
    expect(cart.items).toHaveLength(0);

    const again = await repository.findOrCreateByCustomerId(customerId);
    expect(again.id).toBe(cart.id);
  });

  it('adds a new item and increments quantity on repeated adds', async () => {
    const cart = await repository.findOrCreateByCustomerId(customerId);

    await repository.addOrIncrementItem(cart.id, productId, 2);
    let updated = await repository.findOrCreateByCustomerId(customerId);
    expect(updated.items.find((item) => item.productId === productId)?.quantity).toBe(2);

    await repository.addOrIncrementItem(cart.id, productId, 3);
    updated = await repository.findOrCreateByCustomerId(customerId);
    expect(updated.items.find((item) => item.productId === productId)?.quantity).toBe(5);
  });

  it('sets an absolute quantity via updateItemQuantity', async () => {
    const cart = await repository.findOrCreateByCustomerId(customerId);
    const item = cart.items.find((candidate) => candidate.productId === productId)!;

    await repository.updateItemQuantity(item.id, 9);
    const updated = await repository.findOrCreateByCustomerId(customerId);
    expect(updated.items.find((candidate) => candidate.productId === productId)?.quantity).toBe(9);
  });

  it('finds an item by id scoped to its cart', async () => {
    const cart = await repository.findOrCreateByCustomerId(customerId);
    const item = cart.items[0]!;

    await expect(repository.findItemById(cart.id, item.id)).resolves.not.toBeNull();
    await expect(repository.findItemById(randomUUID(), item.id)).resolves.toBeNull();
  });

  it('finds an item by (cartId, productId) using the unique constraint', async () => {
    const cart = await repository.findOrCreateByCustomerId(customerId);

    await expect(repository.findItemByCartAndProduct(cart.id, productId)).resolves.toMatchObject({
      cartId: cart.id,
      productId,
    });
    await expect(repository.findItemByCartAndProduct(randomUUID(), productId)).resolves.toBeNull();
    await expect(repository.findItemByCartAndProduct(cart.id, randomUUID())).resolves.toBeNull();
  });

  it('removes an item', async () => {
    const cart = await repository.findOrCreateByCustomerId(customerId);
    const item = cart.items[0]!;

    await repository.removeItem(item.id);
    const updated = await repository.findOrCreateByCustomerId(customerId);
    expect(updated.items).toHaveLength(0);
  });

  it('clears all items in a cart', async () => {
    const cart = await repository.findOrCreateByCustomerId(customerId);
    await repository.addOrIncrementItem(cart.id, productId, 1);

    await repository.clear(cart.id);
    const updated = await repository.findOrCreateByCustomerId(customerId);
    expect(updated.items).toHaveLength(0);
  });

  it('finds a cart by id', async () => {
    const cart = await repository.findOrCreateByCustomerId(customerId);
    await expect(repository.findById(cart.id)).resolves.not.toBeNull();
    await expect(repository.findById(randomUUID())).resolves.toBeNull();
  });

  describe('establishCurrencyIfCompatible', () => {
    it('establishes currency on a null-currency cart', async () => {
      const cart = await repository.findOrCreateByCustomerId(customerId);
      expect(cart.currency).toBeNull();

      const { count } = await repository.establishCurrencyIfCompatible(cart.id, customerId, 'JMD');

      expect(count).toBe(1);
      await expect(repository.findById(cart.id)).resolves.toMatchObject({ currency: 'JMD' });
    });

    it('is a no-op match when the cart already has the same currency', async () => {
      const cart = await repository.findOrCreateByCustomerId(customerId);
      await repository.establishCurrencyIfCompatible(cart.id, customerId, 'JMD');

      const { count } = await repository.establishCurrencyIfCompatible(cart.id, customerId, 'JMD');

      expect(count).toBe(1);
    });

    it('matches zero rows on a genuine currency conflict', async () => {
      const cart = await repository.findOrCreateByCustomerId(customerId);
      await repository.establishCurrencyIfCompatible(cart.id, customerId, 'JMD');

      const { count } = await repository.establishCurrencyIfCompatible(cart.id, customerId, 'USD');

      expect(count).toBe(0);
      await expect(repository.findById(cart.id)).resolves.toMatchObject({ currency: 'JMD' });
    });

    it('matches zero rows for a customerId that does not own the cart', async () => {
      const cart = await repository.findOrCreateByCustomerId(customerId);

      const { count } = await repository.establishCurrencyIfCompatible(cart.id, randomUUID(), 'JMD');

      expect(count).toBe(0);
    });
  });

  // Phase 16A.0-DA, Unit DA.1A (see the DA.1 architecture review).
  describe('mutationVersion and compensation primitives', () => {
    it('starts a fresh insert at mutationVersion 0 and increments on every subsequent increment', async () => {
      const cart = await repository.findOrCreateByCustomerId(customerId);

      const created = await repository.addOrIncrementItem(cart.id, productId, 2);
      expect(created.mutationVersion).toBe(0);

      const incremented = await repository.addOrIncrementItem(cart.id, productId, 3);
      expect(incremented.mutationVersion).toBe(1);
      expect(incremented.quantity).toBe(5);

      await repository.removeItem(created.id);
    });

    it('increments mutationVersion on updateItemQuantity and returns the resulting row', async () => {
      const cart = await repository.findOrCreateByCustomerId(customerId);
      const created = await repository.addOrIncrementItem(cart.id, productId, 1);

      const updated = await repository.updateItemQuantity(created.id, 9);

      expect(updated.mutationVersion).toBe(1);
      expect(updated.quantity).toBe(9);

      await repository.removeItem(created.id);
    });

    it('removeItem returns the deleted row, quantity and mutationVersion intact', async () => {
      const cart = await repository.findOrCreateByCustomerId(customerId);
      const created = await repository.addOrIncrementItem(cart.id, productId, 4);

      const deleted = await repository.removeItem(created.id);

      expect(deleted.quantity).toBe(4);
      expect(deleted.mutationVersion).toBe(0);
      await expect(repository.findItemById(cart.id, created.id)).resolves.toBeNull();
    });

    describe('compensateItemQuantity', () => {
      it('reverts quantity and bumps mutationVersion when the guard matches', async () => {
        const cart = await repository.findOrCreateByCustomerId(customerId);
        const created = await repository.addOrIncrementItem(cart.id, productId, 5);
        const updated = await repository.updateItemQuantity(created.id, 8);

        const { count } = await repository.compensateItemQuantity(cart.id, productId, updated.mutationVersion, 5);

        expect(count).toBe(1);
        const reverted = await repository.findItemByCartAndProduct(cart.id, productId);
        expect(reverted?.quantity).toBe(5);
        expect(reverted?.mutationVersion).toBe(updated.mutationVersion + 1);

        await repository.removeItem(created.id);
      });

      it('misses when the guard no longer matches the current version', async () => {
        const cart = await repository.findOrCreateByCustomerId(customerId);
        const created = await repository.addOrIncrementItem(cart.id, productId, 5);
        await repository.updateItemQuantity(created.id, 8);

        // Stale guard: the row has since moved to mutationVersion 1, not 0.
        const { count } = await repository.compensateItemQuantity(cart.id, productId, 0, 5);

        expect(count).toBe(0);
        const unchanged = await repository.findItemByCartAndProduct(cart.id, productId);
        expect(unchanged?.quantity).toBe(8);

        await repository.removeItem(created.id);
      });

      // Proves the exact ABA scenario a quantity-only guard would have been
      // vulnerable to: quantity cycles 1 -> 2 -> 3 -> 2 across three
      // genuinely different writers, so a WHERE quantity = 2 guard would
      // incorrectly match writer A's stale expectation even though writer
      // C, not A, produced the current row. mutationVersion never repeats
      // a value across distinct writes, so the same guard correctly misses.
      it('never lets a stale writer\'s guard match a value another writer produced later (ABA reproduction)', async () => {
        const cart = await repository.findOrCreateByCustomerId(customerId);
        const created = await repository.addOrIncrementItem(cart.id, productId, 1); // quantity 1, version 0

        const afterA = await repository.updateItemQuantity(created.id, 2); // writer A: 1 -> 2, version 1
        await repository.updateItemQuantity(created.id, 3); // writer B: 2 -> 3, version 2
        const afterC = await repository.updateItemQuantity(created.id, 2); // writer C: 3 -> 2, version 3

        // A quantity-only guard here would incorrectly believe its own
        // write (which produced quantity 2 at version 1) is still current,
        // since the row's quantity is 2 again - but it is C's row, not A's.
        expect(afterC.quantity).toBe(afterA.quantity);
        expect(afterC.mutationVersion).not.toBe(afterA.mutationVersion);

        // A's own compensation attempt, guarded on the version IT observed
        // (1), correctly misses - it must never revert C's genuinely newer
        // write just because the quantity happens to match.
        const { count } = await repository.compensateItemQuantity(
          cart.id,
          productId,
          afterA.mutationVersion,
          1,
        );
        expect(count).toBe(0);
        const stillCurrent = await repository.findItemByCartAndProduct(cart.id, productId);
        expect(stillCurrent?.quantity).toBe(2);
        expect(stillCurrent?.mutationVersion).toBe(afterC.mutationVersion);

        await repository.removeItem(created.id);
      });
    });

    describe('compensateItemDeleteIfUnchanged', () => {
      it('deletes a fresh insert when the guard matches', async () => {
        const cart = await repository.findOrCreateByCustomerId(customerId);
        const created = await repository.addOrIncrementItem(cart.id, productId, 2);

        const { count } = await repository.compensateItemDeleteIfUnchanged(cart.id, productId, created.mutationVersion);

        expect(count).toBe(1);
        await expect(repository.findItemByCartAndProduct(cart.id, productId)).resolves.toBeNull();
      });

      it('misses when a concurrent mutation already changed the row (real Postgres race)', async () => {
        const cart = await repository.findOrCreateByCustomerId(customerId);
        const created = await repository.addOrIncrementItem(cart.id, productId, 2);

        // A second, concurrent request incremented the same fresh row
        // before the first request's own compensation attempt ran.
        await repository.addOrIncrementItem(cart.id, productId, 3);

        const { count } = await repository.compensateItemDeleteIfUnchanged(cart.id, productId, created.mutationVersion);

        expect(count).toBe(0);
        const stillPresent = await repository.findItemByCartAndProduct(cart.id, productId);
        expect(stillPresent?.quantity).toBe(5);

        await repository.removeItem(stillPresent!.id);
      });
    });

    describe('compensateItemRestore', () => {
      it('recreates a removed item at its pre-deletion quantity', async () => {
        const cart = await repository.findOrCreateByCustomerId(customerId);
        const created = await repository.addOrIncrementItem(cart.id, productId, 6);
        await repository.removeItem(created.id);

        const { restored, item } = await repository.compensateItemRestore(cart.id, productId, 6);

        expect(restored).toBe(true);
        expect(item?.quantity).toBe(6);
        expect(item?.mutationVersion).toBe(0);

        await repository.removeItem(item!.id);
      });

      it('misses (P2002) when another request already re-added the same product (real Postgres race)', async () => {
        const cart = await repository.findOrCreateByCustomerId(customerId);
        const created = await repository.addOrIncrementItem(cart.id, productId, 6);
        await repository.removeItem(created.id);

        // A second, concurrent request already re-added the product before
        // the first request's own restore-compensation attempt ran.
        const reAdded = await repository.addOrIncrementItem(cart.id, productId, 9);

        const { restored, item } = await repository.compensateItemRestore(cart.id, productId, 6);

        expect(restored).toBe(false);
        expect(item).toBeNull();
        const current = await repository.findItemByCartAndProduct(cart.id, productId);
        expect(current?.quantity).toBe(9);

        await repository.removeItem(reAdded.id);
      });
    });
  });
});
