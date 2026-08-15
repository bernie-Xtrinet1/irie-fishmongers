import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartReservationSyncStateRepository } from './cart-reservation-sync-state.repository';

// Phase 16A.0-DA, Unit DA.4B (see the DA.4B frozen plan). Covers the
// BLOCKED-state primitives in isolation - split from
// cart-reservation-sync-state-recovery.repository.spec.ts (DA.1B's own
// claim/resolve/release coverage) to stay under the 400-line file cap.
//
// BLOCKED is a waiting-on-a-precondition state, never a claim:
// blockIfGenerationMatches is fenced identically to resolveClaimIfCurrent
// (generation + attemptCount + status='PROCESSING', since it transitions
// out of an already-claimed row), but unblockIfGenerationMatches/
// rescheduleBlockedCheckIfGenerationMatches are fenced by generation alone -
// a recheck consumes zero recovery attempts (DA.4B decision C).
describe('CartReservationSyncStateRepository BLOCKED primitives (DA.4B)', () => {
  let prisma: PrismaService;
  let repository: CartReservationSyncStateRepository;
  let cartRepository: CartRepository;
  let productsRepository: ProductsRepository;
  let vendorId: string;
  let categoryId: string;
  let customerId: string;
  let vendorUserId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new CartReservationSyncStateRepository(prisma);
    cartRepository = new CartRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    productsRepository = new ProductsRepository(prisma);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });

    const customer = await usersRepository.create({
      email: `sync-blocked-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Bea',
      lastName: 'Blocked',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `sync-blocked-vendor-${randomUUID()}@example.com`,
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
    const category: Category = await categoriesRepository.create({
      name: `Sync Blocked Test Category ${randomUUID()}`,
      slug: `sync-blocked-test-category-${randomUUID()}`,
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    await prisma.cartReservationSyncState.deleteMany({ where: { cartId: cart.id } });
    await prisma.user.delete({ where: { id: customerId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.category.delete({ where: { id: categoryId } });
    await prisma.onModuleDestroy();
  });

  async function claimedMarker(): Promise<{
    cartId: string;
    productId: string;
    id: string;
    generation: number;
    attemptCount: number;
  }> {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    const product = await productsRepository.create({
      vendorId,
      categoryId,
      name: `Sync Blocked Test Snapper ${randomUUID()}`,
      description: 'A product used only for one DA.4B BLOCKED repository test case.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 20,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
    await repository.upsertDesiredState(cart.id, product.id, 0, 3);
    const row = await repository.findByCartAndProduct(cart.id, product.id);
    const claimed = await repository.claimForRecovery(row!.id, new Date());
    return { cartId: cart.id, productId: product.id, id: row!.id, generation: claimed!.generation, attemptCount: claimed!.attemptCount };
  }

  describe('blockIfGenerationMatches', () => {
    it('transitions PROCESSING -> BLOCKED, sets blockReason/nextAttemptAt, clears processingStartedAt', async () => {
      const { id, generation, attemptCount } = await claimedMarker();
      const nextAttemptAt = new Date(Date.now() + 60_000);

      const outcome = await repository.blockIfGenerationMatches(
        id,
        generation,
        attemptCount,
        'PRODUCT_SUSPECT',
        nextAttemptAt,
      );

      expect(outcome.count).toBe(1);
      const row = await repository.findById(id);
      expect(row?.status).toBe('BLOCKED');
      expect(row?.blockReason).toBe('PRODUCT_SUSPECT');
      expect(row?.nextAttemptAt?.getTime()).toBe(nextAttemptAt.getTime());
      expect(row?.processingStartedAt).toBeNull();
    });

    it('does not consume a second attemptCount - the claim already advanced it once', async () => {
      const { id, generation, attemptCount } = await claimedMarker();

      await repository.blockIfGenerationMatches(id, generation, attemptCount, 'MODE_NOT_ADMITTING', new Date());

      const row = await repository.findById(id);
      expect(row?.attemptCount).toBe(attemptCount);
      expect(row?.generation).toBe(generation);
    });

    it('misses when generation is stale (a customer mutation superseded the claim)', async () => {
      const { cartId, productId, id, generation, attemptCount } = await claimedMarker();
      await repository.upsertDesiredState(cartId, productId, 1, 9);

      const outcome = await repository.blockIfGenerationMatches(
        id,
        generation,
        attemptCount,
        'PRODUCT_SUSPECT',
        new Date(),
      );

      expect(outcome.count).toBe(0);
      const row = await repository.findById(id);
      expect(row?.status).toBe('PENDING'); // the customer mutation's own upsert already reset it
    });

    it('misses when attemptCount is stale (another worker reclaimed) and never touches the newer claim', async () => {
      const { id, generation, attemptCount: staleAttemptCount } = await claimedMarker();
      await repository.releaseClaimIfCurrent(id, generation, staleAttemptCount, 'transient');
      const reclaimed = await repository.claimForRecovery(id, new Date());

      const outcome = await repository.blockIfGenerationMatches(
        id,
        generation,
        staleAttemptCount,
        'PRODUCT_SUSPECT',
        new Date(),
      );

      expect(outcome.count).toBe(0);
      const row = await repository.findById(id);
      expect(row?.status).toBe('PROCESSING');
      expect(row?.attemptCount).toBe(reclaimed!.attemptCount);
    });
  });

  describe('unblockIfGenerationMatches', () => {
    it('transitions BLOCKED -> PENDING, clears blockReason/nextAttemptAt', async () => {
      const { id, generation, attemptCount } = await claimedMarker();
      await repository.blockIfGenerationMatches(id, generation, attemptCount, 'PRODUCT_SUSPECT', new Date());

      const outcome = await repository.unblockIfGenerationMatches(id, generation);

      expect(outcome.count).toBe(1);
      const row = await repository.findById(id);
      expect(row?.status).toBe('PENDING');
      expect(row?.blockReason).toBeNull();
      expect(row?.nextAttemptAt).toBeNull();
    });

    it('misses when generation is stale (a customer mutation superseded the block)', async () => {
      const { cartId, productId, id, generation, attemptCount } = await claimedMarker();
      await repository.blockIfGenerationMatches(id, generation, attemptCount, 'PRODUCT_SUSPECT', new Date());
      await repository.upsertDesiredState(cartId, productId, 1, 9);

      const outcome = await repository.unblockIfGenerationMatches(id, generation);

      expect(outcome.count).toBe(0);
    });
  });

  describe('rescheduleBlockedCheckIfGenerationMatches', () => {
    it('advances nextAttemptAt, keeps BLOCKED, leaves blockReason untouched', async () => {
      const { id, generation, attemptCount } = await claimedMarker();
      await repository.blockIfGenerationMatches(id, generation, attemptCount, 'PRODUCT_SUSPECT', new Date());
      const nextCheck = new Date(Date.now() + 120_000);

      const outcome = await repository.rescheduleBlockedCheckIfGenerationMatches(id, generation, nextCheck);

      expect(outcome.count).toBe(1);
      const row = await repository.findById(id);
      expect(row?.status).toBe('BLOCKED');
      expect(row?.blockReason).toBe('PRODUCT_SUSPECT');
      expect(row?.nextAttemptAt?.getTime()).toBe(nextCheck.getTime());
    });

    it('misses when generation is stale', async () => {
      const { cartId, productId, id, generation, attemptCount } = await claimedMarker();
      await repository.blockIfGenerationMatches(id, generation, attemptCount, 'PRODUCT_SUSPECT', new Date());
      await repository.upsertDesiredState(cartId, productId, 1, 9);

      const outcome = await repository.rescheduleBlockedCheckIfGenerationMatches(id, generation, new Date());

      expect(outcome.count).toBe(0);
    });
  });

  describe('findRecoveryCandidateIds - BLOCKED eligibility', () => {
    it('includes a BLOCKED row whose nextAttemptAt is due, and reports its status', async () => {
      const { id, generation, attemptCount } = await claimedMarker();
      await repository.blockIfGenerationMatches(
        id,
        generation,
        attemptCount,
        'PRODUCT_SUSPECT',
        new Date(Date.now() - 1_000),
      );

      const rows = await repository.findRecoveryCandidateIds(new Date(), 10_000);

      const match = rows.find((r) => r.id === id);
      expect(match?.status).toBe('BLOCKED');
    });

    it('excludes a BLOCKED row whose nextAttemptAt has not arrived yet', async () => {
      const { id, generation, attemptCount } = await claimedMarker();
      await repository.blockIfGenerationMatches(
        id,
        generation,
        attemptCount,
        'PRODUCT_SUSPECT',
        new Date(Date.now() + 60_000),
      );

      const rows = await repository.findRecoveryCandidateIds(new Date(), 10_000);

      expect(rows.map((r) => r.id)).not.toContain(id);
    });
  });
});
