import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { CartItemAddAttemptRepository } from '../../cart/repositories/cart-item-add-attempt.repository';
import { CartItemAddIdempotencyService } from '../../cart/services/cart-item-add-idempotency.service';
import { CartReservationConvergenceService } from '../../cart/services/cart-reservation-convergence.service';
import { CartService } from '../../cart/services/cart.service';
import { buildLegacyReservationGateway } from '../../checkout-reservation/services/checkout-reservation-facade-test-helpers';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartReservationSyncStateRepository } from './cart-reservation-sync-state.repository';

// Phase 16A.0-DA, Unit DA.1B FINAL REVIEW - checkout-clear correction.
// Focused, isolated real-Postgres tests for advanceForClearedCart, proving
// the property the OrdersService-level checkout-clear regression exercises
// end-to-end (Section 11 of the DA.1B final review: "do not rely only on
// the coordinator race test"). advanceForClearedCart itself only ever
// touches CartReservationSyncState; every test here pairs it with
// CartRepository.clear() inside one manually-controlled transaction,
// mirroring exactly how OrdersService.createOrderInTransaction uses both
// together (CartItem-then-marker order).
describe('CartReservationSyncStateRepository.advanceForClearedCart (real Postgres)', () => {
  let prisma: PrismaService;
  let repository: CartReservationSyncStateRepository;
  let cartRepository: CartRepository;
  let cartService: CartService;
  let productsRepository: ProductsRepository;
  let vendorId: string;
  let categoryId: string;
  let customerId: string;
  let vendorUserId: string;
  let category: Category;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new CartReservationSyncStateRepository(prisma);
    cartRepository = new CartRepository(prisma);
    productsRepository = new ProductsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });

    const customer = await usersRepository.create({
      email: `sync-clear-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Clear',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `sync-clear-vendor-${randomUUID()}@example.com`,
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
      name: `Sync Clear Test Category ${randomUUID()}`,
      slug: `sync-clear-test-category-${randomUUID()}`,
    });
    categoryId = category.id;

    const inventoryReservations = {
      getReservedByOthers: jest.fn().mockResolvedValue(0),
      reserve: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    } as unknown as InventoryReservationsService;
    const gateway = buildLegacyReservationGateway(inventoryReservations);
    const convergence = new CartReservationConvergenceService(prisma, cartRepository, gateway, repository);
    const idempotency = new CartItemAddIdempotencyService(new CartItemAddAttemptRepository(prisma));
    cartService = new CartService(
      prisma,
      cartRepository,
      productsRepository,
      vendorsRepository,
      gateway,
      repository,
      convergence,
      idempotency,
    );
  });

  afterAll(async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    await prisma.cartItemAddAttempt.deleteMany({ where: { cartId: cart.id } });
    await prisma.cartReservationSyncState.deleteMany({ where: { cartId: cart.id } });
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
      description: 'A product used only for one advanceForClearedCart test case.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 50,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
  }

  it('A: a single CartItem - marker generation advances exactly once and the row is deleted', async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    const product = await createProduct('Clear Single');
    await cartService.addItem(customerId, { productId: product.id, quantity: 3 }, randomUUID());
    const item = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
    const markerBefore = await repository.findByCartAndProduct(cart.id, product.id);

    await prisma.$transaction(async (tx) => {
      await cartRepository.clear(cart.id, tx);
      await repository.advanceForClearedCart(cart.id, [{ productId: product.id, mutationVersion: item!.mutationVersion }], tx);
    });

    const finalItem = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
    expect(finalItem).toBeNull();
    const finalMarker = await repository.findByCartAndProduct(cart.id, product.id);
    expect(finalMarker?.generation).toBe(markerBefore!.generation + 1);
    expect(finalMarker?.expectedQuantity).toBeNull();
    expect(finalMarker?.resolvedAt).toBeNull();
  });

  it('B: multiple CartItems - each pair gets its own generation advance and all rows are deleted', async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    const products = await Promise.all([1, 2, 3].map((n) => createProduct(`Clear Multi ${n}`)));
    for (const [index, product] of products.entries()) {
      await cartService.addItem(customerId, { productId: product.id, quantity: index + 1 }, randomUUID());
    }
    const items = await Promise.all(
      products.map(async (product) => {
        const item = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
        return { productId: product.id, mutationVersion: item!.mutationVersion };
      }),
    );
    const markersBefore = await Promise.all(
      products.map((product) => repository.findByCartAndProduct(cart.id, product.id)),
    );

    await prisma.$transaction(async (tx) => {
      await cartRepository.clear(cart.id, tx);
      await repository.advanceForClearedCart(cart.id, items, tx);
    });

    for (const [index, product] of products.entries()) {
      const finalItem = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      expect(finalItem).toBeNull();
      const finalMarker = await repository.findByCartAndProduct(cart.id, product.id);
      expect(finalMarker?.generation).toBe(markersBefore[index]!.generation + 1);
      expect(finalMarker?.resolvedAt).toBeNull();
    }
  });

  it('C: an existing marker with a non-zero generation increments rather than resetting', async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    const product = await createProduct('Clear Existing Generation');
    await cartService.addItem(customerId, { productId: product.id, quantity: 1 }, randomUUID());
    const item1 = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
    await cartService.updateItemQuantity(customerId, item1!.id, { quantity: 5 }); // advances generation again
    const item2 = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
    const markerBefore = await repository.findByCartAndProduct(cart.id, product.id);
    expect(markerBefore!.generation).toBeGreaterThan(0);

    await prisma.$transaction(async (tx) => {
      await cartRepository.clear(cart.id, tx);
      await repository.advanceForClearedCart(cart.id, [{ productId: product.id, mutationVersion: item2!.mutationVersion }], tx);
    });

    const finalMarker = await repository.findByCartAndProduct(cart.id, product.id);
    expect(finalMarker?.generation).toBe(markerBefore!.generation + 1); // increments, never resets to 0/1
  });

  it('D: a CartItem with no existing marker gets one created with the correct absent desired state', async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    const product = await createProduct('Clear Missing Marker');
    // Deliberately bypass CartService: create the CartItem directly,
    // without ever writing a marker - an edge case that should never
    // happen via the real primary-mutation paths (they always pair the
    // write), but advanceForClearedCart/upsertDesiredState's create
    // branch must still behave correctly if it ever does.
    const item = await cartRepository.addOrIncrementItem(cart.id, product.id, 2);
    expect(await repository.findByCartAndProduct(cart.id, product.id)).toBeNull();

    await prisma.$transaction(async (tx) => {
      await cartRepository.clear(cart.id, tx);
      await repository.advanceForClearedCart(cart.id, [{ productId: product.id, mutationVersion: item.mutationVersion }], tx);
    });

    const finalMarker = await repository.findByCartAndProduct(cart.id, product.id);
    expect(finalMarker?.generation).toBe(0); // a fresh create starts at the schema default
    expect(finalMarker?.expectedQuantity).toBeNull();
    expect(finalMarker?.resolvedAt).toBeNull();
  });

  it('E: transaction rollback - neither the marker advance nor the CartItem delete survives', async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    const product = await createProduct('Clear Rollback');
    await cartService.addItem(customerId, { productId: product.id, quantity: 6 }, randomUUID());
    const item = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
    const markerBefore = await repository.findByCartAndProduct(cart.id, product.id);

    await expect(
      prisma.$transaction(async (tx) => {
        await cartRepository.clear(cart.id, tx);
        await repository.advanceForClearedCart(cart.id, [{ productId: product.id, mutationVersion: item!.mutationVersion }], tx);
        throw new Error('simulated failure after both writes, before commit');
      }),
    ).rejects.toThrow('simulated failure after both writes, before commit');

    const finalItem = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
    expect(finalItem?.id).toBe(item!.id);
    expect(finalItem?.quantity).toBe(6);
    const finalMarker = await repository.findByCartAndProduct(cart.id, product.id);
    expect(finalMarker?.generation).toBe(markerBefore!.generation);
    expect(finalMarker?.resolvedAt?.getTime()).toBe(markerBefore!.resolvedAt?.getTime());

    await cartService.removeItem(customerId, finalItem!.id);
  });
});
