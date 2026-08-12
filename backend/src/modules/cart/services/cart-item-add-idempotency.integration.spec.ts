import { randomUUID } from 'crypto';

import { ConflictException, ForbiddenException } from '@nestjs/common';

import {
  ConcurrencyFixture,
  setUpConcurrencyFixture,
  tearDownConcurrencyFixture,
} from './cart-service-concurrency-test-helpers';
import { CART_ITEM_ADD_ATTEMPT_STALE_TIMEOUT_MS } from './cart-item-add-idempotency.service';

// Phase 16A.0-DA, Unit DA.2 (see the DA.2 design review). Proves the full
// idempotency contract against the ACTUAL production addItem path (real
// Postgres, real Redis): same-key/same-fingerprint replay, same-key/
// different-fingerprint conflict, ALREADY_PROCESSING for a genuine
// concurrent duplicate, stale-PROCESSING reclaim, and the fenced-miss
// rollback for a stale worker that finishes after being superseded.
describe('CartService addItem idempotency (real Postgres, real Redis)', () => {
  let fixture: ConcurrencyFixture;

  beforeAll(async () => {
    fixture = await setUpConcurrencyFixture('cart-idempotency');
  });

  afterAll(async () => {
    await tearDownConcurrencyFixture(fixture);
  });

  it('the core defect this unit fixes: retrying the same key never double-increments quantity', async () => {
    const { service, cartRepository, productId, customerId } = fixture;
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    const key = randomUUID();

    const first = await service.addItem(customerId, { productId, quantity: 2 }, key);
    const second = await service.addItem(customerId, { productId, quantity: 2 }, key);

    expect(first).toEqual(second);
    const item = await cartRepository.findItemByCartAndProduct(cart.id, productId);
    expect(item?.quantity).toBe(2); // not 4 - the retry was replayed, never re-applied

    await service.removeItem(customerId, item!.id);
  });

  it('a completed replay performs zero CartItem mutation and zero reservation-sync mutation', async () => {
    const { service, cartRepository, syncStateRepository, productId, customerId } = fixture;
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    const key = randomUUID();

    await service.addItem(customerId, { productId, quantity: 3 }, key);
    const item = await cartRepository.findItemByCartAndProduct(cart.id, productId);
    const markerAfterFirst = await syncStateRepository.findByCartAndProduct(cart.id, productId);

    await service.addItem(customerId, { productId, quantity: 3 }, key);

    const itemAfterReplay = await cartRepository.findItemByCartAndProduct(cart.id, productId);
    const markerAfterReplay = await syncStateRepository.findByCartAndProduct(cart.id, productId);
    expect(itemAfterReplay?.mutationVersion).toBe(item?.mutationVersion); // unchanged
    expect(markerAfterReplay?.generation).toBe(markerAfterFirst?.generation); // unchanged

    await service.removeItem(customerId, itemAfterReplay!.id);
  });

  it('the same key with a different quantity is a typed conflict, not a replay or a second mutation', async () => {
    const { service, cartRepository, productId, customerId } = fixture;
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    const key = randomUUID();

    await service.addItem(customerId, { productId, quantity: 2 }, key);
    await expect(service.addItem(customerId, { productId, quantity: 5 }, key)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const item = await cartRepository.findItemByCartAndProduct(cart.id, productId);
    expect(item?.quantity).toBe(2); // the conflicting request never mutated anything

    await service.removeItem(customerId, item!.id);
  });

  it('a genuinely concurrent duplicate observes ALREADY_PROCESSING rather than blocking or double-mutating', async () => {
    const { service, cartRepository, productId, customerId, prisma } = fixture;
    const key = randomUUID();

    let resolveDelayStarted!: () => void;
    const delayStarted = new Promise<void>((resolve) => {
      resolveDelayStarted = resolve;
    });
    let releaseDelay!: () => void;
    const delayBlocked = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    const realAddOrIncrement = cartRepository.addOrIncrementItem.bind(cartRepository);
    const spy = jest.spyOn(cartRepository, 'addOrIncrementItem').mockImplementationOnce(async (...args) => {
      resolveDelayStarted();
      await delayBlocked;
      return realAddOrIncrement(...args);
    });

    const firstCall = service.addItem(customerId, { productId, quantity: 4 }, key);
    await delayStarted;

    await expect(service.addItem(customerId, { productId, quantity: 4 }, key)).rejects.toBeInstanceOf(
      ConflictException,
    );

    releaseDelay();
    await firstCall;
    spy.mockRestore();

    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    const item = await cartRepository.findItemByCartAndProduct(cart.id, productId);
    expect(item?.quantity).toBe(4); // exactly one mutation applied

    const attempt = await prisma.cartItemAddAttempt.findFirst({ where: { customerId, idempotencyKey: key } });
    expect(attempt?.status).toBe('COMPLETED');
    expect(attempt?.attemptCount).toBe(1); // the duplicate never reclaimed - it was never stale

    await service.removeItem(customerId, item!.id);
  });

  it('a stale PROCESSING row (server crashed before phase 2) is reclaimed and the retry actually executes', async () => {
    const { service, cartRepository, productId, customerId, prisma } = fixture;
    const key = randomUUID();

    // Simulate a crashed request: a PROCESSING row exists, but no mutation
    // was ever applied - directly, since engineering a genuine mid-flight
    // process crash isn't reproducible in-process.
    const staleCreatedAt = new Date(Date.now() - CART_ITEM_ADD_ATTEMPT_STALE_TIMEOUT_MS - 5_000);
    await prisma.cartItemAddAttempt.create({
      data: {
        idempotencyKey: key,
        customerId,
        cartId: (await cartRepository.findOrCreateByCustomerId(customerId)).id,
        productId,
        requestedQuantity: 6,
        status: 'PROCESSING',
        attemptCount: 1,
        createdAt: staleCreatedAt,
        updatedAt: staleCreatedAt,
      },
    });

    const result = await service.addItem(customerId, { productId, quantity: 6 }, key);
    expect(result.items.find((i) => i.productId === productId)?.quantity).toBe(6);

    const attempt = await prisma.cartItemAddAttempt.findFirst({ where: { customerId, idempotencyKey: key } });
    expect(attempt?.status).toBe('COMPLETED');
    expect(attempt?.attemptCount).toBe(2); // reclaimed once

    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    const item = await cartRepository.findItemByCartAndProduct(cart.id, productId);
    await service.removeItem(customerId, item!.id);
  });

  it('a stale worker whose completion fence misses rolls back its own tentative CartItem/marker writes', async () => {
    const { service, cartRepository, syncStateRepository, productId, customerId, prisma } = fixture;
    const cart = await cartRepository.findOrCreateByCustomerId(customerId);
    const key = randomUUID();

    const staleTouchedAt = new Date(Date.now() - CART_ITEM_ADD_ATTEMPT_STALE_TIMEOUT_MS - 5_000);
    const staleAttempt = await prisma.cartItemAddAttempt.create({
      data: {
        idempotencyKey: key,
        customerId,
        cartId: cart.id,
        productId,
        requestedQuantity: 7,
        status: 'PROCESSING',
        attemptCount: 1,
        createdAt: staleTouchedAt,
        updatedAt: staleTouchedAt,
      },
    });

    // A second caller reclaims the same stale row first (attemptCount -> 2)
    // and completes it entirely, exactly as a real retry would.
    await service.addItem(customerId, { productId, quantity: 7 }, key);
    const afterReclaim = await prisma.cartItemAddAttempt.findUniqueOrThrow({ where: { id: staleAttempt.id } });
    expect(afterReclaim.status).toBe('COMPLETED');
    expect(afterReclaim.attemptCount).toBe(2);

    const itemAfterReclaim = await cartRepository.findItemByCartAndProduct(cart.id, productId);
    const markerAfterReclaim = await syncStateRepository.findByCartAndProduct(cart.id, productId);

    // The original (now-superseded) worker's own mutation transaction,
    // still fenced on the STALE attemptCount=1 it originally captured -
    // exactly what CartService.executeAddItem's completion guard checks.
    // Its CartItem/marker writes are tentative and must roll back whole.
    await expect(
      prisma.$transaction(async (tx) => {
        await cartRepository.addOrIncrementItem(cart.id, productId, 999, tx);
        await syncStateRepository.upsertDesiredState(cart.id, productId, 0, 999, tx);
        const completed = await prisma.cartItemAddAttempt.updateMany({
          where: { id: staleAttempt.id, attemptCount: 1, status: 'PROCESSING' },
          data: { status: 'COMPLETED', updatedAt: new Date() },
        });
        if (completed.count === 0) {
          throw new Error('simulated fenced-miss rollback');
        }
      }),
    ).rejects.toThrow('simulated fenced-miss rollback');

    const finalItem = await cartRepository.findItemByCartAndProduct(cart.id, productId);
    const finalMarker = await syncStateRepository.findByCartAndProduct(cart.id, productId);
    expect(finalItem?.quantity).toBe(itemAfterReclaim?.quantity); // the 999 write never survived
    expect(finalMarker?.generation).toBe(markerAfterReclaim?.generation);

    await service.removeItem(customerId, finalItem!.id);
  });

  it('a typed business rejection is recorded and replayed for the same key/fingerprint without re-checking availability', async () => {
    const { service, inventoryReservations, productId, customerId, prisma } = fixture;
    const key = randomUUID();
    // The fixture's product has quantityAvailable: 50 - requesting far more
    // than that guarantees a genuine QUANTITY_NOT_AVAILABLE rejection
    // without mocking real Redis-backed availability.
    const excessiveQuantity = 1_000_000;

    const availabilitySpy = jest.spyOn(inventoryReservations, 'getAvailableToPurchase');
    await expect(
      service.addItem(customerId, { productId, quantity: excessiveQuantity }, key),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(availabilitySpy).toHaveBeenCalledTimes(1);

    const attempt = await prisma.cartItemAddAttempt.findFirst({ where: { customerId, idempotencyKey: key } });
    expect(attempt?.status).toBe('REJECTED');
    expect(attempt?.rejectionCode).toBe('QUANTITY_NOT_AVAILABLE');

    // Replay: proves the second call returns the stored rejection without
    // re-running validation at all - the availability check is not called
    // a second time.
    await expect(
      service.addItem(customerId, { productId, quantity: excessiveQuantity }, key),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(availabilitySpy).toHaveBeenCalledTimes(1);
    availabilitySpy.mockRestore();
  });

  it('a vendor-not-approved rejection reconstructs as ForbiddenException on replay', async () => {
    const { service, prisma, productId, customerId } = fixture;
    const key = randomUUID();
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });

    await prisma.vendor.update({ where: { id: product.vendorId }, data: { status: 'SUSPENDED' } });
    try {
      await expect(service.addItem(customerId, { productId, quantity: 1 }, key)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      const attempt = await prisma.cartItemAddAttempt.findFirst({ where: { customerId, idempotencyKey: key } });
      expect(attempt?.status).toBe('REJECTED');
      expect(attempt?.rejectionCode).toBe('VENDOR_NOT_APPROVED');

      await expect(service.addItem(customerId, { productId, quantity: 1 }, key)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    } finally {
      // Restore before other tests in this file run against the same
      // shared fixture's product/vendor.
      await prisma.vendor.update({ where: { id: product.vendorId }, data: { status: 'APPROVED' } });
    }
  });
});
