import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import { CheckoutAttemptService } from '../../checkout-attempt/services/checkout-attempt.service';
import { CheckoutReservationRecoveryService } from '../../inventory/services/checkout-reservation-recovery.service';
import { CheckoutReservationStateService } from '../../inventory/services/checkout-reservation-state.service';
import { OrdersService } from '../../orders/services/orders.service';
import { PaymentsService } from '../../payments/services/payments.service';
import { PriceLockService } from '../../price-lock/services/price-lock.service';
import { PrismaService } from '../../../database/prisma.service';
import { CheckoutCoordinatorService } from './checkout-coordinator.service';
import {
  buildAttemptSummary,
  buildCart,
  buildOrder,
  buildPrepared,
  buildPriceLockOk,
  checkoutDto,
} from './checkout-coordinator-test-helpers';

describe('CheckoutCoordinatorService - transaction / finalize / payment / plan consistency', () => {
  let checkoutAttempt: jest.Mocked<
    Pick<
      CheckoutAttemptService,
      'createOrResume' | 'markFailed' | 'markCommittedInTransaction' | 'inspectByIdempotencyKey'
    >
  >;
  let priceLock: jest.Mocked<Pick<PriceLockService, 'validateCartPriceLocks'>>;
  let checkoutReservationState: jest.Mocked<Pick<CheckoutReservationStateService, 'checkoutMark'>>;
  let checkoutReservationRecovery: jest.Mocked<
    Pick<CheckoutReservationRecoveryService, 'checkoutRevert' | 'finalizeCheckoutConsumption'>
  >;
  let ordersService: jest.Mocked<
    Pick<OrdersService, 'prepareCheckout' | 'createOrderInTransaction' | 'getCustomerOrderById' | 'toOrderResponseWithPayment'>
  >;
  let prisma: { $transaction: jest.Mock };
  let paymentsService: jest.Mocked<Pick<PaymentsService, 'initiatePayment'>>;
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emitAsync'>>;
  let logger: { warn: jest.Mock; error: jest.Mock; log: jest.Mock };
  let service: CheckoutCoordinatorService;

  const now = new Date('2026-08-10T12:00:00.000Z');

  beforeEach(() => {
    checkoutAttempt = {
      createOrResume: jest.fn().mockResolvedValue({ ok: true, action: 'CREATED', attempt: buildAttemptSummary() }),
      markFailed: jest.fn().mockResolvedValue({ ok: true, alreadyFailed: false, detailsMatched: true }),
      markCommittedInTransaction: jest.fn().mockResolvedValue({ ok: true, alreadyCommitted: false }),
      inspectByIdempotencyKey: jest.fn().mockResolvedValue({ action: 'NOT_FOUND' }),
    };
    priceLock = { validateCartPriceLocks: jest.fn().mockResolvedValue(buildPriceLockOk()) };
    checkoutReservationState = {
      checkoutMark: jest.fn().mockResolvedValue({ ok: true, suspectProductIds: [] }),
    };
    checkoutReservationRecovery = {
      checkoutRevert: jest.fn().mockResolvedValue({
        ok: true,
        restoredProductIds: [],
        deletedProductIds: [],
        skippedProductIds: [],
        malformedProductIds: [],
        versionMismatchedProductIds: [],
        underflow: [],
        admissionSuspended: false,
      }),
      finalizeCheckoutConsumption: jest.fn().mockResolvedValue({
        ok: true,
        finalizedProductIds: ['product-1'],
        skippedProductIds: [],
        malformedProductIds: [],
        versionMismatchedProductIds: [],
        underflow: [],
        admissionSuspended: false,
      }),
    };
    ordersService = {
      prepareCheckout: jest.fn().mockResolvedValue({ ok: true, prepared: buildPrepared() }),
      createOrderInTransaction: jest.fn().mockResolvedValue(buildOrder()),
      getCustomerOrderById: jest.fn().mockResolvedValue({ id: 'order-1' }),
      toOrderResponseWithPayment: jest.fn().mockReturnValue({ id: 'order-1' }),
    };
    prisma = { $transaction: jest.fn().mockImplementation((callback: (tx: unknown) => unknown) => callback({})) };
    paymentsService = {
      initiatePayment: jest.fn().mockResolvedValue({ payment: { id: 'payment-1' }, redirectUrl: undefined }),
    };
    eventEmitter = { emitAsync: jest.fn().mockResolvedValue([]) };

    service = new CheckoutCoordinatorService(
      checkoutAttempt as unknown as CheckoutAttemptService,
      priceLock as unknown as PriceLockService,
      checkoutReservationState as unknown as CheckoutReservationStateService,
      checkoutReservationRecovery as unknown as CheckoutReservationRecoveryService,
      ordersService as unknown as OrdersService,
      prisma as unknown as PrismaService,
      paymentsService as unknown as PaymentsService,
      eventEmitter as unknown as EventEmitter2,
    );
    logger = (service as unknown as { logger: typeof logger }).logger;
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  describe('transaction success', () => {
    it('commits the order and CheckoutAttempt in the same transaction', async () => {
      await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const createArgs = ordersService.createOrderInTransaction.mock.calls[0];
      expect(createArgs?.[0]).toEqual({});
      expect(createArgs?.[1].cart.id).toBe('cart-1');
      expect(createArgs?.[2].currency).toBe('JMD');
      expect(checkoutAttempt.markCommittedInTransaction).toHaveBeenCalledWith({}, 'attempt-1', 'user-1', 'order-1', now);
    });

    it('a non-ok markCommittedInTransaction result throws inside the transaction, which the outer transaction-failure recovery catches and handles like any other durable failure', async () => {
      checkoutAttempt.markCommittedInTransaction.mockResolvedValue({ ok: false, code: 'NOT_FOUND' });
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result).toEqual({ ok: false, code: 'ORDER_TRANSACTION_FAILED' });
      expect(checkoutReservationRecovery.checkoutRevert).toHaveBeenCalled();
      expect(checkoutAttempt.markFailed).toHaveBeenCalledWith(
        'attempt-1',
        'user-1',
        'ORDER_TRANSACTION_FAILED',
        expect.stringContaining('Internal consistency error: could not commit checkout attempt attempt-1: NOT_FOUND'),
        now,
      );
    });
  });

  describe('transaction failure', () => {
    beforeEach(() => {
      prisma.$transaction.mockRejectedValue(new Error('stock race lost'));
    });

    it('reverts and marks FAILED with ORDER_TRANSACTION_FAILED when revert succeeds', async () => {
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result).toEqual({ ok: false, code: 'ORDER_TRANSACTION_FAILED' });
      expect(checkoutReservationRecovery.checkoutRevert).toHaveBeenCalledWith('cart-1', 'key-1', now.getTime());
      expect(checkoutAttempt.markFailed).toHaveBeenCalledWith(
        'attempt-1',
        'user-1',
        'ORDER_TRANSACTION_FAILED',
        'stock race lost',
        now,
      );
    });

    it('marks FAILED with ORDER_TRANSACTION_FAILED_REVERT_INCOMPLETE when revert returns a non-success result', async () => {
      checkoutReservationRecovery.checkoutRevert.mockResolvedValue({ ok: false, code: 'INVALID_INPUT', field: 'cartId', reason: 'x' });
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result).toEqual({ ok: false, code: 'ORDER_TRANSACTION_FAILED_REVERT_INCOMPLETE' });
      expect(checkoutAttempt.markFailed).toHaveBeenCalledWith(
        'attempt-1',
        'user-1',
        'ORDER_TRANSACTION_FAILED_REVERT_INCOMPLETE',
        'stock race lost',
        now,
      );
    });

    it('marks FAILED with ORDER_TRANSACTION_FAILED_REVERT_INCOMPLETE when revert itself throws, and logs the sanitized error', async () => {
      checkoutReservationRecovery.checkoutRevert.mockRejectedValue(new Error('Bearer abc123 leaked during revert'));
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result).toEqual({ ok: false, code: 'ORDER_TRANSACTION_FAILED_REVERT_INCOMPLETE' });
      expect(logger.error).toHaveBeenCalledWith(
        'checkoutRevert failed while recovering from a durable transaction failure',
        expect.objectContaining({ message: 'Bearer [REDACTED] leaked during revert' }),
      );
      const allErrorCalls = JSON.stringify(logger.error.mock.calls);
      expect(allErrorCalls).not.toContain('abc123');
    });

    it('still attempts markFailed even when checkoutRevert fails', async () => {
      checkoutReservationRecovery.checkoutRevert.mockRejectedValue(new Error('revert infra failure'));
      await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(checkoutAttempt.markFailed).toHaveBeenCalledTimes(1);
    });

    it('a non-Error thrown transaction value is still converted to a sanitized string for markFailed', async () => {
      prisma.$transaction.mockRejectedValue('ECONNRESET');
      await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(checkoutAttempt.markFailed).toHaveBeenCalledWith(
        'attempt-1',
        'user-1',
        'ORDER_TRANSACTION_FAILED',
        'ECONNRESET',
        now,
      );
    });

    it('propagates an infrastructure failure if markFailed itself throws', async () => {
      checkoutAttempt.markFailed.mockRejectedValue(new Error('database unavailable'));
      await expect(service.checkout('user-1', 'key-1', checkoutDto, now)).rejects.toThrow('database unavailable');
    });

    it('throws an internal consistency error when markFailed returns a non-success result', async () => {
      checkoutAttempt.markFailed.mockResolvedValue({ ok: false, code: 'NOT_FOUND' });
      await expect(service.checkout('user-1', 'key-1', checkoutDto, now)).rejects.toThrow(
        'Internal consistency error: could not mark checkout attempt attempt-1 FAILED: NOT_FOUND',
      );
    });
  });

  describe('post-commit finalize', () => {
    it('proceeds to payment when finalize succeeds', async () => {
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result.ok).toBe(true);
      expect(paymentsService.initiatePayment).toHaveBeenCalled();
    });

    it('order remains successful when finalizeCheckoutConsumption returns a non-success result - not rolled back, not marked FAILED', async () => {
      checkoutReservationRecovery.finalizeCheckoutConsumption.mockResolvedValue({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'cartId',
        reason: 'x',
      });
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result.ok).toBe(true);
      expect(checkoutAttempt.markFailed).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        'finalizeCheckoutConsumption returned a non-success result after a committed checkout',
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
    });

    it('order remains successful when finalizeCheckoutConsumption throws - not rolled back, not marked FAILED, sanitized log', async () => {
      checkoutReservationRecovery.finalizeCheckoutConsumption.mockRejectedValue(
        new Error('Bearer abc123 leaked during finalize'),
      );
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result.ok).toBe(true);
      expect(checkoutAttempt.markFailed).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'finalizeCheckoutConsumption threw after a committed checkout',
        expect.objectContaining({ message: 'Bearer [REDACTED] leaked during finalize' }),
      );
    });
  });

  describe('payment boundary', () => {
    it('a normal new checkout calls initiatePayment with the plan currency, never a hardcoded value', async () => {
      await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(paymentsService.initiatePayment).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 'order-1', currency: 'JMD', provider: 'CASH_ON_DELIVERY' }),
      );
    });

    it('emits OrderPlacedEvent before initiating payment', async () => {
      await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'order.placed',
        expect.objectContaining({ customerId: 'user-1', orderId: 'order-1' }),
      );
    });

    it('builds the final response via toOrderResponseWithPayment using the already-fetched payment, not a second lookup', async () => {
      await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(ordersService.toOrderResponseWithPayment).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'order-1' }),
        { id: 'payment-1' },
        undefined,
      );
    });
  });

  describe('plan consistency', () => {
    it('checkoutMark receives the same idempotency key passed to createOrResume/checkoutRevert/finalize', async () => {
      await service.checkout('user-1', 'my-key', checkoutDto, now);
      expect(checkoutAttempt.createOrResume).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: 'my-key' }),
      );
      expect(checkoutReservationState.checkoutMark).toHaveBeenCalledWith(
        'cart-1',
        'user-1',
        'my-key',
        expect.any(Array),
        expect.any(Number),
        expect.any(Number),
      );
      expect(checkoutReservationRecovery.finalizeCheckoutConsumption).toHaveBeenCalledWith('cart-1', 'my-key');
    });

    it('checkoutMark receives productId/expectedQuantity from the canonical plan (the price-lock read), not a separately rebuilt list', async () => {
      priceLock.validateCartPriceLocks.mockResolvedValue(buildPriceLockOk({ quantity: 7 }));
      ordersService.prepareCheckout.mockResolvedValue({
        ok: true,
        prepared: buildPrepared(buildCart({ items: [{ ...buildCart().items[0]!, quantity: 7 }] })),
      });
      await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(checkoutReservationState.checkoutMark).toHaveBeenCalledWith(
        'cart-1',
        'user-1',
        'key-1',
        [{ productId: 'product-1', expectedQuantity: 7 }],
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('rejects with a quantity mismatch when the productId sets match but quantities disagree', async () => {
      priceLock.validateCartPriceLocks.mockResolvedValue(buildPriceLockOk({ quantity: 9 }));
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result).toMatchObject({
        ok: false,
        code: 'CHECKOUT_PLAN_MISMATCH',
        missingFromPriceLock: [],
        extraInPriceLock: [],
        quantityMismatchProductIds: ['product-1'],
      });
    });

    it('the durable order transaction receives the same locked unitPrice/currency as checkoutMark - never item.product.price', async () => {
      priceLock.validateCartPriceLocks.mockResolvedValue(buildPriceLockOk({ lockedUnitPrice: '111.50', currency: 'USD' }));
      ordersService.prepareCheckout.mockResolvedValue({ ok: true, prepared: buildPrepared() });
      await service.checkout('user-1', 'key-1', checkoutDto, now);
      const pricingArg = ordersService.createOrderInTransaction.mock.calls[0]?.[2];
      expect(pricingArg?.currency).toBe('USD');
      expect(pricingArg?.items[0]?.unitPrice).toBeInstanceOf(Prisma.Decimal);
      expect((pricingArg?.items[0]?.unitPrice as Prisma.Decimal).toString()).toBe('111.5');
    });
  });
});
