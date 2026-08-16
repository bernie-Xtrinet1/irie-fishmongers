import { randomUUID } from 'crypto';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { CartItemAddAttemptRepository } from '../../cart/repositories/cart-item-add-attempt.repository';
import { CartItemAddIdempotencyService } from '../../cart/services/cart-item-add-idempotency.service';
import { CartReservationConvergenceService } from '../../cart/services/cart-reservation-convergence.service';
import { CartService } from '../../cart/services/cart.service';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { buildLegacyReservationGateway } from '../../checkout-reservation/services/checkout-reservation-facade-test-helpers';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { OrdersService } from '../../orders/services/orders.service';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartMutationBarrierConfigRepository } from '../repositories/cart-mutation-barrier-config.repository';
import { CartMutationBarrierService } from './cart-mutation-barrier.service';

// CART_SCOPED activation-boundary gate (see the gate design review's final
// approved design). Shared real-Postgres fixture for the four-entry-point
// barrier-blocking and race proofs - mirrors cart-service-lock-order
// integration.spec.ts's own established boilerplate pattern exactly.
// InventoryReservationsService is never mocked away: reserve/release are
// real, unconditioned Redis primitives, and only a real client proves
// what actually lands (matching every DA.1A/DA.1B concurrency-proof
// precedent).
export interface BarrierFixture {
  prisma: PrismaService;
  cartRepository: CartRepository;
  syncStateRepository: CartReservationSyncStateRepository;
  cartService: CartService;
  ordersService: OrdersService;
  mutationBarrier: CartMutationBarrierService;
  mutationBarrierRepository: CartMutationBarrierConfigRepository;
  paymentsService: { initiatePayment: jest.Mock; getByOrderId: jest.Mock };
  productId: string;
  customerId: string;
  vendorUserId: string;
  adminUserId: string;
  category: Category;
}

export async function setUpBarrierFixture(label: string): Promise<BarrierFixture> {
  const prisma = new PrismaService();
  await prisma.onModuleInit();

  const cartRepository = new CartRepository(prisma);
  const syncStateRepository = new CartReservationSyncStateRepository(prisma);
  const usersRepository = new UsersRepository(prisma);
  const vendorsRepository = new VendorsRepository(prisma);
  const categoriesRepository = new CategoriesRepository(prisma);
  const productsRepository = new ProductsRepository(prisma);

  const customerRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
  const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });
  const adminRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.ADMINISTRATOR } });

  const customer = await usersRepository.create({
    email: `barrier-${label}-customer-${randomUUID()}@example.com`,
    passwordHash: 'hashed',
    firstName: 'Bea',
    lastName: 'Barrier',
    roleId: customerRole.id,
    emailVerificationTokenHash: 'token-hash',
    emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
  });
  const vendorUser = await usersRepository.create({
    email: `barrier-${label}-vendor-${randomUUID()}@example.com`,
    passwordHash: 'hashed',
    firstName: 'Vera',
    lastName: 'Vendor',
    roleId: vendorRole.id,
    emailVerificationTokenHash: 'token-hash',
    emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
  });
  const adminUser = await usersRepository.create({
    email: `barrier-${label}-admin-${randomUUID()}@example.com`,
    passwordHash: 'hashed',
    firstName: 'Ann',
    lastName: 'Admin',
    roleId: adminRole.id,
    emailVerificationTokenHash: 'token-hash',
    emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
  });

  const vendor: Vendor = await vendorsRepository.create({
    userId: vendorUser.id,
    businessName: "Vera's Catch",
    parish: 'KINGSTON',
    termsAcceptedAt: new Date(),
  });
  await prisma.vendor.update({ where: { id: vendor.id }, data: { status: 'APPROVED' } });
  const category = await categoriesRepository.create({
    name: `Barrier Test Category ${label} ${randomUUID()}`,
    slug: `barrier-test-category-${label}-${randomUUID()}`,
  });
  const product = await productsRepository.create({
    vendorId: vendor.id,
    categoryId: category.id,
    name: `Barrier Test Snapper ${label}`,
    description: 'A product used only for CART_SCOPED activation-boundary gate tests.',
    unit: 'PER_POUND',
    price: 500,
    quantityAvailable: 50,
    imageUrl: 'https://cdn.example.com/snapper.jpg',
  });

  const inventoryReservations = {
    getReservedByOthers: jest.fn().mockResolvedValue(0),
    reserve: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  } as unknown as InventoryReservationsService;
  const gateway = buildLegacyReservationGateway(inventoryReservations);
  const convergence = new CartReservationConvergenceService(prisma, cartRepository, gateway, syncStateRepository);
  const idempotency = new CartItemAddIdempotencyService(new CartItemAddAttemptRepository(prisma));
  const mutationBarrierRepository = new CartMutationBarrierConfigRepository(prisma);
  const mutationBarrier = new CartMutationBarrierService(prisma, mutationBarrierRepository);

  const cartService = new CartService(
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

  const paymentsService = {
    initiatePayment: jest.fn().mockResolvedValue({ payment: { id: 'payment-1' }, redirectUrl: undefined }),
    getByOrderId: jest.fn().mockResolvedValue(null),
  };
  const vendorPermissionsService = { assertSalesLimitNotExceeded: jest.fn().mockResolvedValue(undefined) };
  const ordersService = new OrdersService(
    prisma,
    new OrdersRepository(prisma),
    new VendorOrdersRepository(prisma),
    cartRepository,
    productsRepository,
    vendorsRepository,
    paymentsService as never,
    vendorPermissionsService as never,
    new InventoryEventsRepository(prisma),
    inventoryReservations,
    new EventEmitter2(),
    syncStateRepository,
    mutationBarrier,
  );

  return {
    prisma,
    cartRepository,
    syncStateRepository,
    cartService,
    ordersService,
    mutationBarrier,
    mutationBarrierRepository,
    paymentsService,
    productId: product.id,
    customerId: customer.id,
    vendorUserId: vendorUser.id,
    adminUserId: adminUser.id,
    category,
  };
}

// Resets the shared fixture's single CartItem back to absent - every test
// in a file using this fixture shares ONE customer/product pair (matching
// this codebase's established single-fixture-per-file convention), so
// addOrIncrementItem's own increment semantics would otherwise accumulate
// quantity across tests. Must be called only while the barrier is
// INACTIVE (never from inside a test whose own barrier is still active -
// that call would itself be rejected).
export async function resetCartItem(fixture: BarrierFixture): Promise<void> {
  const cart = await fixture.cartRepository.findOrCreateByCustomerId(fixture.customerId);
  await fixture.prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
}

export async function tearDownBarrierFixture(fixture: BarrierFixture): Promise<void> {
  const cart = await fixture.cartRepository.findOrCreateByCustomerId(fixture.customerId);
  await fixture.prisma.orderItem.deleteMany({ where: { vendorOrder: { order: { customerId: fixture.customerId } } } });
  await fixture.prisma.vendorOrder.deleteMany({ where: { order: { customerId: fixture.customerId } } });
  await fixture.prisma.order.deleteMany({ where: { customerId: fixture.customerId } });
  await fixture.prisma.cartItemAddAttempt.deleteMany({ where: { cartId: cart.id } });
  await fixture.prisma.cartReservationSyncState.deleteMany({ where: { cartId: cart.id } });
  await fixture.prisma.cartReservationCompensation.deleteMany({ where: { cartId: cart.id } });
  await fixture.prisma.cartMutationBarrierConfig.deleteMany({ where: { activatedById: fixture.adminUserId } });
  // A successful checkout in this fixture writes a real InventoryEvent row
  // for the product - InventoryEvent.productId is Restrict, so it blocks
  // the vendor-user-cascade Product deletion below unless cleared first
  // (same precedent as the DA.1B checkout-clear integration spec's own
  // teardown).
  await fixture.prisma.inventoryEvent.deleteMany({ where: { productId: fixture.productId } });
  await fixture.prisma.user.delete({ where: { id: fixture.customerId } });
  await fixture.prisma.user.delete({ where: { id: fixture.vendorUserId } });
  await fixture.prisma.user.delete({ where: { id: fixture.adminUserId } });
  await fixture.prisma.category.delete({ where: { id: fixture.category.id } });
  await fixture.prisma.onModuleDestroy();
}
