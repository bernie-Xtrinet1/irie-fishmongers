import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartReservationSyncStateRepository } from './cart-reservation-sync-state.repository';

// Phase 16A.0-DA, Unit DA.1A (see the DA.1 architecture review, including
// the concurrency-proof correction). `generation` - not
// CartItem.mutationVersion - is the permanent logical-generation counter
// for a (cartId, productId) pair: it lives on this row, which is never
// deleted, so it survives CartItem delete/recreate cycles that would
// otherwise reset a version counter back to a colliding value.
describe('CartReservationSyncStateRepository', () => {
  let prisma: PrismaService;
  let repository: CartReservationSyncStateRepository;
  let cartRepository: CartRepository;
  let productId: string;
  let customerId: string;
  let vendorUserId: string;
  let category: Category;
  let vendor: Vendor;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new CartReservationSyncStateRepository(prisma);
    cartRepository = new CartRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    const productsRepository = new ProductsRepository(prisma);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });

    const customer = await usersRepository.create({
      email: `sync-state-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Sasha',
      lastName: 'Sync',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `sync-state-vendor-${randomUUID()}@example.com`,
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
      name: `Sync State Test Category ${randomUUID()}`,
      slug: `sync-state-test-category-${randomUUID()}`,
    });
    const product = await productsRepository.create({
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Sync State Test Snapper',
      description: 'A product used only for sync-state repository tests.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 20,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
    productId = product.id;
  });

  afterAll(async () => {
    // CartReservationSyncState rows are never deleted (generation must be
    // permanent - see the DA.1 architecture review) and use
    // onDelete: Restrict on their Cart relation, so they must be cleared
    // explicitly before the owning user/cart can be deleted.
    await prisma.cartReservationSyncState.deleteMany({ where: { productId } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.onModuleDestroy();
  });

  it('creates a new marker on first upsert, generation 0, and finds it by (cartId, productId)', async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);

    const { generation } = await repository.upsertDesiredState(cart.id, productId, 0, 2);

    expect(generation).toBe(0);
    const marker = await repository.findByCartAndProduct(cart.id, productId);
    expect(marker).toMatchObject({
      cartId: cart.id,
      productId,
      expectedMutationVersion: 0,
      expectedQuantity: 2,
      status: 'PENDING',
      generation: 0,
      resolvedAt: null,
    });
  });

  it('upserts in place - one row per pair, never a second row - and advances generation', async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);

    const { generation } = await repository.upsertDesiredState(cart.id, productId, 1, 5);

    expect(generation).toBe(1);
    const marker = await repository.findByCartAndProduct(cart.id, productId);
    expect(marker?.expectedMutationVersion).toBe(1);
    expect(marker?.expectedQuantity).toBe(5);
  });

  it('resets status to PENDING and clears resolvedAt/lastError on every upsert', async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    await repository.resolveIfCurrentGeneration(cart.id, productId, 1);
    const resolved = await repository.findByCartAndProduct(cart.id, productId);
    expect(resolved?.resolvedAt).not.toBeNull();

    await repository.upsertDesiredState(cart.id, productId, 2, 7);

    const after = await repository.findByCartAndProduct(cart.id, productId);
    expect(after?.status).toBe('PENDING');
    expect(after?.resolvedAt).toBeNull();
  });

  describe('resolveIfCurrentGeneration', () => {
    it('sets resolvedAt (never deletes the row) only when the generation still matches', async () => {
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);
      const { generation } = await repository.upsertDesiredState(cart.id, productId, 3, 1);

      const missed = await repository.resolveIfCurrentGeneration(cart.id, productId, generation - 1);
      expect(missed.count).toBe(0);
      const stillPending = await repository.findByCartAndProduct(cart.id, productId);
      expect(stillPending?.resolvedAt).toBeNull();

      const resolved = await repository.resolveIfCurrentGeneration(cart.id, productId, generation);
      expect(resolved.count).toBe(1);
      const row = await repository.findByCartAndProduct(cart.id, productId);
      expect(row).not.toBeNull(); // never deleted
      expect(row?.resolvedAt).not.toBeNull();
    });
  });

  describe('advanceIfCurrentGeneration', () => {
    it('advances generation and updates the expected state when the guard matches', async () => {
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);
      const { generation } = await repository.upsertDesiredState(cart.id, productId, 5, 3);

      const outcome = await repository.advanceIfCurrentGeneration(cart.id, productId, generation, 6, 1);

      expect(outcome.count).toBe(1);
      expect(outcome.generation).toBe(generation + 1);
      const row = await repository.findByCartAndProduct(cart.id, productId);
      expect(row?.expectedMutationVersion).toBe(6);
      expect(row?.expectedQuantity).toBe(1);
      expect(row?.status).toBe('PENDING');
      expect(row?.resolvedAt).toBeNull();
    });

    it('misses (count 0, generation null) when the guard no longer matches - real Postgres', async () => {
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);
      const { generation } = await repository.upsertDesiredState(cart.id, productId, 5, 3);
      await repository.upsertDesiredState(cart.id, productId, 6, 4); // a later mutation advances it

      const stale = await repository.advanceIfCurrentGeneration(cart.id, productId, generation, 99, 99);

      expect(stale.count).toBe(0);
      expect(stale.generation).toBeNull();
      const row = await repository.findByCartAndProduct(cart.id, productId);
      expect(row?.expectedMutationVersion).toBe(6); // untouched by the stale attempt
      expect(row?.expectedQuantity).toBe(4);
    });
  });

  it('null expectedQuantity represents desired absence (a remove)', async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);

    const { generation } = await repository.upsertDesiredState(cart.id, productId, 4, null);

    const marker = await repository.findByCartAndProduct(cart.id, productId);
    expect(marker?.expectedQuantity).toBeNull();

    await repository.resolveIfCurrentGeneration(cart.id, productId, generation);
  });

  // Phase 16A.0-DA, Unit DA.1A - direct answer to the DA.1 audit's "remove
  // -> re-add version identity" question (Q1/Q6). CartItem.mutationVersion
  // restarts at 0 on every fresh insert, so the recreated row's version
  // can numerically collide with the deleted row's captured version - this
  // proves `generation`, not `expectedMutationVersion`, is what actually
  // distinguishes the two logical events, and that a stale attempt guarded
  // by the OLD generation cannot touch the marker the recreation produced.
  it('CartItem.mutationVersion resets on recreate, but marker generation never does - stale remove compensation cannot touch the recreated mutation', async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);

    // 1. create CartItem
    const created = await cartRepository.addOrIncrementItem(cart.id, productId, 2);
    const { generation: createGeneration } = await repository.upsertDesiredState(
      cart.id,
      productId,
      created.mutationVersion,
      created.quantity,
    );

    // 2. remove it, producing pending synchronization state (desired
    // absence) - this is the primary mutation's own marker write, exactly
    // as CartService.removeItem performs it before attempting Redis.
    const deleted = await cartRepository.removeItem(created.id);
    const { generation: removeGeneration } = await repository.upsertDesiredState(
      cart.id,
      productId,
      deleted.mutationVersion,
      null,
    );

    // 3. recreate the same (cartId, productId) - a later, independent
    // mutation.
    const recreated = await cartRepository.addOrIncrementItem(cart.id, productId, 6);
    const { generation: recreateGeneration } = await repository.upsertDesiredState(
      cart.id,
      productId,
      recreated.mutationVersion,
      recreated.quantity,
    );

    // 4. prove the recreated mutation has a logically newer marker
    // identity even though CartItem.mutationVersion restarts at 0.
    expect(deleted.mutationVersion).toBe(created.mutationVersion); // 0
    expect(recreated.mutationVersion).toBe(created.mutationVersion); // ALSO 0 - the collision
    expect(recreateGeneration).toBeGreaterThan(removeGeneration);
    expect(removeGeneration).toBeGreaterThan(createGeneration);

    // 5. attempt the stale remove compensation/resolution, guarded by the
    // generation captured back in step 2 (as if the original remove's
    // Redis release finally threw and its compensation ran only now).
    const staleAdvance = await repository.advanceIfCurrentGeneration(cart.id, productId, removeGeneration, 0, 6);
    const staleResolve = await repository.resolveIfCurrentGeneration(cart.id, productId, removeGeneration);

    // 6. prove it cannot delete, revert, or resolve the recreated
    // mutation's marker.
    expect(staleAdvance.count).toBe(0);
    expect(staleResolve.count).toBe(0);
    const finalRow = await repository.findByCartAndProduct(cart.id, productId);
    expect(finalRow?.generation).toBe(recreateGeneration);
    expect(finalRow?.expectedQuantity).toBe(6);
    expect(finalRow?.resolvedAt).toBeNull(); // never falsely resolved by the stale attempt

    await repository.resolveIfCurrentGeneration(cart.id, productId, recreateGeneration);
    await cartRepository.removeItem(recreated.id);
  });

  // Phase 16A.0-DA, Unit DA.1A - direct answer to the DA.1 audit's
  // compensate-restore race question (Q7): the CartItem unique constraint
  // and the marker generation gate protect against two different races,
  // and both must independently reject a stale restore attempt once a
  // newer mutation has recreated the pair - proven here by showing the
  // generation gate alone (never reaching compensateItemRestore, matching
  // the real CartService.applyCompensation ordering) AND, redundantly,
  // that a direct compensateItemRestore call against the stale target
  // would ALSO be rejected by the unique constraint even if the gate were
  // somehow bypassed.
  it('a stale remove-compensation restore attempt is rejected by both the generation gate and the CartItem unique constraint', async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);

    const created = await cartRepository.addOrIncrementItem(cart.id, productId, 2);
    await repository.upsertDesiredState(cart.id, productId, created.mutationVersion, created.quantity);
    await repository.resolveIfCurrentGeneration(
      cart.id,
      productId,
      (await repository.findByCartAndProduct(cart.id, productId))!.generation,
    );

    // Simulate removeItem's primary mutation (marker written before Redis
    // is ever attempted).
    const deleted = await cartRepository.removeItem(created.id);
    const { generation: removeGeneration } = await repository.upsertDesiredState(
      cart.id,
      productId,
      deleted.mutationVersion,
      null,
    );

    // A different, later mutation re-adds the product before the original
    // remove's own compensation (a delayed Redis release failure) ever
    // runs.
    const recreated = await cartRepository.addOrIncrementItem(cart.id, productId, 9);
    const { generation: recreateGeneration } = await repository.upsertDesiredState(
      cart.id,
      productId,
      recreated.mutationVersion,
      recreated.quantity,
    );

    // The stale remove's compensation now runs, attempting to restore the
    // ORIGINAL deleted quantity (2), guarded by the generation it captured
    // back when the remove itself happened.
    const staleGate = await repository.advanceIfCurrentGeneration(
      cart.id,
      productId,
      removeGeneration,
      0,
      deleted.quantity,
    );
    expect(staleGate.count).toBe(0); // gate alone already rejects it

    // Redundant proof: even if the gate had been bypassed, the CartItem
    // level operation itself would independently reject the restore,
    // since a row for this (cartId, productId) already exists.
    const directRestoreAttempt = await cartRepository.compensateItemRestore(cart.id, productId, deleted.quantity);
    expect(directRestoreAttempt.restored).toBe(false);

    const finalItem = await cartRepository.findItemByCartAndProduct(cart.id, productId);
    expect(finalItem?.quantity).toBe(9); // untouched - still the recreated mutation's value
    const finalMarker = await repository.findByCartAndProduct(cart.id, productId);
    expect(finalMarker?.generation).toBe(recreateGeneration);
    expect(finalMarker?.expectedQuantity).toBe(9);

    await repository.resolveIfCurrentGeneration(cart.id, productId, recreateGeneration);
    await cartRepository.removeItem(recreated.id);
  });
});
