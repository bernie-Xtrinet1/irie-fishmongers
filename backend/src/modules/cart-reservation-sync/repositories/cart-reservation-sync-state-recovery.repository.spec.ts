import { randomUUID } from 'crypto';

import { Category, Role, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CartReservationSyncStateRepository } from './cart-reservation-sync-state.repository';

// Phase 16A.0-DA, Unit DA.1B (see the DA.1B claim-fencing review). Covers
// the recovery-worker claim/resolve/release primitives in isolation - split
// from cart-reservation-sync-state.repository.spec.ts (DA.1A's own
// upsert/generation-gate coverage) to stay under the 400-line file cap.
//
// attemptCount is the claim-fencing token, monotonic and never reset -
// every test below proves a stale worker's captured (generation,
// attemptCount) pair can never match again once superseded, whether by a
// customer mutation (generation moves) or by another worker's
// stale-PROCESSING reclaim (attemptCount moves).
describe('CartReservationSyncStateRepository recovery primitives (DA.1B)', () => {
  let prisma: PrismaService;
  let repository: CartReservationSyncStateRepository;
  let cartRepository: CartRepository;
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

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const categoriesRepository = new CategoriesRepository(prisma);
    productsRepository = new ProductsRepository(prisma);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });

    const customer = await usersRepository.create({
      email: `sync-recovery-customer-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Rae',
      lastName: 'Recovery',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    customerId = customer.id;

    const vendorUser = await usersRepository.create({
      email: `sync-recovery-vendor-${randomUUID()}@example.com`,
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
      name: `Sync Recovery Test Category ${randomUUID()}`,
      slug: `sync-recovery-test-category-${randomUUID()}`,
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

  // Each call creates a fresh product, so tests that need multiple
  // independent markers (e.g. comparing a stale row against a fresh one in
  // the same query) never collide on the same (cartId, productId) pair -
  // findOrCreateByCustomerId reuses the same cart across every call.

  async function freshUnresolvedMarker(): Promise<{ cartId: string; productId: string; id: string }> {
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    const product = await productsRepository.create({
      vendorId,
      categoryId,
      name: `Sync Recovery Test Snapper ${randomUUID()}`,
      description: 'A product used only for one DA.1B recovery repository test case.',
      unit: 'PER_POUND',
      price: 500,
      quantityAvailable: 20,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
    });
    await repository.upsertDesiredState(cart.id, product.id, 0, 3);
    const row = await repository.findByCartAndProduct(cart.id, product.id);
    return { cartId: cart.id, productId: product.id, id: row!.id };
  }

  it('findById finds an existing row and returns null for an unknown id', async () => {
    const { id } = await freshUnresolvedMarker();

    const found = await repository.findById(id);
    expect(found?.id).toBe(id);

    const missing = await repository.findById(randomUUID());
    expect(missing).toBeNull();
  });

  describe('findRecoveryCandidateIds', () => {
    // Regression guard mirroring CompensationRepository.findBatchCandidateIds'
    // own proven fix: these columns are Postgres `timestamp without time
    // zone`, and this session runs in a non-UTC timezone. A row due "now"
    // (freshly unresolved) is exactly the shape that binding a raw JS Date
    // instead of an ISO-string ::timestamp cast previously hid.
    it('regression: finds a row unresolved moments ago - the exact shape the timezone/binding bug hid', async () => {
      const { id } = await freshUnresolvedMarker();

      const rows = await repository.findRecoveryCandidateIds(new Date(), 10_000);

      expect(rows.map((r) => r.id)).toContain(id);
    });

    it('excludes an already-resolved row', async () => {
      const { cartId, productId, id } = await freshUnresolvedMarker();
      const marker = await repository.findById(id);
      await repository.resolveIfCurrentGeneration(cartId, productId, marker!.generation);

      const rows = await repository.findRecoveryCandidateIds(new Date(), 10_000);

      expect(rows.map((r) => r.id)).not.toContain(id);
    });

    it('includes a stale PROCESSING row and excludes a fresh PROCESSING row', async () => {
      const { id: staleId } = await freshUnresolvedMarker();
      await repository.claimForRecovery(staleId, new Date(Date.now() - 6 * 60 * 1000));

      const { id: freshId } = await freshUnresolvedMarker();
      await repository.claimForRecovery(freshId, new Date());

      const rows = await repository.findRecoveryCandidateIds(new Date(), 10_000);
      const ids = rows.map((r) => r.id);

      expect(ids).toContain(staleId);
      expect(ids).not.toContain(freshId);
    });
  });

  describe('claimForRecovery', () => {
    it('claims an unresolved PENDING row: status/processingStartedAt/attemptCount advance, generation untouched', async () => {
      const { id } = await freshUnresolvedMarker();
      const before = await repository.findById(id);
      const now = new Date();

      const claimed = await repository.claimForRecovery(id, now);

      expect(claimed?.status).toBe('PROCESSING');
      expect(claimed?.processingStartedAt?.getTime()).toBe(now.getTime());
      expect(claimed?.attemptCount).toBe(before!.attemptCount + 1);
      expect(claimed?.generation).toBe(before!.generation); // claiming never touches generation
    });

    it('cannot claim a row already PROCESSING and not yet stale', async () => {
      const { id } = await freshUnresolvedMarker();
      await repository.claimForRecovery(id, new Date());

      const secondClaim = await repository.claimForRecovery(id, new Date());

      expect(secondClaim).toBeNull();
    });

    it('reclaims a stale PROCESSING row, advancing attemptCount again', async () => {
      const { id } = await freshUnresolvedMarker();
      const first = await repository.claimForRecovery(id, new Date(Date.now() - 6 * 60 * 1000));

      const reclaimed = await repository.claimForRecovery(id, new Date());

      expect(reclaimed?.attemptCount).toBe(first!.attemptCount + 1);
      expect(reclaimed?.generation).toBe(first!.generation);
    });

    it('cannot claim an already-resolved row even if status is PENDING', async () => {
      const { cartId, productId, id } = await freshUnresolvedMarker();
      const marker = await repository.findById(id);
      await repository.resolveIfCurrentGeneration(cartId, productId, marker!.generation);

      const claim = await repository.claimForRecovery(id, new Date());

      expect(claim).toBeNull();
    });
  });

  describe('resolveClaimIfCurrent / releaseClaimIfCurrent', () => {
    it('resolveClaimIfCurrent resolves when generation/attemptCount/status all match, clears lastError, normalizes processingStartedAt', async () => {
      const { id } = await freshUnresolvedMarker();
      const claimed = await repository.claimForRecovery(id, new Date());
      await repository.releaseClaimIfCurrent(id, claimed!.generation, claimed!.attemptCount, 'transient error');
      const reclaimed = await repository.claimForRecovery(id, new Date());

      const now = new Date();
      const outcome = await repository.resolveClaimIfCurrent(id, reclaimed!.generation, reclaimed!.attemptCount, now);

      expect(outcome.count).toBe(1);
      const row = await repository.findById(id);
      expect(row?.status).toBe('PENDING');
      expect(row?.resolvedAt?.getTime()).toBe(now.getTime());
      expect(row?.processingStartedAt).toBeNull();
      expect(row?.lastError).toBeNull();
    });

    it('resolveClaimIfCurrent misses when generation is stale (a customer mutation superseded the claim)', async () => {
      const { cartId, productId, id } = await freshUnresolvedMarker();
      const claimed = await repository.claimForRecovery(id, new Date());
      await repository.upsertDesiredState(cartId, productId, 1, 9); // customer mutation advances generation

      const outcome = await repository.resolveClaimIfCurrent(id, claimed!.generation, claimed!.attemptCount, new Date());

      expect(outcome.count).toBe(0);
      const row = await repository.findById(id);
      expect(row?.resolvedAt).toBeNull(); // untouched by the fenced-out caller
    });

    it('resolveClaimIfCurrent misses when attemptCount is stale (another worker reclaimed) and does not touch the newer claim', async () => {
      const { id } = await freshUnresolvedMarker();
      const workerA = await repository.claimForRecovery(id, new Date(Date.now() - 6 * 60 * 1000));
      const workerB = await repository.claimForRecovery(id, new Date());

      const outcome = await repository.resolveClaimIfCurrent(id, workerA!.generation, workerA!.attemptCount, new Date());

      expect(outcome.count).toBe(0);
      const row = await repository.findById(id);
      expect(row?.status).toBe('PROCESSING'); // B's claim is untouched
      expect(row?.attemptCount).toBe(workerB!.attemptCount);
      expect(row?.resolvedAt).toBeNull();
    });

    it('releaseClaimIfCurrent releases when fenced pair matches, leaves resolvedAt untouched', async () => {
      const { id } = await freshUnresolvedMarker();
      const claimed = await repository.claimForRecovery(id, new Date());

      const outcome = await repository.releaseClaimIfCurrent(id, claimed!.generation, claimed!.attemptCount, 'redis down');

      expect(outcome.count).toBe(1);
      const row = await repository.findById(id);
      expect(row?.status).toBe('PENDING');
      expect(row?.lastError).toBe('redis down');
      expect(row?.processingStartedAt).toBeNull();
      expect(row?.resolvedAt).toBeNull();
    });

    it('releaseClaimIfCurrent misses when fenced out by a newer reclaim, leaving the newer worker fully in control', async () => {
      const { id } = await freshUnresolvedMarker();
      const workerA = await repository.claimForRecovery(id, new Date(Date.now() - 6 * 60 * 1000));
      const workerB = await repository.claimForRecovery(id, new Date());

      const outcome = await repository.releaseClaimIfCurrent(id, workerA!.generation, workerA!.attemptCount, 'stale worker error');

      expect(outcome.count).toBe(0);
      const row = await repository.findById(id);
      // B's claim is completely intact - not reset to PENDING by A's stale release.
      expect(row?.status).toBe('PROCESSING');
      expect(row?.attemptCount).toBe(workerB!.attemptCount);
      expect(row?.processingStartedAt?.getTime()).toBe(workerB!.processingStartedAt?.getTime());
      expect(row?.lastError).not.toBe('stale worker error');
    });
  });
});
