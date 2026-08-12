import { reservationHashKey } from '../../inventory/constants/inventory.constants';
import {
  RecoveryFixture,
  createProduct,
  installDelayedReserveSpy,
  setUpRecoveryFixture,
  tearDownRecoveryFixture,
} from './cart-reservation-sync-recovery-test-helpers';

// Phase 16A.0-DA, Unit DA.1B (see the DA.1B claim-fencing review). Basic
// convergence: unresolved marker + existing/absent CartItem, stale
// diagnostic fields ignored, Redis-throw retryability, and the DA.1A/DA.1B
// closing-the-loop proof (a real DA.1A stale-write leftover, converged by
// DA.1B's own recovery worker).
describe('CartReservationSyncRecoveryService convergence (real Postgres, real Redis)', () => {
  let fixture: RecoveryFixture;

  beforeAll(async () => {
    fixture = await setUpRecoveryFixture('recovery-convergence');
  });

  afterAll(async () => {
    await tearDownRecoveryFixture(fixture);
  });

  it('unresolved marker + existing CartItem: Redis is repaired to the current quantity and the marker resolves', async () => {
    const { cartService, cartRepository, syncStateRepository, redisClient, customerId } = fixture;
    const product = await createProduct(fixture, 'Recovery Existing Item');
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);

    await cartService.addItem(customerId, { productId: product.id, quantity: 5 });
    const marker = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
    // Simulate a divergence DA.1A left unresolved: force the marker back to
    // PENDING/unresolved and corrupt Redis directly to a stale value.
    await syncStateRepository.markUnresolved(cart.id, product.id);
    await redisClient.hset(reservationHashKey(product.id), cart.id, JSON.stringify({ quantity: 999, expiresAt: Date.now() + 900_000 }));

    const outcome = await fixture.recoveryService.reconcileOne(marker!.id, new Date());

    expect(outcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId: marker!.id });
    const raw = await redisClient.hget(reservationHashKey(product.id), cart.id);
    expect((JSON.parse(raw!) as { quantity: number }).quantity).toBe(5); // repaired, not 999
    const finalMarker = await syncStateRepository.findById(marker!.id);
    expect(finalMarker?.resolvedAt).not.toBeNull();
    expect(finalMarker?.status).toBe('PENDING');
  });

  it('unresolved marker + absent CartItem: Redis reservation is released and the marker resolves', async () => {
    const { cartService, cartRepository, syncStateRepository, redisClient, customerId } = fixture;
    const product = await createProduct(fixture, 'Recovery Absent Item');
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);

    await cartService.addItem(customerId, { productId: product.id, quantity: 3 });
    const item = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
    await cartService.removeItem(customerId, item!.id);
    const marker = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
    // Simulate a leftover stale reservation Redis still holds even though
    // the item is durably gone.
    await syncStateRepository.markUnresolved(cart.id, product.id);
    await redisClient.hset(reservationHashKey(product.id), cart.id, JSON.stringify({ quantity: 3, expiresAt: Date.now() + 900_000 }));

    const outcome = await fixture.recoveryService.reconcileOne(marker!.id, new Date());

    expect(outcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId: marker!.id });
    const raw = await redisClient.hget(reservationHashKey(product.id), cart.id);
    expect(raw).toBeNull();
    const finalMarker = await syncStateRepository.findById(marker!.id);
    expect(finalMarker?.resolvedAt).not.toBeNull();
  });

  it('a stale marker.expectedQuantity diagnostic is ignored - the current CartItem always wins', async () => {
    const { cartService, cartRepository, syncStateRepository, prisma, redisClient, customerId } = fixture;
    const product = await createProduct(fixture, 'Recovery Stale Diagnostic');
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);

    await cartService.addItem(customerId, { productId: product.id, quantity: 9 });
    const marker = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
    // Corrupt the diagnostic field directly - a real recovery worker must
    // never replay this as an instruction (DA.1B review, Section 3).
    await prisma.cartReservationSyncState.update({
      where: { id: marker!.id },
      data: { expectedQuantity: 123456, status: 'PENDING', resolvedAt: null },
    });

    const outcome = await fixture.recoveryService.reconcileOne(marker!.id, new Date());

    expect(outcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId: marker!.id });
    const raw = await redisClient.hget(reservationHashKey(product.id), cart.id);
    expect((JSON.parse(raw!) as { quantity: number }).quantity).toBe(9); // real CartItem quantity, never 123456
  });

  it('a Redis throw is recoverable: sanitized lastError persisted, immediately retryable, converges on the next attempt', async () => {
    const { cartService, cartRepository, syncStateRepository, redisClient, inventoryReservations, customerId } = fixture;
    const product = await createProduct(fixture, 'Recovery Redis Throw');
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);

    await cartService.addItem(customerId, { productId: product.id, quantity: 6 });
    const marker = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
    await syncStateRepository.markUnresolved(cart.id, product.id);

    const spy = jest
      .spyOn(inventoryReservations, 'reserve')
      .mockRejectedValueOnce(new Error('redis timeout: Bearer abc123secrettoken'));

    const firstAttempt = await fixture.recoveryService.reconcileOne(marker!.id, new Date());

    expect(firstAttempt).toEqual({ outcome: 'REQUEUED_RETRYABLE_FAILURE', markerId: marker!.id });
    const afterFailure = await syncStateRepository.findById(marker!.id);
    expect(afterFailure?.status).toBe('PENDING');
    expect(afterFailure?.resolvedAt).toBeNull();
    expect(afterFailure?.processingStartedAt).toBeNull();
    expect(afterFailure?.lastError).not.toContain('abc123secrettoken'); // sanitized
    expect(afterFailure?.lastError).not.toBeNull();

    spy.mockRestore(); // real reserve() now, no persisted backoff blocks the retry

    const secondAttempt = await fixture.recoveryService.reconcileOne(marker!.id, new Date());

    expect(secondAttempt).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId: marker!.id });
    const raw = await redisClient.hget(reservationHashKey(product.id), cart.id);
    expect((JSON.parse(raw!) as { quantity: number }).quantity).toBe(6);
  });

  it(
    'closes the loop with a genuine DA.1A stale-write leftover: DA.1B converges Redis to the newer durable CartItem truth',
    async () => {
      const { cartService, cartRepository, syncStateRepository, redisClient, inventoryReservations, customerId } = fixture;
      const product = await createProduct(fixture, 'Recovery DA1A Leftover');
      const cart = await cartRepository.findOrCreateByCustomerId(customerId);

      const { staleCallStarted, releaseStaleCall } = installDelayedReserveSpy(inventoryReservations);

      // Mutation A: addItem, delayed reserve() call.
      const mutationA = cartService.addItem(customerId, { productId: product.id, quantity: 2 });
      await staleCallStarted;

      // Mutation B: a fully independent, later updateItemQuantity, converges
      // cleanly with its own (unblocked, second) reserve() call.
      const itemAfterA = await cartRepository.findItemByCartAndProduct(cart.id, product.id);
      await cartService.updateItemQuantity(customerId, itemAfterA!.id, { quantity: 8 });

      // Release A's stale reserve() - it physically overwrites Redis, and
      // DA.1A's own confirmOrUnresolve correctly leaves the marker
      // unresolved rather than falsely claiming convergence.
      releaseStaleCall();
      await mutationA;

      const raw = await redisClient.hget(reservationHashKey(product.id), cart.id);
      expect((JSON.parse(raw!) as { quantity: number }).quantity).toBe(2); // A's stale value
      const marker = await syncStateRepository.findByCartAndProduct(cart.id, product.id);
      expect(marker?.resolvedAt).toBeNull(); // left unresolved by DA.1A, exactly as designed

      // DA.1B now converges it.
      const outcome = await fixture.recoveryService.reconcileOne(marker!.id, new Date());

      expect(outcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId: marker!.id });
      const rawAfter = await redisClient.hget(reservationHashKey(product.id), cart.id);
      expect((JSON.parse(rawAfter!) as { quantity: number }).quantity).toBe(8); // repaired to B's durable truth
      const finalMarker = await syncStateRepository.findById(marker!.id);
      expect(finalMarker?.resolvedAt).not.toBeNull();
    },
    15_000,
  );
});
