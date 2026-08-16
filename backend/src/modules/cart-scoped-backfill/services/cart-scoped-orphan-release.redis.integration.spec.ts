import { randomUUID } from 'crypto';

import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { connectRealRedis } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartScopedOrphanReleaseService } from './cart-scoped-orphan-release.service';

// CART_SCOPED activation-boundary gate (see the gate design review's final
// approved design). Real-Postgres+Redis proof that a stale cart-scoped
// reservation - one with no corresponding positive CartItem - is
// discovered and released, while a genuine positive-CartItem-backed
// reservation is left completely untouched. A positive-item-only backfill
// is insufficient exactly for the case this proves: a leftover hold for a
// deleted/reduced item would otherwise survive cutover.
const ISOLATED_DB_INDEX = 9;

jest.setTimeout(20_000);

describe('CartScopedOrphanReleaseService.discoverAndReleaseOrphans (real Postgres + Redis)', () => {
  let prisma: PrismaService;
  let client: Redis;
  let cartRepository: CartRepository;
  let inventoryReservations: InventoryReservationsService;
  let service: CartScopedOrphanReleaseService;
  let customerId: string;
  let vendorUserId: string;
  let productId: string;
  let categoryId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    client = await connectRealRedis();
    await client.select(ISOLATED_DB_INDEX);
    await client.flushdb();

    cartRepository = new CartRepository(prisma);
    inventoryReservations = new InventoryReservationsService(new RedisService(client));
    service = new CartScopedOrphanReleaseService(new RedisService(client), cartRepository, inventoryReservations);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    const productsRepository = new ProductsRepository(prisma);

    const customerRole = await prisma.role.findUniqueOrThrow({ where: { name: 'CUSTOMER' } });
    const vendorRole = await prisma.role.findUniqueOrThrow({ where: { name: 'VENDOR' } });

    const customer = await usersRepository.create({
      email: `orphan-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Orin',
      lastName: 'Orphan',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;
    const vendorUser = await usersRepository.create({
      email: `orphan-vendor-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Vera',
      lastName: 'Vendor',
      roleId: vendorRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    vendorUserId = vendorUser.id;
    const vendor = await vendorsRepository.create({
      userId: vendorUserId,
      businessName: "Orin's Catch",
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });
    await prisma.vendor.update({ where: { id: vendor.id }, data: { status: 'APPROVED' } });
    const category = await categoriesRepository.create({
      name: `Orphan Test Category ${randomUUID()}`,
      slug: `orphan-test-category-${randomUUID()}`,
    });
    categoryId = category.id;
    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId,
      name: 'Orphan Test Snapper',
      description: 'Used only for orphan-release tests.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 50,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
    productId = product.id;
  });

  afterAll(async () => {
    await client.flushdb();
    await client.quit();
    await prisma.cartItem.deleteMany({ where: { productId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.category.delete({ where: { id: categoryId } });
    await prisma.onModuleDestroy();
  });

  it('releases a cart-scoped reservation with no corresponding positive CartItem, and leaves a genuine one untouched', async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);

    // Genuine target: a real CartItem AND a matching cart-scoped hold.
    await cartRepository.addOrIncrementItem(cart.id, productId, 5);
    await inventoryReservations.reserveOrRenew(cart.id, productId, customerId, 5);

    // Orphan: a cart-scoped hold for a DIFFERENT cart with no CartItem at all.
    const orphanCartId = randomUUID();
    await inventoryReservations.reserveOrRenew(orphanCartId, productId, customerId, 3);

    const outcomes = await service.discoverAndReleaseOrphans();

    const orphanOutcome = outcomes.find((o) => o.cartId === orphanCartId && o.productId === productId);
    expect(orphanOutcome).toEqual({ cartId: orphanCartId, productId, released: true });

    const orphanEntry = await inventoryReservations.getActiveReservation(orphanCartId, productId);
    expect(orphanEntry).toBeNull();

    const genuineEntry = await inventoryReservations.getActiveReservation(cart.id, productId);
    expect(genuineEntry?.quantity).toBe(5);

    await inventoryReservations.releaseReservation(cart.id, productId);
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id, productId } });
  });

  it('releases an orphan left behind by a reduced (not deleted) CartItem quantity going to zero via removal', async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    const item = await cartRepository.addOrIncrementItem(cart.id, productId, 4);
    await inventoryReservations.reserveOrRenew(cart.id, productId, customerId, 4);

    // The item is removed (durable truth now says zero), but the
    // cart-scoped hold was never cleaned up - exactly the scenario a
    // positive-item-only backfill would miss.
    await prisma.cartItem.delete({ where: { id: item.id } });

    const outcomes = await service.discoverAndReleaseOrphans();

    const outcome = outcomes.find((o) => o.cartId === cart.id && o.productId === productId);
    expect(outcome).toEqual({ cartId: cart.id, productId, released: true });
    const entry = await inventoryReservations.getActiveReservation(cart.id, productId);
    expect(entry).toBeNull();
  });
});
