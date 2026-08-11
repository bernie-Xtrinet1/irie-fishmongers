import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartRepository } from '../repositories/cart.repository';
import { CartService } from './cart.service';

// Phase 16A.0-DA, Unit DA.1A (see the DA.1 architecture review's
// concurrency-proof correction / Review #2, Section 7 - "resolve lock
// order before freezing DA.1A"). applyCompensation now attempts the
// CartItem-level write BEFORE the marker-generation gate, deliberately
// matching the primary-mutation path's own lock order (CartItem row, then
// marker row - see cart.service.ts). This proves that ordering against
// real Postgres row locking: a primary mutation and a compensation
// contending for the SAME CartItem row must serialize (one blocks on the
// row lock the other already holds) rather than deadlock (which would
// require them to acquire the two resources in OPPOSITE orders). No
// business logic here depends on which one "wins" the race - only that
// neither is ever killed by Postgres's deadlock detector (error P2034).
describe('CartService primary-vs-compensation lock order (real Postgres)', () => {
  let prisma: PrismaService;
  let cartRepository: CartRepository;
  let syncStateRepository: CartReservationSyncStateRepository;
  let service: CartService;
  let productId: string;
  let customerId: string;
  let vendorUserId: string;
  let category: Category;

  const inventoryReservations: jest.Mocked<
    Pick<InventoryReservationsService, 'getAvailableToPurchase' | 'reserve' | 'release'>
  > = {
    getAvailableToPurchase: jest.fn().mockResolvedValue(999),
    reserve: jest.fn(),
    release: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    cartRepository = new CartRepository(prisma);
    syncStateRepository = new CartReservationSyncStateRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    const productsRepository = new ProductsRepository(prisma);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });

    const customer = await usersRepository.create({
      email: `cart-lock-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Lena',
      lastName: 'Lock',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `cart-lock-vendor-${randomUUID()}@example.com`,
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
    category = await categoriesRepository.create({
      name: `Cart Lock Test Category ${randomUUID()}`,
      slug: `cart-lock-test-category-${randomUUID()}`,
    });
    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Cart Lock Test Snapper',
      description: 'A product used only for the primary-vs-compensation lock-order test.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 50,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
    productId = product.id;

    service = new CartService(
      prisma,
      cartRepository,
      productsRepository,
      vendorsRepository,
      inventoryReservations as unknown as InventoryReservationsService,
      syncStateRepository,
    );
  });

  afterAll(async () => {
    await prisma.cartReservationSyncState.deleteMany({ where: { productId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  it(
    'a primary mutation and a compensation contending for the same CartItem row serialize instead of deadlocking',
    async () => {
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);
      inventoryReservations.reserve.mockResolvedValueOnce(undefined); // setup addItem succeeds
      await service.addItem(customerId, { productId, quantity: 5 });
      const item = await cartRepository.findItemByCartAndProduct(cart.id, productId);

      // Delay the compensation transaction's marker-generation gate call -
      // by the time this is entered, applyCartItemCompensation has already
      // executed its CartItem UPDATE within the same still-open
      // transaction, so the CartItem row lock is already held.
      const realAdvance = syncStateRepository.advanceIfCurrentGeneration.bind(syncStateRepository);
      let gateReached = false;
      let releaseCompensation!: () => void;
      const compensationBlocked = new Promise<void>((resolveBlocked) => {
        jest
          .spyOn(syncStateRepository, 'advanceIfCurrentGeneration')
          .mockImplementation(async (cartId, prodId, expectedGeneration, newVersion, newQuantity, client) => {
            if (!gateReached) {
              gateReached = true;
              resolveBlocked();
              await new Promise<void>((resolve) => {
                releaseCompensation = resolve;
              });
            }
            return realAdvance(cartId, prodId, expectedGeneration, newVersion, newQuantity, client);
          });
      });

      // Mutation A: updateItemQuantity whose own reserve() call fails,
      // forcing applyCompensation - it holds the CartItem row lock the
      // moment its transaction's CartItem write executes, then blocks at
      // the spy above before ever reaching the marker.
      inventoryReservations.reserve.mockRejectedValueOnce(new Error('redis down'));
      const mutationA = service.updateItemQuantity(customerId, item!.id, { quantity: 10 });
      await compensationBlocked;

      // Mutation B: an independent primary updateItemQuantity on the SAME
      // CartItem row, started while A's compensation transaction is still
      // open and holding that row's lock. If the two paths acquired
      // CartItem/marker locks in opposite orders, this is exactly the
      // shape of a deadlock; because both now acquire CartItem first, B
      // instead simply blocks on the row lock A already holds.
      inventoryReservations.reserve.mockResolvedValueOnce(undefined);
      let bSettled = false;
      const mutationB = service
        .updateItemQuantity(customerId, item!.id, { quantity: 20 })
        .finally(() => {
          bSettled = true;
        });

      // Confirm B is genuinely blocked (real row-lock contention, not a
      // coincidence of async scheduling) before letting A proceed.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(bSettled).toBe(false);

      releaseCompensation();

      try {
        await Promise.all([mutationA, mutationB]);
      } catch (error) {
        throw new Error(
          `Expected the primary and compensation transactions to serialize without a Postgres deadlock, but one rejected: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      // B committed last (it was blocked behind A), so its unconditional
      // write is the final durable CartItem state.
      const finalItem = await cartRepository.findItemByCartAndProduct(cart.id, productId);
      expect(finalItem?.quantity).toBe(20);
      const marker = await syncStateRepository.findByCartAndProduct(cart.id, productId);
      expect(marker?.expectedQuantity).toBe(20);
      expect(marker?.resolvedAt).not.toBeNull();

      await service.removeItem(customerId, finalItem!.id);
    },
    15_000,
  );
});
