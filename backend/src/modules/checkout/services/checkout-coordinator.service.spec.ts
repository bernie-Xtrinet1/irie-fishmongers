import { EventEmitter2 } from '@nestjs/event-emitter';

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
  buildOrder,
  buildPrepared,
  buildPriceLockOk,
  checkoutDto,
} from './checkout-coordinator-test-helpers';

describe('CheckoutCoordinatorService', () => {
  let checkoutAttempt: jest.Mocked<
    Pick<CheckoutAttemptService, 'createOrResume' | 'markFailed' | 'markCommittedInTransaction'>
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
  let service: CheckoutCoordinatorService;

  const now = new Date('2026-08-10T12:00:00.000Z');

  beforeEach(() => {
    checkoutAttempt = {
      createOrResume: jest.fn().mockResolvedValue({ ok: true, action: 'CREATED', attempt: buildAttemptSummary() }),
      markFailed: jest.fn().mockResolvedValue({ ok: true, alreadyFailed: false, detailsMatched: true }),
      markCommittedInTransaction: jest.fn().mockResolvedValue({ ok: true, alreadyCommitted: false }),
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
  });

  describe('input validation', () => {
    it('rejects an empty idempotency key before any dependency call', async () => {
      const result = await service.checkout('user-1', '', checkoutDto, now);
      expect(result).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'idempotencyKey', reason: 'idempotencyKey cannot be empty' });
      expect(ordersService.prepareCheckout).not.toHaveBeenCalled();
      expect(priceLock.validateCartPriceLocks).not.toHaveBeenCalled();
      expect(checkoutAttempt.createOrResume).not.toHaveBeenCalled();
      expect(checkoutReservationState.checkoutMark).not.toHaveBeenCalled();
    });

    it('rejects an idempotency key containing whitespace before any dependency call', async () => {
      const result = await service.checkout('user-1', 'has space', checkoutDto, now);
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'idempotencyKey',
        reason: 'idempotencyKey cannot contain whitespace',
      });
      expect(ordersService.prepareCheckout).not.toHaveBeenCalled();
    });
  });

  describe('pre-attempt', () => {
    it('returns a typed failure when prepareCheckout fails, without creating an attempt', async () => {
      ordersService.prepareCheckout.mockResolvedValue({ ok: false, code: 'CART_EMPTY' });
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result).toEqual({ ok: false, code: 'PREPARE_FAILED', prepareFailure: { ok: false, code: 'CART_EMPTY' } });
      expect(priceLock.validateCartPriceLocks).not.toHaveBeenCalled();
      expect(checkoutAttempt.createOrResume).not.toHaveBeenCalled();
    });

    it('returns a typed failure when price-lock validation fails, without creating an attempt', async () => {
      priceLock.validateCartPriceLocks.mockResolvedValue({ ok: false, code: 'CART_CURRENCY_MISSING' });
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result).toEqual({
        ok: false,
        code: 'PRICE_LOCK_INVALID',
        priceLockFailure: { ok: false, code: 'CART_CURRENCY_MISSING' },
      });
      expect(checkoutAttempt.createOrResume).not.toHaveBeenCalled();
    });

    it('rejects with CHECKOUT_PLAN_MISMATCH when the cart and price-lock reads disagree, without creating an attempt', async () => {
      priceLock.validateCartPriceLocks.mockResolvedValue(buildPriceLockOk({ productId: 'product-2' }));
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result).toMatchObject({
        ok: false,
        code: 'CHECKOUT_PLAN_MISMATCH',
        missingFromPriceLock: ['product-1'],
        extraInPriceLock: ['product-2'],
      });
      expect(checkoutAttempt.createOrResume).not.toHaveBeenCalled();
      expect(checkoutReservationState.checkoutMark).not.toHaveBeenCalled();
    });
  });

  describe('idempotency branches', () => {
    it('returns IDEMPOTENCY_KEY_CONFLICT without proceeding', async () => {
      checkoutAttempt.createOrResume.mockResolvedValue({ ok: false, code: 'IDEMPOTENCY_KEY_CONFLICT' });
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result).toEqual({ ok: false, code: 'IDEMPOTENCY_KEY_CONFLICT' });
      expect(checkoutReservationState.checkoutMark).not.toHaveBeenCalled();
    });

    it('returns CHECKOUT_ALREADY_IN_PROGRESS for RESUMED_PROCESSING without touching Redis/order/payment', async () => {
      checkoutAttempt.createOrResume.mockResolvedValue({
        ok: true,
        action: 'RESUMED_PROCESSING',
        attempt: buildAttemptSummary(),
      });
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result).toEqual({ ok: false, code: 'CHECKOUT_ALREADY_IN_PROGRESS' });
      expect(checkoutReservationState.checkoutMark).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(paymentsService.initiatePayment).not.toHaveBeenCalled();
    });

    it('returns the recorded failure for ALREADY_FAILED without retrying', async () => {
      checkoutAttempt.createOrResume.mockResolvedValue({
        ok: true,
        action: 'ALREADY_FAILED',
        attempt: buildAttemptSummary({ failureCode: 'CHECKOUT_MARK_RESERVATION_EXPIRED' }),
      });
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result).toEqual({ ok: false, code: 'CHECKOUT_ALREADY_FAILED', failureCode: 'CHECKOUT_MARK_RESERVATION_EXPIRED' });
      expect(checkoutReservationState.checkoutMark).not.toHaveBeenCalled();
    });

    it('replays an ALREADY_COMMITTED attempt via getCustomerOrderById, never calling initiatePayment again', async () => {
      checkoutAttempt.createOrResume.mockResolvedValue({
        ok: true,
        action: 'ALREADY_COMMITTED',
        attempt: buildAttemptSummary({ orderId: 'order-1' }),
      });
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result).toEqual({ ok: true, order: { id: 'order-1' } });
      expect(ordersService.getCustomerOrderById).toHaveBeenCalledWith('user-1', 'order-1');
      expect(paymentsService.initiatePayment).not.toHaveBeenCalled();
      expect(checkoutReservationState.checkoutMark).not.toHaveBeenCalled();
    });

    it('an ALREADY_COMMITTED replay accepts a null payment from getCustomerOrderById', async () => {
      checkoutAttempt.createOrResume.mockResolvedValue({
        ok: true,
        action: 'ALREADY_COMMITTED',
        attempt: buildAttemptSummary({ orderId: 'order-1' }),
      });
      ordersService.getCustomerOrderById.mockResolvedValue({ id: 'order-1', payment: undefined } as never);
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result).toEqual({ ok: true, order: { id: 'order-1', payment: undefined } });
    });

    it('throws an internal consistency error when ALREADY_COMMITTED has no orderId', async () => {
      checkoutAttempt.createOrResume.mockResolvedValue({
        ok: true,
        action: 'ALREADY_COMMITTED',
        attempt: buildAttemptSummary({ orderId: null }),
      });
      await expect(service.checkout('user-1', 'key-1', checkoutDto, now)).rejects.toThrow(
        'Internal consistency error: checkout attempt attempt-1 is COMMITTED with no orderId',
      );
    });
  });

  describe('checkoutMark failure', () => {
    it('marks the attempt FAILED and returns a typed failure when checkoutMark fails, without opening a transaction', async () => {
      checkoutReservationState.checkoutMark.mockResolvedValue({
        ok: false,
        code: 'RESERVATION_EXPIRED',
        failedProductId: 'product-1',
      });
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result).toEqual({ ok: false, code: 'CHECKOUT_MARK_FAILED', markFailureCode: 'CHECKOUT_MARK_RESERVATION_EXPIRED' });
      expect(checkoutAttempt.markFailed).toHaveBeenCalledWith(
        'attempt-1',
        'user-1',
        'CHECKOUT_MARK_RESERVATION_EXPIRED',
        expect.any(String),
        now,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(checkoutReservationRecovery.checkoutRevert).not.toHaveBeenCalled();
    });

    it('maps a CHECKOUT_PLAN_EMPTY checkoutMark failure to its own failureCode', async () => {
      checkoutReservationState.checkoutMark.mockResolvedValue({ ok: false, code: 'CHECKOUT_PLAN_EMPTY' });
      const result = await service.checkout('user-1', 'key-1', checkoutDto, now);
      expect(result).toEqual({ ok: false, code: 'CHECKOUT_MARK_FAILED', markFailureCode: 'CHECKOUT_MARK_CHECKOUT_PLAN_EMPTY' });
    });
  });

  describe('structural', () => {
    it('depends on exactly the approved dependency set - no ReservationGateway, lease/reconciliation, mode, or mirror-compensation service', () => {
      expect(CheckoutCoordinatorService.length).toBe(8);
    });
  });
});
