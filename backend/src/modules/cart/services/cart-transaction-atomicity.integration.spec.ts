import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CartMutationBarrierConfigRepository } from '../../cart-mutation-barrier/repositories/cart-mutation-barrier-config.repository';
import { CartMutationBarrierService } from '../../cart-mutation-barrier/services/cart-mutation-barrier.service';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { buildLegacyReservationGateway } from '../../checkout-reservation/services/checkout-reservation-facade-test-helpers';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartRepository } from '../repositories/cart.repository';
import { CartItemAddAttemptRepository } from '../repositories/cart-item-add-attempt.repository';
import { CartItemAddIdempotencyService } from './cart-item-add-idempotency.service';
import { CartReservationConvergenceService } from './cart-reservation-convergence.service';
import { CartService } from './cart.service';

// Phase 16A.0-DA, Unit DA.1A (see the DA.1 architecture review). Proves the
// transaction boundary itself against real Postgres: the CartItem mutation
// and the CartReservationSyncState marker write must commit or roll back
// together, never independently. Every other DA.1A behavior (compensation
// branching, Redis convergence) is already covered by cart.service.spec.ts
// with mocked repositories - this file exists solely to prove the one
// property a mock cannot: real transactional atomicity.
describe('CartService transaction atomicity (real Postgres)', () => {
  let prisma: PrismaService;
  let cartRepository: CartRepository;
  let syncStateRepository: CartReservationSyncStateRepository;
  let service: CartService;
  let productId: string;
  let customerId: string;
  let vendorUserId: string;
  let category: Category;
  let vendor: Vendor;

  const inventoryReservations: jest.Mocked<
    Pick<InventoryReservationsService, 'getReservedByOthers' | 'reserve' | 'release'>
  > = {
    getReservedByOthers: jest.fn().mockResolvedValue(0),
    reserve: jest.fn().mockResolvedValue(undefined),
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
      email: `cart-tx-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Tara',
      lastName: 'Transaction',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `cart-tx-vendor-${randomUUID()}@example.com`,
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
    // Vendor.status defaults to PENDING in the schema - approve explicitly
    // so assertProductIsPurchasable's vendor-approval check passes.
    await prisma.vendor.update({ where: { id: vendor.id }, data: { status: 'APPROVED' } });
    category = await categoriesRepository.create({
      name: `Cart TX Test Category ${randomUUID()}`,
      slug: `cart-tx-test-category-${randomUUID()}`,
    });
    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Cart TX Test Snapper',
      description: 'A product used only for the transaction-atomicity test.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 20,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
    productId = product.id;

    const gateway = buildLegacyReservationGateway(inventoryReservations as unknown as InventoryReservationsService);
    const convergence = new CartReservationConvergenceService(prisma, cartRepository, gateway, syncStateRepository);
    const idempotency = new CartItemAddIdempotencyService(new CartItemAddAttemptRepository(prisma));
    const mutationBarrier = new CartMutationBarrierService(prisma, new CartMutationBarrierConfigRepository(prisma));
    service = new CartService(
      prisma,
      cartRepository,
      productsRepository,
      vendorsRepository,
      gateway,
      syncStateRepository,
      convergence,
      idempotency,
      mutationBarrier,
    );
  });

  afterAll(async () => {
    // CartReservationSyncState/CartItemAddAttempt rows are never deleted
    // (generation/attempt history must be permanent) and use onDelete:
    // Restrict on their Cart/Product relations, so they must be cleared
    // explicitly before the owning user/cart can be deleted.
    await prisma.cartItemAddAttempt.deleteMany({ where: { productId } });
    await prisma.cartReservationSyncState.deleteMany({ where: { productId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  it('rolls back the CartItem mutation when the marker write in the same transaction fails', async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);

    const spy = jest
      .spyOn(syncStateRepository, 'upsertDesiredState')
      .mockRejectedValueOnce(new Error('simulated marker write failure'));

    await expect(service.addItem(customerId, { productId, quantity: 2 }, randomUUID())).rejects.toThrow(
      'simulated marker write failure',
    );
    spy.mockRestore();

    // The CartItem mutation must not have persisted - it was in the same
    // transaction as the failed marker write.
    const item = await cartRepository.findItemByCartAndProduct(cart.id, productId);
    expect(item).toBeNull();

    // Redis was never reached at all - the transaction failed before
    // convergeReservation's own Redis call.
    expect(inventoryReservations.reserve).not.toHaveBeenCalled();
  });

  it('commits both the CartItem mutation and the marker together on the ordinary success path', async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);

    await service.addItem(customerId, { productId, quantity: 3 }, randomUUID());

    const item = await cartRepository.findItemByCartAndProduct(cart.id, productId);
    expect(item?.quantity).toBe(3);
    // A successful Redis reserve resolves the marker (sets resolvedAt; the
    // row is never deleted - see the DA.1 architecture review's
    // concurrency-proof correction) - confirming it really was written
    // durably as part of the same transaction that created the CartItem,
    // not skipped.
    const marker = await syncStateRepository.findByCartAndProduct(cart.id, productId);
    expect(marker).not.toBeNull();
    expect(marker?.resolvedAt).not.toBeNull();

    await cartRepository.removeItem(item!.id);
  });
});
