import {
  RecoveryFixture,
  createProduct,
  setUpRecoveryFixture,
  tearDownRecoveryFixture,
} from './cart-reservation-sync-recovery-test-helpers';

// Phase 16A.0-DA, Unit DA.1B (see the DA.1B claim-fencing review, Section
// 7-9). runBatch against real candidate discovery: a persistently-failing
// candidate is attempted only once per invocation (no in-run hot loop,
// since there is no persisted backoff), and a normal multi-candidate run
// resolves every genuinely unresolved marker in one pass.
describe('CartReservationSyncRecoveryService.runBatch (real Postgres, real Redis)', () => {
  let fixture: RecoveryFixture;

  beforeAll(async () => {
    fixture = await setUpRecoveryFixture('recovery-batch');
  });

  afterAll(async () => {
    await tearDownRecoveryFixture(fixture);
  });

  it('a persistently failing candidate is attempted exactly once in one runBatch invocation', async () => {
    const { cartService, cartRepository, syncStateRepository, inventoryReservations, customerId } = fixture;
    const product = await createProduct(fixture, 'Batch Persistent Failure');
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);

    await cartService.addItem(customerId, { productId: product.id, quantity: 3 });
    const marker = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
    await syncStateRepository.markUnresolved(cart.id, product.id);

    const spy = jest.spyOn(inventoryReservations, 'reserve').mockRejectedValue(new Error('redis permanently down'));

    const result = await fixture.recoveryService.runBatch({ now: new Date(), limit: 50 });

    // findRecoveryCandidateIds scans the whole table (unscoped, matching
    // C4.4's own established precedent) - candidatesFound/attempted are
    // NOT asserted here, since other test files' leftover markers can
    // legitimately share this run when the full suite executes in
    // parallel. What actually proves "attempted exactly once, no in-run
    // hot loop" is OUR row's own attemptCount, independent of how many
    // other unrelated candidates the same sweep also picked up.
    expect(result.ok).toBe(true);
    const row = await syncStateRepository.findById(marker!.id);
    expect(row?.status).toBe('PENDING');
    expect(row?.resolvedAt).toBeNull();
    expect(row?.attemptCount).toBe(1); // claimed and attempted exactly once this run, not re-looped

    spy.mockRestore();
  });

  it('a single runBatch invocation discovers and resolves multiple genuinely unresolved markers', async () => {
    const { cartService, cartRepository, syncStateRepository, customerId } = fixture;
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);

    const products = await Promise.all(
      [1, 2, 3].map((n) => createProduct(fixture, `Batch Multi ${n}`)),
    );
    for (const [index, product] of products.entries()) {
      await cartService.addItem(customerId, { productId: product.id, quantity: index + 1 });
      await syncStateRepository.markUnresolved(cart.id, product.id);
    }

    const result = await fixture.recoveryService.runBatch({ now: new Date(), limit: 50 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.counters.resolvedConverged).toBeGreaterThanOrEqual(3);
    }
    for (const product of products) {
      const marker = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      expect(marker?.resolvedAt).not.toBeNull();
    }
  });
});
