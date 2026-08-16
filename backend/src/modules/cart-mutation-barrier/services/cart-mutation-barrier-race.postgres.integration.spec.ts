import { randomUUID } from 'crypto';

import { CartRepository } from '../../cart/repositories/cart.repository';
import {
  BarrierFixture,
  resetCartItem,
  setUpBarrierFixture,
  tearDownBarrierFixture,
} from './cart-mutation-barrier-test-helpers';

// CART_SCOPED activation-boundary gate (see the gate design review's final
// approved shared/exclusive advisory-lock protocol). The decisive proof:
// a mutation that acquired the shared MUTATION_BARRIER_LOCK_KEY lock
// before activation's exclusive request MUST commit its CartItem+marker
// before activation itself can ever commit - and the inverse: a mutation
// queued behind an already-active barrier sees it and performs zero
// writes. Uses the same controlled-delay-spy technique established
// throughout DA.1A/DA.1B/DA.4B's own concurrency proofs, bound from the
// class PROTOTYPE (never the instance).
jest.setTimeout(30_000);

function installDelayedAddOrIncrementSpy(cartRepository: CartRepository): {
  staleCallStarted: Promise<void>;
  releaseStaleCall: () => void;
} {
  const real = CartRepository.prototype.addOrIncrementItem.bind(cartRepository);
  let release!: () => void;
  const staleCallStarted = new Promise<void>((resolveStarted) => {
    jest.spyOn(cartRepository, 'addOrIncrementItem').mockImplementation(async (cartId, productId, quantity, tx) => {
      resolveStarted();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return real(cartId, productId, quantity, tx);
    });
  });
  return { staleCallStarted, releaseStaleCall: () => release() };
}

// Races activationPromise against a short timeout to prove it has NOT yet
// settled - the standard technique for proving lock contention without an
// arbitrary sleep-based assertion.
async function isStillPending(promise: Promise<unknown>, timeoutMs = 300): Promise<boolean> {
  const sentinel = Symbol('pending');
  const result = await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(sentinel), timeoutMs))]);
  return result === sentinel;
}

describe('Cart mutation barrier shared/exclusive advisory-lock race (real Postgres)', () => {
  let fixture: BarrierFixture;

  beforeAll(async () => {
    fixture = await setUpBarrierFixture('race');
  });

  afterAll(async () => {
    await tearDownBarrierFixture(fixture);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await resetCartItem(fixture);
  });

  it(
    'a mutation that observed inactive commits its CartItem+marker before activation can ever commit',
    async () => {
      const { staleCallStarted, releaseStaleCall } = installDelayedAddOrIncrementSpy(fixture.cartRepository);
      const cart = await fixture.cartRepository.findOrCreateByCustomerId(fixture.customerId);

      // Mutation A: acquires the shared lock, reads inactive, then blocks
      // (mid-transaction) on its own CartItem write.
      const mutationPromise = fixture.cartService.addItem(
        fixture.customerId,
        { productId: fixture.productId, quantity: 2 },
        randomUUID(),
      );
      await staleCallStarted;

      // Activation attempts the exclusive lock - must block, since the
      // shared lock is still held by the paused mutation transaction.
      const activationPromise = fixture.mutationBarrier.activate(fixture.adminUserId);
      expect(await isStillPending(activationPromise)).toBe(true);

      // No durable trace of mutation A exists yet - it hasn't committed.
      const beforeCommit = await fixture.cartRepository.findItemByCartAndProduct(cart.id, fixture.productId);
      expect(beforeCommit).toBeNull();

      // Release mutation A - it completes and commits.
      releaseStaleCall();
      await mutationPromise;

      // NOW activation can proceed and commit.
      const barrierSnapshot = await activationPromise;
      expect(barrierSnapshot.active).toBe(true);

      // The gate's own drain-wait dependency: mutation A's marker is
      // durable and visible the instant activation observes it.
      const item = await fixture.cartRepository.findItemByCartAndProduct(cart.id, fixture.productId);
      expect(item?.quantity).toBe(2);
      const marker = await fixture.syncStateRepository.findByCartAndProduct(cart.id, fixture.productId);
      expect(marker?.resolvedAt === null || marker?.resolvedAt instanceof Date).toBe(true);

      await fixture.mutationBarrier.deactivate(fixture.adminUserId);
    },
    15_000,
  );

  it('the inverse ordering: a mutation queued behind an already-active barrier performs zero writes', async () => {
    await fixture.mutationBarrier.activate(fixture.adminUserId);
    const cart = await fixture.cartRepository.findOrCreateByCustomerId(fixture.customerId);

    await expect(
      fixture.cartService.addItem(fixture.customerId, { productId: fixture.productId, quantity: 5 }, randomUUID()),
    ).rejects.toThrow();

    const item = await fixture.cartRepository.findItemByCartAndProduct(cart.id, fixture.productId);
    expect(item).toBeNull();

    await fixture.mutationBarrier.deactivate(fixture.adminUserId);
  });
});
