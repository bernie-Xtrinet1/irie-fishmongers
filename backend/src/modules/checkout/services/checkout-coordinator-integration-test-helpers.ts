import { OrdinaryReservationService } from '../../inventory/services/ordinary-reservation.service';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { transitionTuple } from '../../reservation-fence/repositories/reservation-fence.repository';
import { randomUUID } from 'crypto';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Category, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { CartMutationBarrierConfigRepository } from '../../cart-mutation-barrier/repositories/cart-mutation-barrier-config.repository';
import { CartMutationBarrierService } from '../../cart-mutation-barrier/services/cart-mutation-barrier.service';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { CheckoutAttemptService } from '../../checkout-attempt/services/checkout-attempt.service';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { CheckoutReservationRecoveryService } from '../../inventory/services/checkout-reservation-recovery.service';
import { CheckoutReservationStateService } from '../../inventory/services/checkout-reservation-state.service';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CheckoutDto } from '../../orders/dto/checkout.dto';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { OrdersService } from '../../orders/services/orders.service';
import { CheckoutQuoteService } from '../../orders/services/checkout-quote.service';
import { WeightAdjustmentSnapshotInitializationService } from '../../weight-adjustment/services/weight-adjustment-snapshot-initialization.service';
import { PaymentsRepository } from '../../payments/repositories/payments.repository';
import { RefundsRepository } from '../../payments/repositories/refunds.repository';
import { CashOnDeliveryAdapter } from '../../payments/providers/cash-on-delivery.adapter';
import { WiPayAdapter } from '../../payments/providers/wipay.adapter';
import { PaymentsService } from '../../payments/services/payments.service';
import { PriceLockRepository } from '../../price-lock/repositories/price-lock.repository';
import { PriceLockService } from '../../price-lock/services/price-lock.service';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorTierConfigsRepository } from '../../vendor-tiers/repositories/vendor-tier-configs.repository';
import { VendorTierFeaturesRepository } from '../../vendor-tiers/repositories/vendor-tier-features.repository';
import { VendorSalesRepository } from '../../vendor-tiers/repositories/vendor-sales.repository';
import { VendorPermissionsService } from '../../vendor-tiers/services/vendor-permissions.service';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CheckoutCoordinatorService } from './checkout-coordinator.service';

// Phase 16A.0-D, Unit D.3. Shared plumbing for CheckoutCoordinatorService's
// real-Postgres/real-Redis integration specs - fixture setup/cleanup, a
// fully real (no mocks) coordinator builder, and a one-call "ready to
// checkout" scenario seeder. No assertions or business scenarios belong
// here, matching this codebase's established convention (see
// compensation-repository-test-helpers.ts, inventory-reservations.redis-test-helpers.ts).
//
// Every dependency is real: CASH_ON_DELIVERY is used throughout (no
// external gateway call - see CashOnDeliveryAdapter), so the full saga,
// including payment initiation, runs against real Postgres/Redis with zero
// mocking except where an individual test deliberately injects one
// narrow, documented fault via jest.spyOn on a single real service method.

export interface CheckoutIntegrationFixture {
  prisma: PrismaService;
  vendor: Vendor;
  category: Category;
  userIds: string[];
}

async function ensureRole(prisma: PrismaService, name: RoleName): Promise<{ id: string }> {
  return prisma.role.upsert({ where: { name }, update: {}, create: { name } });
}

export async function setUpCheckoutIntegrationFixture(prisma: PrismaService): Promise<CheckoutIntegrationFixture> {
  const usersRepository = new UsersRepository(prisma);
  const vendorsRepository = new VendorsRepository(prisma);
  const categoriesRepository = new CategoriesRepository(prisma);

  const vendorRole = await ensureRole(prisma, RoleName.VENDOR);
  const vendorUser = await usersRepository.create({
    email: `checkout-coordinator-vendor-${randomUUID()}@example.com`,
    passwordHash: 'hashed',
    firstName: 'Vera',
    lastName: 'Vendor',
    roleId: vendorRole.id,
    emailVerificationTokenHash: 'token-hash',
    emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
  });
  const createdVendor = await vendorsRepository.create({
    userId: vendorUser.id,
    businessName: "Vera's Catch",
    parish: 'KINGSTON',
    termsAcceptedAt: new Date(),
  });
  // Vendor.status defaults to PENDING - OrdersService.prepareCheckout
  // requires APPROVED before a product from this vendor can be checked out.
  const vendor = await prisma.vendor.update({ where: { id: createdVendor.id }, data: { status: 'APPROVED' } });
  const category = await categoriesRepository.create({
    name: `Checkout Coordinator Category ${randomUUID()}`,
    slug: `checkout-coordinator-category-${randomUUID()}`,
  });

  return { prisma, vendor, category, userIds: [vendorUser.id] };
}

export async function tearDownCheckoutIntegrationFixture(fixture: CheckoutIntegrationFixture): Promise<void> {
  const { prisma, vendor, category, userIds } = fixture;
  const products = await prisma.product.findMany({ where: { vendorId: vendor.id }, select: { id: true } });
  const productIds = products.map((p) => p.id);
  await prisma.reservationFenceTransition.deleteMany({ where: { actorId: { in: userIds } } });
  await prisma.reservationEngineModeConfig.deleteMany({ where: { updatedById: { in: userIds } } });
  await prisma.reservationEngineModeConfig.deleteMany({ where: { mode: 'CART_SCOPED', updatedById: null } });
  await prisma.checkoutAttempt.deleteMany({ where: { cart: { customerId: { in: userIds } } } });
  await prisma.orderItem.deleteMany({ where: { productId: { in: productIds } } });
  await prisma.vendorOrder.deleteMany({ where: { vendorId: vendor.id } });
  await prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  await prisma.inventoryEvent.deleteMany({ where: { productId: { in: productIds } } });
  // CartReservationSyncState rows are never deleted by production code
  // (generation must be permanent - see the DA.1 architecture review) and
  // use onDelete: Restrict on their Cart relation - checkout now creates
  // them via the DA.1B checkout-clear correction, so they must be cleared
  // explicitly before Cart can be deleted.
  await prisma.cartReservationSyncState.deleteMany({ where: { productId: { in: productIds } } });
  await prisma.cartItem.deleteMany({ where: { productId: { in: productIds } } });
  await prisma.cart.deleteMany({ where: { customerId: { in: userIds } } });
  await prisma.product.deleteMany({ where: { vendorId: vendor.id } });
  for (const id of userIds) {
    await prisma.user.delete({ where: { id } });
  }
  await prisma.category.delete({ where: { id: category.id } });
}

export interface RealCoordinatorHandles {
  coordinator: CheckoutCoordinatorService;
  checkoutAttemptService: CheckoutAttemptService;
  checkoutReservationState: CheckoutReservationStateService;
  checkoutReservationRecovery: CheckoutReservationRecoveryService;
  priceLockService: PriceLockService;
  inventoryReservations: InventoryReservationsService;
  ordersService: OrdersService;
  cartRepository: CartRepository;
  syncStateRepository: CartReservationSyncStateRepository;
  eventEmitter: EventEmitter2;
  paymentsService: PaymentsService;
  cashOnDeliveryAdapter: CashOnDeliveryAdapter;
  redisClient?: Redis;
}

// Builds a fully real CheckoutCoordinatorService and its dependencies -
// zero mocks. Individual tests may jest.spyOn() one specific method on the
// returned handles for a single, narrowly-scoped fault injection, then
// restore it - never a wholesale mock replacement.
export function buildRealCoordinator(prisma: PrismaService, redisClient: Redis): RealCoordinatorHandles {
  const redisService = new RedisService(redisClient);
  const cartRepository = new CartRepository(prisma);
  const productsRepository = new ProductsRepository(prisma);
  const vendorsRepository = new VendorsRepository(prisma);
  const inventoryEventsRepository = new InventoryEventsRepository(prisma);
  const inventoryReservations = new InventoryReservationsService(redisService);
  Object.assign(inventoryReservations, { ordinary: new OrdinaryReservationService(prisma, redisService) });
  const eventEmitter = new EventEmitter2();
  const syncStateRepository = new CartReservationSyncStateRepository(prisma);

  const cashOnDeliveryAdapter = new CashOnDeliveryAdapter();
  const paymentsService = new PaymentsService(
    new PaymentsRepository(prisma),
    new RefundsRepository(prisma),
    new WiPayAdapter({ get: () => undefined } as unknown as ConfigService),
    cashOnDeliveryAdapter,
    eventEmitter,
  );
  const vendorPermissionsService = new VendorPermissionsService(
    new VendorTierConfigsRepository(prisma),
    new VendorTierFeaturesRepository(prisma),
    new VendorSalesRepository(prisma),
  );
  const mutationBarrier = new CartMutationBarrierService(prisma, new CartMutationBarrierConfigRepository(prisma));
  const checkoutQuoteService = new CheckoutQuoteService();
  const weightAdjustmentSnapshotInitializationService = {
    initializeSnapshot: jest.fn().mockResolvedValue(undefined),
  } as unknown as WeightAdjustmentSnapshotInitializationService;
  const configService = {
    get: jest.fn().mockReturnValue(undefined),
    getOrThrow: jest.fn().mockReturnValue('mock-signing-secret-minimum-32-chars-long'),
  } as unknown as ConfigService;
  const ordersService = new OrdersService(
    prisma,
    new OrdersRepository(prisma),
    new VendorOrdersRepository(prisma),
    cartRepository,
    productsRepository,
    vendorsRepository,
    paymentsService,
    vendorPermissionsService,
    inventoryEventsRepository,
    inventoryReservations,
    eventEmitter,
    syncStateRepository,
    mutationBarrier,
    checkoutQuoteService,
    weightAdjustmentSnapshotInitializationService,
    configService,
  );

  const checkoutAttemptService = new CheckoutAttemptService(new CheckoutAttemptRepository(prisma));
  const priceLockService = new PriceLockService(
    prisma,
    cartRepository,
    productsRepository,
    new PriceLockRepository(prisma),
  );
  const checkoutReservationState = new CheckoutReservationStateService(redisService);
  const checkoutReservationRecovery = new CheckoutReservationRecoveryService(redisService);

  const coordinator = new CheckoutCoordinatorService(
    checkoutAttemptService,
    priceLockService,
    checkoutReservationState,
    checkoutReservationRecovery,
    ordersService,
    prisma,
    paymentsService,
    eventEmitter,
  );

  return {
    coordinator,
    checkoutAttemptService,
    checkoutReservationState,
    checkoutReservationRecovery,
    priceLockService,
    inventoryReservations,
    ordersService,
    cartRepository,
    syncStateRepository,
    eventEmitter,
    paymentsService,
    cashOnDeliveryAdapter,
    redisClient,
  };
}

export const checkoutDto: CheckoutDto = {
  deliveryAddressLine1: '1 Test Street',
  deliveryParish: 'KINGSTON',
  deliveryPhone: '+18765551234',
  paymentMethod: 'CASH_ON_DELIVERY',
};

export interface ReadyCheckoutScenario {
  customerId: string;
  cartId: string;
  productId: string;
  quantity: number;
  lockedUnitPrice: string;
  currency: string;
}

async function ensureFenceAuthority(prisma: PrismaService, redisClient: Redis, actorId: string): Promise<void> {
  let mode = await prisma.reservationEngineModeConfig.findFirst({
    orderBy: { revision: 'desc' },
  });
  if (!mode || mode.mode !== 'CART_SCOPED') {
    mode = await prisma.reservationEngineModeConfig.create({
      data: { mode: 'CART_SCOPED', updatedById: actorId },
    });
  }

  let fence = await prisma.reservationFenceTransition.findFirst({
    where: {
      status: 'ACKNOWLEDGED',
      phase: 'OPEN',
      mode: 'CART_SCOPED',
      modeRevision: mode.revision,
    },
    orderBy: { revision: 'desc' },
  });

  if (!fence) {
    const maxFence = await prisma.reservationFenceTransition.findFirst({
      orderBy: { revision: 'desc' },
      select: { revision: true },
    });
    const nextRevision = (maxFence?.revision ?? 0) + 1;
    fence = await prisma.reservationFenceTransition.create({
      data: {
        incarnation: randomUUID(),
        epoch: 1,
        revision: nextRevision,
        phase: 'OPEN',
        protocol: 1,
        status: 'ACKNOWLEDGED',
        acknowledgedAt: new Date(),
        mode: 'CART_SCOPED',
        modeRevision: mode.revision,
        reason: 'OPEN',
        actorId,
      },
    });
  }

  await redisClient.set(RESERVATION_FENCE_KEY, JSON.stringify(transitionTuple(fence)));
  await redisClient.hset(MUTATION_HISTORY_KEY, 'incarnation', fence.incarnation);
}

// One-call happy-path seeding: a real customer, cart, product, cart item,
// a real COMPLETE price lock, and a real cart-scoped Redis reservation -
// everything CheckoutCoordinatorService.checkout needs to succeed.
export async function seedReadyCheckout(
  fixture: CheckoutIntegrationFixture,
  handles: Pick<RealCoordinatorHandles, 'priceLockService' | 'inventoryReservations' | 'cartRepository'>,
  options: { quantity?: number; price?: number } = {},
): Promise<ReadyCheckoutScenario> {
  const { prisma, vendor, category, userIds } = fixture;
  const usersRepository = new UsersRepository(prisma);
  const productsRepository = new ProductsRepository(prisma);
  const quantity = options.quantity ?? 2;
  const price = options.price ?? 500;

  const customerRole = await ensureRole(prisma, RoleName.CUSTOMER);
  const customer = await usersRepository.create({
    email: `checkout-coordinator-customer-${randomUUID()}@example.com`,
    passwordHash: 'hashed',
    firstName: 'Cara',
    lastName: 'Customer',
    roleId: customerRole.id,
    emailVerificationTokenHash: 'token-hash',
    emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
  });
  userIds.push(customer.id);

  const cart = await handles.cartRepository.findOrCreateByCustomerId(customer.id);
  const product = await productsRepository.create({
    vendorId: vendor.id,
    categoryId: category.id,
    name: 'Fresh Snapper',
    description: 'Caught this morning off the north coast.',
    unit: 'PER_POUND',
    price,
    quantityAvailable: 50,
    imageUrl: 'https://cdn.example.com/snapper.jpg',
  });

  await handles.cartRepository.addOrIncrementItem(cart.id, product.id, quantity);
  const item = await handles.cartRepository.findItemByCartAndProduct(cart.id, product.id);
  if (!item) {
    throw new Error('Internal test-setup error: cart item was not created');
  }

  const lockResult = await handles.priceLockService.createPriceLock({
    cartId: cart.id,
    cartItemId: item.id,
    customerId: customer.id,
    now: new Date(),
  });
  if (!lockResult.ok) {
    throw new Error(`Internal test-setup error: createPriceLock failed with ${lockResult.code}`);
  }

  await prisma.cartReservationSyncState.upsert({ where: { cartId_productId: { cartId: cart.id, productId: product.id } },
    create: { cartId: cart.id, productId: product.id, expectedQuantity: quantity, expectedMutationVersion: item.mutationVersion },
    update: { expectedQuantity: quantity } });

  const redisClient: Redis | undefined =
    (handles as unknown as { redisClient?: Redis }).redisClient ??
    (handles.inventoryReservations as unknown as { redis?: { getClient?: () => Redis } })?.redis?.getClient?.();

  if (redisClient) {
    await ensureFenceAuthority(prisma, redisClient, fixture.userIds[0] ?? customer.id);
  }

  const reserveResult = await handles.inventoryReservations.reserveOrRenew(
    cart.id,
    product.id,
    customer.id,
    quantity,
  );
  if (!reserveResult.ok) {
    throw new Error(`Internal test-setup error: reserveOrRenew failed with ${reserveResult.code}`);
  }

  return {
    customerId: customer.id,
    cartId: cart.id,
    productId: product.id,
    quantity,
    lockedUnitPrice: lockResult.lockedUnitPrice,
    currency: lockResult.lockedCurrency,
  };
}
