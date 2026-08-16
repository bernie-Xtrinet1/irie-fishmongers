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

// Phase 16A.0-DA, Unit DA.1A (see the DA.1 architecture review's
// concurrency-proof correction / Review #3 - "final transactional
// compensation proof"). applyCompensation now performs the CartItem-level
// write BEFORE the marker-generation gate (see cart.service.ts). This
// proves the one invariant that ordering introduces: if the CartItem-level
// guard tentatively matches (even via an ABA mutationVersion collision -
// see the DA.1 architecture review's Review #1 finding, since
// mutationVersion resets to 0 on a fresh insert and is keyed only by
// (cartId, productId), not by row id), but the marker's own permanent
// generation proves a newer mutation has since superseded it, the WHOLE
// transaction must roll back - never leaving a partial, stale CartItem
// write committed.
//
// Each test engineers a genuine ABA collision: mutation A's compensation
// captures a stale (generation, mutationVersion) pair; while A is blocked
// (holding no Postgres lock - its own primary transaction already
// committed, and its compensation transaction hasn't started yet), a real
// "mutation B" sequence runs to completion, landing CartItem back at the
// exact mutationVersion A's guard expects while genuinely advancing the
// marker's permanent generation past what A captured. Releasing A then
// proves the transaction rolls back in full against real Postgres - not
// just that a mock returned 'MISSED'.
describe('CartService compensation rollback (real Postgres, ABA-collision races)', () => {
  let prisma: PrismaService;
  let cartRepository: CartRepository;
  let syncStateRepository: CartReservationSyncStateRepository;
  let productsRepository: ProductsRepository;
  let service: CartService;
  let customerId: string;
  let vendorUserId: string;
  let vendorId: string;
  let category: Category;

  const inventoryReservations: jest.Mocked<
    Pick<InventoryReservationsService, 'getReservedByOthers' | 'reserve' | 'release'>
  > = {
    getReservedByOthers: jest.fn().mockResolvedValue(0),
    reserve: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };

  async function createProduct(name: string) {
    return productsRepository.create({
      vendorId,
      categoryId: category.id,
      name,
      description: 'A product used only for a DA.1A compensation-rollback race test.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 50,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    cartRepository = new CartRepository(prisma);
    syncStateRepository = new CartReservationSyncStateRepository(prisma);
    productsRepository = new ProductsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });

    const customer = await usersRepository.create({
      email: `cart-rollback-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Rhoda',
      lastName: 'Rollback',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `cart-rollback-vendor-${randomUUID()}@example.com`,
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
      name: `Cart Rollback Test Category ${randomUUID()}`,
      slug: `cart-rollback-test-category-${randomUUID()}`,
    });

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
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    await prisma.cartItemAddAttempt.deleteMany({ where: { cartId: cart.id } });
    await prisma.cartReservationSyncState.deleteMany({ where: { cartId: cart.id } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  it(
    'update/revert: a stale REVERT_QUANTITY compensation that tentatively matches via an ABA mutationVersion collision is fully rolled back',
    async () => {
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);
      const product = await createProduct('Update Revert Rollback');

      await service.addItem(customerId, { productId: product.id, quantity: 1 }, randomUUID());
      const initialItem = await cartRepository.findItemByCartAndProduct(cart.id, product.id);

      let resolveAStarted!: () => void;
      const aStarted = new Promise<void>((resolve) => {
        resolveAStarted = resolve;
      });
      let releaseA!: () => void;
      const aBlocked = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      inventoryReservations.reserve.mockImplementationOnce(async () => {
        resolveAStarted();
        await aBlocked;
        throw new Error('redis down');
      });

      // Mutation A: updateItemQuantity to 2. Its primary transaction
      // commits (mutationVersion 0 -> 1) before reserve() is even called -
      // A holds no lock while blocked below.
      const mutationA = service.updateItemQuantity(customerId, initialItem!.id, { quantity: 2 });
      await aStarted;

      const itemAfterAPrimary = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      expect(itemAfterAPrimary?.quantity).toBe(2);
      expect(itemAfterAPrimary?.mutationVersion).toBe(1);

      // While A is blocked: delete the row, recreate it fresh (version
      // resets to 0), then increment it once more - landing back at
      // mutationVersion=1, coincidentally identical to A's stale captured
      // guard, while the marker's own permanent generation has genuinely
      // advanced three times past what A captured.
      await service.removeItem(customerId, itemAfterAPrimary!.id);
      await service.addItem(customerId, { productId: product.id, quantity: 9 }, randomUUID());
      const itemAfterB2 = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      await service.updateItemQuantity(customerId, itemAfterB2!.id, { quantity: 20 });

      const itemAfterB = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      expect(itemAfterB?.quantity).toBe(20);
      expect(itemAfterB?.mutationVersion).toBe(1);
      const markerAfterB = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      expect(markerAfterB?.resolvedAt).not.toBeNull();

      // Release A - its CartItem-level guard (mutationVersion=1) matches
      // B's current row, so the tentative revert-to-1 write genuinely
      // executes; the marker-generation gate (captured stale) then misses,
      // and the whole transaction - including that tentative write - must
      // roll back.
      releaseA();
      await mutationA;

      const finalItem = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      expect(finalItem?.quantity).toBe(20); // B's durable state survives, not A's reverted value of 1
      expect(finalItem?.mutationVersion).toBe(1); // unchanged - not incremented to 2 by A's rolled-back write
      const finalMarker = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      expect(finalMarker?.generation).toBe(markerAfterB!.generation);
      expect(finalMarker?.expectedQuantity).toBe(20);
      expect(finalMarker?.resolvedAt?.getTime()).toBe(markerAfterB!.resolvedAt!.getTime());

      await service.removeItem(customerId, finalItem!.id);
    },
    15_000,
  );

  it(
    'insert/delete: a stale DELETE_IF_UNCHANGED compensation that tentatively matches via an ABA mutationVersion collision is fully rolled back',
    async () => {
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);
      const product = await createProduct('Insert Delete Rollback');

      let resolveAStarted!: () => void;
      const aStarted = new Promise<void>((resolve) => {
        resolveAStarted = resolve;
      });
      let releaseA!: () => void;
      const aBlocked = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      inventoryReservations.reserve.mockImplementationOnce(async () => {
        resolveAStarted();
        await aBlocked;
        throw new Error('redis down');
      });

      // Mutation A: addItem for a brand-new pair - fresh insert,
      // mutationVersion=0.
      const mutationA = service.addItem(customerId, { productId: product.id, quantity: 2 }, randomUUID());
      await aStarted;

      const itemAfterAPrimary = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      expect(itemAfterAPrimary?.mutationVersion).toBe(0);

      // While A is blocked: delete then recreate - landing back at
      // mutationVersion=0 by coincidence, while the marker's permanent
      // generation genuinely advances past what A captured.
      await service.removeItem(customerId, itemAfterAPrimary!.id);
      await service.addItem(customerId, { productId: product.id, quantity: 7 }, randomUUID());

      const itemAfterB = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      expect(itemAfterB?.quantity).toBe(7);
      expect(itemAfterB?.mutationVersion).toBe(0);
      const markerAfterB = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      expect(markerAfterB?.resolvedAt).not.toBeNull();

      // Release A - its guard (mutationVersion=0) matches B's fresh row,
      // so the tentative delete genuinely executes; the marker-generation
      // gate then misses, and the whole transaction - including that
      // tentative delete - must roll back.
      releaseA();
      await mutationA;

      const finalItem = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      expect(finalItem).not.toBeNull(); // B's fresh row survives - not deleted by A's rolled-back compensation
      expect(finalItem?.quantity).toBe(7);
      expect(finalItem?.mutationVersion).toBe(0);
      const finalMarker = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      expect(finalMarker?.generation).toBe(markerAfterB!.generation);
      expect(finalMarker?.resolvedAt?.getTime()).toBe(markerAfterB!.resolvedAt!.getTime());

      await service.removeItem(customerId, finalItem!.id);
    },
    15_000,
  );

  it(
    'remove/restore: a stale RESTORE compensation that genuinely re-executes against an absent row is fully rolled back (unique-constraint-blocked case documented separately, see cart-service-compensation.spec.ts)',
    async () => {
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);
      const product = await createProduct('Remove Restore Rollback');

      await service.addItem(customerId, { productId: product.id, quantity: 5 }, randomUUID());
      const initialItem = await cartRepository.findItemByCartAndProduct(cart.id, product.id);

      let resolveAStarted!: () => void;
      const aStarted = new Promise<void>((resolve) => {
        resolveAStarted = resolve;
      });
      let releaseA!: () => void;
      const aBlocked = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      inventoryReservations.release.mockImplementationOnce(async () => {
        resolveAStarted();
        await aBlocked;
        throw new Error('redis down');
      });

      // Mutation A: removeItem. Its primary transaction commits (row
      // deleted) before release() is even called.
      const mutationA = service.removeItem(customerId, initialItem!.id);
      await aStarted;

      const itemAfterAPrimary = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      expect(itemAfterAPrimary).toBeNull();

      // While A is blocked: add then remove again, leaving the row
      // genuinely absent once more (so A's later restore-create can
      // actually execute rather than being blocked by the unique
      // constraint), while the marker's permanent generation genuinely
      // advances past what A captured.
      await service.addItem(customerId, { productId: product.id, quantity: 9 }, randomUUID());
      const itemAfterB1 = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      await service.removeItem(customerId, itemAfterB1!.id);

      const itemAfterB = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      expect(itemAfterB).toBeNull();
      const markerAfterB = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      expect(markerAfterB?.expectedQuantity).toBeNull();
      expect(markerAfterB?.resolvedAt).not.toBeNull();

      // Release A - since no row currently exists, A's unconditional
      // restore-create genuinely executes (no P2002 collision); the
      // marker-generation gate then misses, and the whole transaction -
      // including that tentative create - must roll back.
      releaseA();
      await mutationA;

      const finalItem = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      expect(finalItem).toBeNull(); // A's stale restore did not survive
      const finalMarker = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      expect(finalMarker?.generation).toBe(markerAfterB!.generation);
      expect(finalMarker?.expectedQuantity).toBeNull();
      expect(finalMarker?.resolvedAt?.getTime()).toBe(markerAfterB!.resolvedAt!.getTime());
    },
    15_000,
  );
});
