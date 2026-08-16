import { randomUUID } from 'crypto';

import { ServiceUnavailableException } from '@nestjs/common';

import {
  BarrierFixture,
  resetCartItem,
  setUpBarrierFixture,
  tearDownBarrierFixture,
} from './cart-mutation-barrier-test-helpers';

// CART_SCOPED activation-boundary gate (see the gate design review's final
// approved design). Real-Postgres proof that all four durable
// target-changing entry points (addItem, updateItemQuantity, removeItem,
// checkout's createOrderInTransaction) reject cleanly, with ZERO durable
// mutation, while the mutation barrier is active - and that ordinary
// operation is unaffected once it is not. DA.1A compensation is
// deliberately NOT exercised here - its exemption from the barrier is
// proven separately (compensation remains fenced by the DA.1B backlog
// check alone, not by this lock).
describe('Cart mutation barrier blocks all four entry points with zero durable mutation (real Postgres)', () => {
  let fixture: BarrierFixture;

  beforeAll(async () => {
    fixture = await setUpBarrierFixture('blocking');
  });

  afterAll(async () => {
    await tearDownBarrierFixture(fixture);
  });

  afterEach(async () => {
    await fixture.mutationBarrier.deactivate(fixture.adminUserId);
    await resetCartItem(fixture);
  });

  it('addItem rejects with 503 and creates no CartItem/marker while the barrier is active', async () => {
    await fixture.mutationBarrier.activate(fixture.adminUserId);
    const cart = await fixture.cartRepository.findOrCreateByCustomerId(fixture.customerId);

    await expect(
      fixture.cartService.addItem(fixture.customerId, { productId: fixture.productId, quantity: 2 }, randomUUID()),
    ).rejects.toThrow(ServiceUnavailableException);

    const item = await fixture.cartRepository.findItemByCartAndProduct(cart.id, fixture.productId);
    expect(item).toBeNull();
    const marker = await fixture.syncStateRepository.findByCartAndProduct(cart.id, fixture.productId);
    expect(marker).toBeNull();
  });

  it('updateItemQuantity rejects with 503 and leaves the existing CartItem/marker completely untouched', async () => {
    const item = await fixture.cartService.addItem(
      fixture.customerId,
      { productId: fixture.productId, quantity: 3 },
      randomUUID(),
    );
    const cart = await fixture.cartRepository.findOrCreateByCustomerId(fixture.customerId);
    const before = await fixture.cartRepository.findItemByCartAndProduct(cart.id, fixture.productId);
    const markerBefore = await fixture.syncStateRepository.findByCartAndProduct(cart.id, fixture.productId);

    await fixture.mutationBarrier.activate(fixture.adminUserId);

    await expect(
      fixture.cartService.updateItemQuantity(fixture.customerId, item.items[0]!.id, { quantity: 9 }),
    ).rejects.toThrow(ServiceUnavailableException);

    const after = await fixture.cartRepository.findItemByCartAndProduct(cart.id, fixture.productId);
    const markerAfter = await fixture.syncStateRepository.findByCartAndProduct(cart.id, fixture.productId);
    expect(after?.quantity).toBe(before?.quantity);
    expect(after?.mutationVersion).toBe(before?.mutationVersion);
    expect(markerAfter?.generation).toBe(markerBefore?.generation);
  });

  it('removeItem rejects with 503 and leaves the existing CartItem completely intact', async () => {
    const added = await fixture.cartService.addItem(
      fixture.customerId,
      { productId: fixture.productId, quantity: 4 },
      randomUUID(),
    );
    const cart = await fixture.cartRepository.findOrCreateByCustomerId(fixture.customerId);

    await fixture.mutationBarrier.activate(fixture.adminUserId);

    await expect(
      fixture.cartService.removeItem(fixture.customerId, added.items[0]!.id),
    ).rejects.toThrow(ServiceUnavailableException);

    const stillThere = await fixture.cartRepository.findItemByCartAndProduct(cart.id, fixture.productId);
    expect(stillThere).not.toBeNull();
    expect(stillThere?.quantity).toBe(4);
  });

  it('checkout rejects with 503, creates no Order, clears no cart, and NEVER reaches payment initiation', async () => {
    await fixture.cartService.addItem(fixture.customerId, { productId: fixture.productId, quantity: 2 }, randomUUID());
    const cart = await fixture.cartRepository.findOrCreateByCustomerId(fixture.customerId);

    await fixture.mutationBarrier.activate(fixture.adminUserId);

    await expect(
      fixture.ordersService.checkout(fixture.customerId, {
        deliveryAddressLine1: '1 Barrier Lane',
        deliveryParish: 'KINGSTON',
        deliveryPhone: '18761234567',
        paymentMethod: 'CASH_ON_DELIVERY',
      } as never),
    ).rejects.toThrow(ServiceUnavailableException);

    const orders = await fixture.prisma.order.findMany({ where: { customerId: fixture.customerId } });
    expect(orders).toHaveLength(0);
    const stillInCart = await fixture.cartRepository.findItemByCartAndProduct(cart.id, fixture.productId);
    expect(stillInCart).not.toBeNull();
    // The decisive proof this is a SAFE failure mode, not merely a failed
    // write: payment is initiated strictly AFTER createOrderInTransaction
    // commits in the real checkout() sequence (see OrdersService.checkout),
    // so a barrier rejection - which throws from INSIDE that transaction,
    // before any commit - structurally cannot ever be reached once money
    // has moved.
    expect(fixture.paymentsService.initiatePayment).not.toHaveBeenCalled();
  });

  it('control: checkout succeeds and DOES reach payment initiation once the barrier is inactive', async () => {
    await fixture.cartService.addItem(fixture.customerId, { productId: fixture.productId, quantity: 1 }, randomUUID());

    const order = await fixture.ordersService.checkout(fixture.customerId, {
      deliveryAddressLine1: '1 Barrier Lane',
      deliveryParish: 'KINGSTON',
      deliveryPhone: '18761234567',
      paymentMethod: 'CASH_ON_DELIVERY',
    } as never);

    expect(order).toBeDefined();
    expect(fixture.paymentsService.initiatePayment).toHaveBeenCalledTimes(1);
  });
});
