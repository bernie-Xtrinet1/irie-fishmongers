import { CheckoutFinalizeSettlementService } from '../../checkout/services/checkout-finalize-settlement.service';
import { CheckoutFailureSettlementService } from '../../checkout/services/checkout-failure-settlement.service';
import { randomUUID } from 'crypto';
import { CheckoutOperation, CheckoutPath } from '@prisma/client';
import { CheckoutAcquisitionService } from '../../checkout/services/checkout-acquisition.service';
import { CheckoutDispatchService } from './checkout-dispatch.service';
import { InactiveCheckoutAdmissionService } from './checkout-admission.service';
import { CheckoutOperationService } from '../../checkout-operation/services/checkout-operation.service';
import { CheckoutAttemptService } from '../../checkout-attempt/services/checkout-attempt.service';
import { CheckoutCoordinatorService } from '../../checkout/services/checkout-coordinator.service';
import { OrdersService } from '../../orders/services/orders.service';
import { CheckoutShadowComparisonService } from '../../checkout-shadow/services/checkout-shadow-comparison.service';
import { checkoutDto } from '../../checkout/services/checkout-coordinator-integration-test-helpers';

describe('G.2b inactive dispatcher', () => {
  let operation: CheckoutOperation;
  let operations: { issue: jest.Mock; assignPath: jest.Mock; prepare: jest.Mock };
  let attempts: { inspectByIdempotencyKey: jest.Mock };
  let coordinator: { checkoutAcquired: jest.Mock };
  const acquisition = { acquire: jest.fn() };
  const evidence = Object.freeze({});
  const failureSettlement = { continue: jest.fn() };
  const finalizeSettlement = { continue: jest.fn().mockResolvedValue({ code: 'SETTLED' }) };
  let orders: { checkout: jest.Mock; getCustomerOrderById: jest.Mock };
  let admission: { admit: jest.Mock };
  let shadow: { compare: jest.Mock };
  let dispatcher: CheckoutDispatchService;
  const order = { id: 'order' };
  const now = new Date();
  const input = () => ({
    customerId: operation.customerId,
    cartId: operation.cartId,
    retryKey: 'client-retry',
    dto: checkoutDto,
    now,
  });
  function attempt(status = 'COMMITTED', overrides: Record<string, unknown> = {}) {
    return {
      id: 'attempt',
      idempotencyKey: operation.operationKey,
      customerId: operation.customerId,
      cartId: operation.cartId,
      selectedPath: 'CART_SCOPED',
      status,
      orderId: 'order',
      failureCode: 'FAILED_REASON',
      ...overrides,
    };
  }
  beforeEach(() => {
    operation = {
      reservationExecutionEpoch: null,
      reservationCapabilityState: null,
      id: randomUUID(),
      operationKey: randomUUID(),
      customerId: randomUUID(),
      cartId: randomUUID(),
      retryKeyHash: 'hash',
      priceLockFingerprint: null,
      selectedPath: null,
      createdAt: now,
      updatedAt: now,
    };
    operations = {
      issue: jest.fn().mockResolvedValue({ ok: true, operation }),
      assignPath: jest
        .fn()
        .mockImplementation((_customer: string, _id: string, path: CheckoutPath) =>
          Promise.resolve({ ok: true, operation: { ...operation, selectedPath: path } }),
        ),
      prepare: jest.fn().mockResolvedValue({ ok: true }),
    };
    attempts = {
      inspectByIdempotencyKey: jest
        .fn()
        .mockResolvedValueOnce({ action: 'NOT_FOUND' })
        .mockImplementation(() =>
          Promise.resolve({ action: 'ALREADY_COMMITTED', attempt: attempt() }),
        ),
    };
    coordinator = { checkoutAcquired: jest.fn().mockResolvedValue({ ok: true, order }) };
    orders = {
      checkout: jest.fn().mockResolvedValue(order),
      getCustomerOrderById: jest.fn().mockResolvedValue(order),
    };
    admission = {
      admit: jest.fn().mockImplementation(() =>
        Promise.resolve({
          ok: true,
          decision: 'CART_SCOPED',
          operation: { ...operation, selectedPath: 'CART_SCOPED', reservationExecutionEpoch: 7, reservationCapabilityState: 'ACTIVE' },
          durable: true,
        }),
      ),
    };
    finalizeSettlement.continue.mockReset().mockResolvedValue({ code: 'SETTLED' });
    acquisition.acquire.mockReset().mockResolvedValue({ ok: true, evidence });
    shadow = { compare: jest.fn().mockResolvedValue({ status: 'MATCH' }) };
    dispatcher = new CheckoutDispatchService(
      operations as unknown as CheckoutOperationService,
      attempts as unknown as CheckoutAttemptService,
      coordinator as unknown as CheckoutCoordinatorService,
      orders as unknown as OrdersService,
      admission,
      shadow as unknown as CheckoutShadowComparisonService,
      acquisition as unknown as CheckoutAcquisitionService,
      failureSettlement as unknown as CheckoutFailureSettlementService,
      finalizeSettlement as unknown as CheckoutFinalizeSettlementService,
    );
  });
  it('a detached default cannot grant executable ownership', async () => {
    expect(
      await new InactiveCheckoutAdmissionService().admit({
        customerId: operation.customerId,
        cartId: operation.cartId,
        operationId: operation.id,
      }),
    ).toEqual({ ok: false, code: 'UNAVAILABLE' });
    const safeDispatcher = new CheckoutDispatchService(
      operations as unknown as CheckoutOperationService,
      attempts as unknown as CheckoutAttemptService,
      coordinator as unknown as CheckoutCoordinatorService,
      orders as unknown as OrdersService,
      new InactiveCheckoutAdmissionService(),
      shadow as unknown as CheckoutShadowComparisonService,
      acquisition as unknown as CheckoutAcquisitionService,
      failureSettlement as unknown as CheckoutFailureSettlementService,
      finalizeSettlement as unknown as CheckoutFinalizeSettlementService,
    );
    expect(await safeDispatcher.checkout(input())).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(coordinator.checkoutAcquired).not.toHaveBeenCalled();
    expect(operations.prepare).not.toHaveBeenCalled();
    expect(orders.checkout).not.toHaveBeenCalled();
  });
  it('orders issue, inspect, atomic admission, prepare and coordinator; passes only the durable server key', async () => {
    expect(await dispatcher.checkout(input())).toEqual({ ok: true, order });
    expect(operations.issue).toHaveBeenCalledWith({
      customerId: operation.customerId,
      cartId: operation.cartId,
      retryKey: 'client-retry',
    });
    expect(operations.assignPath).not.toHaveBeenCalled();
    expect(admission.admit).toHaveBeenCalledWith({
      customerId: operation.customerId,
      cartId: operation.cartId,
      operationId: operation.id,
    });
    expect(operations.prepare).toHaveBeenCalledWith(operation.customerId, operation.id, now);
    expect(coordinator.checkoutAcquired).toHaveBeenCalledWith(
      operation.customerId,
      operation.operationKey,
      checkoutDto,
      now,
      evidence,
      failureSettlement,
      finalizeSettlement,
    );
    const calls = [
      operations.issue,
      attempts.inspectByIdempotencyKey,
      admission.admit,
      operations.prepare,
      acquisition.acquire,
      coordinator.checkoutAcquired,
    ].map((mock) => mock.mock.invocationCallOrder[0]!);
    expect(calls).toEqual([...calls].sort((a, b) => a - b));
    expect(orders.checkout).not.toHaveBeenCalled();
  });
  it.each(['COMMITTED', 'PROCESSING', 'FAILED'])(
    'replays %s before preparation or changed/failing policy',
    async (status) => {
      operation.selectedPath = 'CART_SCOPED';
      attempts.inspectByIdempotencyKey.mockReset().mockResolvedValue({
        action:
          status === 'COMMITTED'
            ? 'ALREADY_COMMITTED'
            : status === 'PROCESSING'
              ? 'RESUMED_PROCESSING'
              : 'ALREADY_FAILED',
        attempt: attempt(status),
      });
      admission.admit.mockRejectedValue(new Error('participant lookup failed after cohort change'));
      operations.prepare.mockRejectedValue(new Error('cart was cleared'));
      const result = await dispatcher.checkout(input());
      if (status === 'COMMITTED') expect(result).toEqual({ ok: true, order });
      if (status === 'PROCESSING')
        expect(result).toEqual({ ok: false, code: 'CHECKOUT_ALREADY_IN_PROGRESS' });
      if (status === 'FAILED')
        expect(result).toEqual({
          ok: false,
          code: 'CHECKOUT_ALREADY_FAILED',
          failureCode: 'FAILED_REASON',
        });
      for (const mock of [
        operations.assignPath,
        operations.prepare,
        admission.admit,
        coordinator.checkoutAcquired,
        orders.checkout,
        shadow.compare,
      ])
        expect(mock).not.toHaveBeenCalled();
    },
  );
  it.each([
    { selectedPath: null },
    { selectedPath: 'SHADOW' },
    { selectedPath: 'LEGACY' },
    { customerId: 'other' },
    { cartId: 'other' },
    { idempotencyKey: 'other' },
  ])('rejects inconsistent existing ownership %# without mutation', async (override) => {
    operation.selectedPath = 'CART_SCOPED';
    attempts.inspectByIdempotencyKey
      .mockReset()
      .mockResolvedValue({ action: 'ALREADY_COMMITTED', attempt: attempt('COMMITTED', override) });
    expect(await dispatcher.checkout(input())).toEqual({ ok: false, code: 'PATH_MISMATCH' });
    for (const mock of [
      operations.assignPath,
      operations.prepare,
      admission.admit,
      coordinator.checkoutAcquired,
      orders.checkout,
      orders.getCustomerOrderById,
    ])
      expect(mock).not.toHaveBeenCalled();
    expect(operation.selectedPath).toBe('CART_SCOPED');
  });
  it('does not guess a NULL operation path for an existing attempt', async () => {
    attempts.inspectByIdempotencyKey
      .mockReset()
      .mockResolvedValue({ action: 'ALREADY_COMMITTED', attempt: attempt() });
    expect(await dispatcher.checkout(input())).toEqual({ ok: false, code: 'PATH_MISMATCH' });
  });
  it('LEGACY uses the existing executor, without coordinator or price locks', async () => {
    admission.admit.mockResolvedValue({
      ok: true,
      decision: 'LEGACY',
      operation: { ...operation, selectedPath: 'LEGACY' },
      durable: true,
    });
    expect(await dispatcher.checkout(input())).toEqual({ ok: true, order });
    expect(orders.checkout).toHaveBeenCalledWith(operation.customerId, checkoutDto);
    expect(operations.assignPath).not.toHaveBeenCalled();
    expect(admission.admit).toHaveBeenCalledWith({
      customerId: operation.customerId,
      cartId: operation.cartId,
      operationId: operation.id,
    });
    expect(operations.prepare).not.toHaveBeenCalled();
    expect(coordinator.checkoutAcquired).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'SHADOW comparison failure=%s cannot authorize writes or fail legacy',
    async (failure) => {
      admission.admit.mockResolvedValue({
        ok: true,
        decision: 'SHADOW',
        operation,
        durable: false,
      });
      if (failure) shadow.compare.mockRejectedValue(new Error('private diagnostic failure'));
      expect(await dispatcher.checkout(input())).toEqual({ ok: true, order });
      expect(shadow.compare).toHaveBeenCalledWith({
        authenticatedCustomerId: operation.customerId,
        cartId: operation.cartId,
      });
      for (const mock of [operations.assignPath, operations.prepare, coordinator.checkoutAcquired])
        expect(mock).not.toHaveBeenCalled();
      expect(operation.selectedPath).toBeNull();
    },
  );
  it('DENY performs no execution, path assignment or preparation', async () => {
    admission.admit.mockResolvedValue({ ok: false, code: 'ADMISSION_DENIED' });
    expect(await dispatcher.checkout(input())).toEqual({ ok: false, code: 'ADMISSION_DENIED' });
    for (const mock of [
      operations.assignPath,
      operations.prepare,
      coordinator.checkoutAcquired,
      orders.checkout,
      shadow.compare,
    ])
      expect(mock).not.toHaveBeenCalled();
  });
  it('never falls back from a previously selected CART_SCOPED operation', async () => {
    operation.selectedPath = 'CART_SCOPED';
    admission.admit.mockResolvedValue({
      ok: true,
      decision: 'LEGACY',
      operation: { ...operation, selectedPath: 'LEGACY' },
      durable: true,
    });
    expect(await dispatcher.checkout(input())).toEqual({ ok: false, code: 'PATH_MISMATCH' });
    expect(orders.checkout).not.toHaveBeenCalled();
  });
  it('preparation rejection never calls coordinator or legacy', async () => {
    operations.prepare.mockResolvedValue({ ok: false, code: 'RECONFIRM_REQUIRED' });
    expect(await dispatcher.checkout(input())).toEqual({ ok: false, code: 'RECONFIRM_REQUIRED' });
    expect(coordinator.checkoutAcquired).not.toHaveBeenCalled();
    expect(orders.checkout).not.toHaveBeenCalled();
  });
  it('post-coordinator ownership mismatch fails closed without fallback', async () => {
    attempts.inspectByIdempotencyKey
      .mockReset()
      .mockResolvedValueOnce({ action: 'NOT_FOUND' })
      .mockResolvedValueOnce({
        action: 'ALREADY_COMMITTED',
        attempt: attempt('COMMITTED', { selectedPath: 'LEGACY' }),
      });
    expect(await dispatcher.checkout(input())).toEqual({ ok: false, code: 'PATH_MISMATCH' });
    expect(orders.checkout).not.toHaveBeenCalled();
  });
  it('pre-attempt coordinator validation failure is returned without inventing an attempt', async () => {
    coordinator.checkoutAcquired.mockResolvedValue({ ok: false, code: 'CHECKOUT_PLAN_MISMATCH' });
    attempts.inspectByIdempotencyKey.mockReset().mockResolvedValue({ action: 'NOT_FOUND' });
    expect(await dispatcher.checkout(input())).toEqual({
      ok: false,
      code: 'CHECKOUT_PLAN_MISMATCH',
    });
  });
  it.each(['operationKey', 'selectedPath', 'participant', 'cohort', 'attemptId'])(
    'rejects client override %s before any dependency',
    async (field) => {
      expect(await dispatcher.checkout({ ...input(), [field]: 'forged' })).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
      });
      expect(operations.issue).not.toHaveBeenCalled();
      expect(
        await dispatcher.checkout({ ...input(), dto: { ...checkoutDto, [field]: 'forged' } }),
      ).toEqual({ ok: false, code: 'INVALID_INPUT' });
    },
  );
  it('fails closed on lookup failure and does not expose raw errors', async () => {
    attempts.inspectByIdempotencyKey.mockReset().mockRejectedValue(new Error('secret raw input'));
    expect(await dispatcher.checkout(input())).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(admission.admit).not.toHaveBeenCalled();
    expect(orders.checkout).not.toHaveBeenCalled();
  });
  it('replays an attempt discovered inside admission without touching cleared-cart preparation', async () => {
    admission.admit.mockResolvedValue({
      ok: true,
      decision: 'EXISTING_ATTEMPT',
      operation: { ...operation, selectedPath: 'CART_SCOPED', reservationExecutionEpoch: 7, reservationCapabilityState: 'ACTIVE' },
      durable: true,
    });
    operations.prepare.mockRejectedValue(new Error('cleared cart'));
    expect(await dispatcher.checkout(input())).toEqual({ ok: true, order });
    expect(operations.prepare).not.toHaveBeenCalled();
    expect(coordinator.checkoutAcquired).not.toHaveBeenCalled();
    expect(orders.checkout).not.toHaveBeenCalled();
  });
  it('refuses executable admission without durable assignment', async () => {
    admission.admit.mockResolvedValue({
      ok: true,
      decision: 'CART_SCOPED',
      operation,
      durable: false,
    });
    expect(await dispatcher.checkout(input())).toEqual({ ok: false, code: 'PATH_MISMATCH' });
    expect(operations.prepare).not.toHaveBeenCalled();
    expect(coordinator.checkoutAcquired).not.toHaveBeenCalled();
  });
  it('does not begin external work until the admission promise commits', async () => {
    let commit!: (result: unknown) => void;
    let entered!: () => void;
    const admissionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    admission.admit.mockImplementation(() => {
      entered();
      return new Promise((resolve) => {
        commit = resolve;
      });
    });
    const pending = dispatcher.checkout(input());
    await admissionEntered;
    expect(operations.prepare).not.toHaveBeenCalled();
    expect(coordinator.checkoutAcquired).not.toHaveBeenCalled();
    expect(orders.checkout).not.toHaveBeenCalled();
    commit({
      ok: true,
      decision: 'CART_SCOPED',
      operation: { ...operation, selectedPath: 'CART_SCOPED', reservationExecutionEpoch: 7, reservationCapabilityState: 'ACTIVE' },
      durable: true,
    });
    expect(await pending).toEqual({ ok: true, order });
  });

  it.each(['SETTLED', 'FINALIZE_UNCERTAIN', 'FINALIZE_REJECTED'] as const)('committed replay bounded-continues %s without order creation or admission', async code => {
    operation.selectedPath = 'CART_SCOPED'; operation.reservationExecutionEpoch = 7;
    attempts.inspectByIdempotencyKey.mockReset().mockResolvedValue({ action: 'ALREADY_COMMITTED', attempt: attempt() });
    finalizeSettlement.continue.mockResolvedValue({ code });
    expect(await dispatcher.checkout(input())).toEqual({ ok: true, order });
    expect(finalizeSettlement.continue).toHaveBeenCalledTimes(1);
    expect(finalizeSettlement.continue).toHaveBeenCalledWith(operation.customerId, operation.id);
    expect(admission.admit).not.toHaveBeenCalled(); expect(operations.prepare).not.toHaveBeenCalled();
    expect(coordinator.checkoutAcquired).not.toHaveBeenCalled(); expect(orders.checkout).not.toHaveBeenCalled();
  });
  it('committed invariant breach is unresolved rather than manufacturing settlement authority', async () => {
    operation.selectedPath = 'CART_SCOPED'; operation.reservationExecutionEpoch = 7;
    attempts.inspectByIdempotencyKey.mockReset().mockResolvedValue({ action: 'ALREADY_COMMITTED', attempt: attempt() });
    finalizeSettlement.continue.mockResolvedValue({ code: 'ORDER_OUTCOME_UNRESOLVED' });
    expect(await dispatcher.checkout(input())).toEqual({ ok: false, code: 'ORDER_OUTCOME_UNRESOLVED' });
    expect(orders.getCustomerOrderById).not.toHaveBeenCalled(); expect(acquisition.acquire).not.toHaveBeenCalled();
  });
  it('historical NULL-E committed replay never upgrades or invokes terminal authority', async () => {
    operation.selectedPath = 'CART_SCOPED';
    attempts.inspectByIdempotencyKey.mockReset().mockResolvedValue({ action: 'ALREADY_COMMITTED', attempt: attempt() });
    expect(await dispatcher.checkout(input())).toEqual({ ok: true, order });
    expect(finalizeSettlement.continue).not.toHaveBeenCalled(); expect(admission.admit).not.toHaveBeenCalled();
    expect(operations.prepare).not.toHaveBeenCalled();
  });
});
