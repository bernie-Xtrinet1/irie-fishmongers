import * as crypto from 'crypto';
import Decimal from 'decimal.js';
import {
  BadRequestException,
  Optional,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CheckoutAttempt,
  CheckoutPath,
  OrderItem,
  PaymentStatus,
  Prisma,
  ReservationEngineMode,
  VendorOrder,
} from '@prisma/client';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { CheckoutReservationStateService } from '../../inventory/services/checkout-reservation-state.service';
import { CheckoutReservationRecoveryService } from '../../inventory/services/checkout-reservation-recovery.service';
import { CHECKOUT_PENDING_INITIAL_LEASE_SECONDS } from '../../inventory/constants/inventory.constants';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';

import { CartRepository, CartWithItems } from '../../cart/repositories/cart.repository';
import {
  CartMutationBarrierActiveError,
  CartMutationBarrierService,
} from '../../cart-mutation-barrier/services/cart-mutation-barrier.service';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { sanitizeErrorMessage } from '../../../common/utils/sanitize-error-message.util';
import { SeafoodLotsService } from '../../food-safety/services/seafood-lots.service';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { PaymentResponseEntity } from '../../payments/entities/payment-response.entity';
import { PaymentsService } from '../../payments/services/payments.service';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorPermissionsService } from '../../vendor-tiers/services/vendor-permissions.service';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { WeightAdjustmentSnapshotInitializationService } from '../../weight-adjustment/services/weight-adjustment-snapshot-initialization.service';
import { OrderPlacedEvent } from '../../../common/events/order-placed.event';
import { PrismaService } from '../../../database/prisma.service';
import { CheckoutDto } from '../dto/checkout.dto';
import { OrderResponseEntity } from '../entities/order-response.entity';
import { PaginatedOrdersEntity } from '../entities/paginated-orders.entity';
import {
  OrdersRepository,
  OrderWithDetails,
  VendorOrderInput,
  VendorOrderItemInput,
} from '../repositories/orders.repository';
import { VendorOrdersRepository } from '../repositories/vendor-orders.repository';
import { PreparedCheckout, PrepareCheckoutResult } from '../types/checkout-preparation.types';
import {
  CheckoutQuoteError,
  InvalidQuoteSignatureError,
  QuotedSeafoodItem,
  SeafoodCheckoutQuotePayload,
  StaleCartRevisionError,
} from '../types/checkout-provenance.types';
import { OrderPricingSnapshot } from '../types/order-pricing-snapshot.types';
import { buildProvenanceSnapshotV2, computeQuotePayloadHash } from './checkout-provenance-builder';
import { CheckoutQuoteService } from './checkout-quote.service';
import { mapPrepareFailureToHttpException } from './checkout-preparation-http-mapper';
import { buildLegacyPricingSnapshot } from './legacy-pricing-snapshot.builder';
import { validatePricingSnapshot } from './order-pricing-snapshot.validator';
import { toOrderResponse } from './order-response.mapper';
import {
  createOrPreserveRefundObligation,
  restoreVendorOrderStockAndTransition,
} from '../utils/order-cancellation-refund.util';

const CANCELLABLE_STATUS = 'PENDING';

// CART_SCOPED activation-boundary gate (see the gate design review).
// Matches CartService's own CART_MUTATION_BARRIER_ACTIVE_MESSAGE verbatim -
// the same maintenance condition, the same customer-facing wording,
// regardless of which entry point observed it.
const CART_MUTATION_BARRIER_ACTIVE_MESSAGE =
  'Cart mutations are temporarily paused for system maintenance; please try again shortly.';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersRepository: OrdersRepository,
    private readonly vendorOrdersRepository: VendorOrdersRepository,
    private readonly cartRepository: CartRepository,
    private readonly productsRepository: ProductsRepository,
    private readonly vendorsRepository: VendorsRepository,
    private readonly paymentsService: PaymentsService,
    private readonly vendorPermissionsService: VendorPermissionsService,
    private readonly inventoryEventsRepository: InventoryEventsRepository,
    private readonly inventoryReservations: InventoryReservationsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly syncStateRepository: CartReservationSyncStateRepository,
    private readonly mutationBarrier: CartMutationBarrierService,
    private readonly checkoutQuoteService: CheckoutQuoteService,
    private readonly weightAdjustmentSnapshotInitializationService: WeightAdjustmentSnapshotInitializationService,
    private readonly configService: ConfigService,
    @Optional() private readonly checkoutAttemptRepository?: CheckoutAttemptRepository,
    @Optional() private readonly checkoutReservationState?: CheckoutReservationStateService,
    @Optional() private readonly checkoutReservationRecovery?: CheckoutReservationRecoveryService,
    @Optional() private readonly reservationEngineModeService?: ReservationEngineModeService,
  ) {}

  private isCatchWeightSeafoodProduct(product: any): boolean {
    if (!product) return false;
    return Boolean(
      product.lotId ||
      product.lot ||
      product.catalogueItemId ||
      product.inventoryMode === 'LISTING_BACKED',
    );
  }

  private mapQuoteErrorToHttpException(error: unknown): Error {
    if (error instanceof StaleCartRevisionError) {
      return new ConflictException(error.message);
    }
    if (error instanceof CheckoutQuoteError) {
      return new BadRequestException(error.message);
    }
    if (error instanceof Error) {
      return new BadRequestException(error.message);
    }
    return new BadRequestException('Checkout quote verification failed.');
  }

  verifySeafoodQuote(
    userId: string,
    cart: CartWithItems,
    dto: CheckoutDto,
  ): SeafoodCheckoutQuotePayload {
    if (!dto.quoteToken || typeof dto.quoteToken !== 'string' || dto.quoteToken.trim() === '') {
      throw new BadRequestException('Checkout quote token is required for catch-weight seafood items.');
    }

    const secret = this.configService.getOrThrow<string>('CHECKOUT_QUOTE_SIGNING_SECRET');
    const previousSecret = this.configService.get<string>('CHECKOUT_QUOTE_SIGNING_SECRET_PREVIOUS');

    const expectedCartRevisionHash = this.checkoutQuoteService.computeCartRevisionHash(
      cart.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        quantity: item.quantity,
        mutationVersion: item.mutationVersion,
      })),
    );

    let verifiedQuote: SeafoodCheckoutQuotePayload;
    try {
      verifiedQuote = this.checkoutQuoteService.verifyQuote(dto.quoteToken, {
        secret,
        expectedCustomerId: userId,
        expectedCartId: cart.id,
        expectedCartRevisionHash,
      });
    } catch (error) {
      if (error instanceof InvalidQuoteSignatureError && previousSecret) {
        try {
          verifiedQuote = this.checkoutQuoteService.verifyQuote(dto.quoteToken, {
            secret: previousSecret,
            expectedCustomerId: userId,
            expectedCartId: cart.id,
            expectedCartRevisionHash,
          });
        } catch (rotationError) {
          throw this.mapQuoteErrorToHttpException(rotationError);
        }
      } else {
        throw this.mapQuoteErrorToHttpException(error);
      }
    }

    // F05: Item-level coverage check: every seafood item in the cart must be covered
    const seafoodCartItems = cart.items.filter((item) =>
      this.isCatchWeightSeafoodProduct(item.product),
    );

    if (verifiedQuote.items.length !== seafoodCartItems.length) {
      throw new BadRequestException(
        `Quote item count (${verifiedQuote.items.length}) does not match seafood items count in cart (${seafoodCartItems.length}).`,
      );
    }

    for (const cartItem of seafoodCartItems) {
      const quotedItem = verifiedQuote.items.find(
        (q) => q.cartItemId === cartItem.id && q.productId === cartItem.productId,
      );
      if (!quotedItem) {
        throw new BadRequestException(
          `Cart item "${cartItem.id}" (product "${cartItem.productId}") is not covered in the checkout quote.`,
        );
      }
      if (quotedItem.pieceCount !== cartItem.quantity) {
        throw new BadRequestException(
          `Quoted piece count (${quotedItem.pieceCount}) does not match cart quantity (${cartItem.quantity}) for product "${cartItem.productId}".`,
        );
      }
      if (quotedItem.unit !== cartItem.product.unit) {
        throw new BadRequestException(
          `Quoted unit (${quotedItem.unit}) does not match product unit (${cartItem.product.unit}) for product "${cartItem.productId}".`,
        );
      }
      if (
        new Decimal(quotedItem.customerAuthorizedCeilingJmd).lessThan(
          new Decimal(quotedItem.estimatedItemTotal),
        )
      ) {
        throw new BadRequestException(
          `Customer ceiling (${quotedItem.customerAuthorizedCeilingJmd}) is below estimated item total (${quotedItem.estimatedItemTotal}) for item "${cartItem.id}".`,
        );
      }
      if (
        new Decimal(quotedItem.customerAuthorizedCeilingJmd).lessThan(
          new Decimal(quotedItem.minimumAuthorizedCeilingJmd),
        )
      ) {
        throw new BadRequestException(
          `Customer ceiling (${quotedItem.customerAuthorizedCeilingJmd}) is below minimum authorized ceiling (${quotedItem.minimumAuthorizedCeilingJmd}) for item "${cartItem.id}".`,
        );
      }
    }

    return verifiedQuote;
  }

  private async resolveCheckoutModePlan(): Promise<{
    runtimeMode: ReservationEngineMode;
    selectedPath: CheckoutPath;
    requiresCartScopedMark: boolean;
    isMirrorMode: boolean;
  }> {
    let runtimeMode: ReservationEngineMode;
    if (this.reservationEngineModeService) {
      runtimeMode = await this.reservationEngineModeService.getCurrentMode();
    } else if (
      this.checkoutAttemptRepository ||
      this.checkoutReservationState ||
      this.checkoutReservationRecovery
    ) {
      runtimeMode = ReservationEngineMode.CART_SCOPED;
    } else {
      runtimeMode = ReservationEngineMode.LEGACY;
    }

    switch (runtimeMode) {
      case ReservationEngineMode.LEGACY:
        return {
          runtimeMode,
          selectedPath: CheckoutPath.LEGACY,
          requiresCartScopedMark: false,
          isMirrorMode: false,
        };
      case ReservationEngineMode.MIRROR:
        return {
          runtimeMode,
          selectedPath: CheckoutPath.LEGACY,
          requiresCartScopedMark: false,
          isMirrorMode: true,
        };
      case ReservationEngineMode.CART_SCOPED:
      case ReservationEngineMode.DRAINING:
        return {
          runtimeMode,
          selectedPath: CheckoutPath.CART_SCOPED,
          requiresCartScopedMark: true,
          isMirrorMode: false,
        };
    }
  }

  private computeCheckoutIdempotencyKey(
    cart: CartWithItems,
    verifiedQuote?: SeafoodCheckoutQuotePayload,
  ): string {
    if (verifiedQuote?.quoteId) {
      return verifiedQuote.quoteId;
    }
    const itemsSignature = cart.items
      .map((item) => `${item.id}:${item.productId}:${item.quantity}:${item.mutationVersion ?? 0}`)
      .sort()
      .join('|');
    const revisionHash = crypto.createHash('sha256').update(itemsSignature).digest('hex').slice(0, 24);
    return `${cart.id}:${revisionHash}`;
  }

  private async tryReplayQuoteAttemptAfterCartClear(
    userId: string,
    quoteToken: string,
  ): Promise<OrderResponseEntity | null> {
    if (!this.checkoutAttemptRepository || !this.checkoutQuoteService) {
      return null;
    }
    const secret = this.configService.get<string>('CHECKOUT_QUOTE_SIGNING_SECRET');
    if (!secret || typeof secret !== 'string' || secret.trim() === '') {
      return null;
    }
    const previousSecret = this.configService.get<string>('CHECKOUT_QUOTE_SIGNING_SECRET_PREVIOUS');

    let verified: SeafoodCheckoutQuotePayload;
    try {
      verified = this.checkoutQuoteService.verifyQuote(quoteToken, {
        secret,
        expectedCustomerId: userId,
      });
    } catch (error) {
      if (error instanceof InvalidQuoteSignatureError && previousSecret) {
        try {
          verified = this.checkoutQuoteService.verifyQuote(quoteToken, {
            secret: previousSecret,
            expectedCustomerId: userId,
          });
        } catch {
          return null;
        }
      } else {
        return null;
      }
    }

    const attempt = await this.checkoutAttemptRepository.findByIdempotencyKey(verified.quoteId);
    if (!attempt) {
      return null;
    }
    if (attempt.customerId !== userId) {
      throw new ConflictException('Checkout attempt idempotency key belongs to another customer.');
    }
    if (attempt.cartId !== undefined && attempt.cartId !== verified.cartId) {
      throw new ConflictException('Checkout attempt idempotency key belongs to another cart.');
    }
    if (attempt.selectedPath === null) {
      throw new ConflictException('Checkout attempt has unknown path ownership and cannot proceed.');
    }
    if (attempt.status === 'COMMITTED') {
      if (attempt.orderId) {
        return this.getCustomerOrderById(userId, attempt.orderId);
      }
      throw new ConflictException('Checkout attempt is COMMITTED without an orderId.');
    }
    if (attempt.status === 'FAILED') {
      throw new ConflictException(
        `Checkout attempt has previously failed: ${attempt.failureCode ?? 'FAILED'}`,
      );
    }
    throw new ConflictException('Checkout is already in progress for this attempt.');
  }

  private async markCreatedAttemptFailed(
    attempt: CheckoutAttempt | undefined,
    customerId: string,
    failureCode: string,
    failureMessage: string,
  ): Promise<void> {
    if (
      !attempt ||
      !this.checkoutAttemptRepository ||
      typeof this.checkoutAttemptRepository.markFailed !== 'function'
    ) {
      return;
    }
    try {
      await this.checkoutAttemptRepository.markFailed(
        attempt.id,
        customerId,
        failureCode,
        sanitizeErrorMessage(failureMessage, 400),
        new Date(),
      );
    } catch (err: any) {
      this.logger.warn(
        `Non-fatal failure recording CheckoutAttempt FAILED state for attempt "${attempt.id}": ${err?.message ?? err}`,
      );
    }
  }

  async checkout(userId: string, dto: CheckoutDto): Promise<OrderResponseEntity> {
    const prepareResult = await this.prepareCheckout(userId, dto);
    if (!prepareResult.ok) {
      if (
        prepareResult.code === 'CART_EMPTY' &&
        dto.quoteToken &&
        typeof dto.quoteToken === 'string' &&
        dto.quoteToken.trim() !== '' &&
        this.checkoutAttemptRepository
      ) {
        const replayed = await this.tryReplayQuoteAttemptAfterCartClear(userId, dto.quoteToken);
        if (replayed) {
          return replayed;
        }
      }
      throw mapPrepareFailureToHttpException(prepareResult);
    }
    const { prepared } = prepareResult;

    const hasSeafood = prepared.cart.items.some((item) =>
      this.isCatchWeightSeafoodProduct(item.product),
    );

    let verifiedQuote: SeafoodCheckoutQuotePayload | undefined;
    if (hasSeafood) {
      verifiedQuote = this.verifySeafoodQuote(userId, prepared.cart, dto);
    }

    const modePlan = await this.resolveCheckoutModePlan();
    const idempotencyKey = this.computeCheckoutIdempotencyKey(prepared.cart, verifiedQuote);
    let attempt: CheckoutAttempt | undefined;
    let createdAttemptByUs = false;

    if (this.checkoutAttemptRepository) {
      const attemptRes = await this.checkoutAttemptRepository.createOrGetByIdempotencyKey({
        selectedPath: modePlan.selectedPath,
        idempotencyKey,
        cartId: prepared.cart.id,
        customerId: userId,
        now: new Date(),
      });
      attempt = attemptRes.attempt;
      createdAttemptByUs = attemptRes.created;

      if (attempt.customerId !== userId) {
        throw new ConflictException('Checkout attempt idempotency key belongs to another customer.');
      }
      if (attempt.cartId !== undefined && attempt.cartId !== prepared.cart.id) {
        throw new ConflictException('Checkout attempt idempotency key belongs to another cart.');
      }
      if (attempt.selectedPath === null) {
        throw new ConflictException('Checkout attempt has unknown path ownership and cannot proceed.');
      }
      if (attempt.status === 'COMMITTED') {
        if (attempt.orderId) {
          return this.getCustomerOrderById(userId, attempt.orderId);
        }
        throw new ConflictException('Checkout attempt is COMMITTED without an orderId.');
      }
      if (attempt.selectedPath !== undefined && attempt.selectedPath !== modePlan.selectedPath) {
        throw new ConflictException(
          `Checkout attempt path mismatch: existing attempt uses "${attempt.selectedPath}" while current mode requires "${modePlan.selectedPath}".`,
        );
      }
      if (attempt.status === 'FAILED') {
        throw new ConflictException(
          `Checkout attempt has previously failed: ${attempt.failureCode ?? 'FAILED'}`,
        );
      }
      if (!createdAttemptByUs && attempt.status === 'PROCESSING') {
        throw new ConflictException('Checkout is already in progress for this attempt.');
      }
    }

    if (modePlan.requiresCartScopedMark) {
      if (!this.checkoutReservationState) {
        await this.markCreatedAttemptFailed(
          createdAttemptByUs ? attempt : undefined,
          userId,
          'CHECKOUT_RESERVATION_UNAVAILABLE',
          'Cart-scoped reservation state service is unavailable.',
        );
        throw new ConflictException(
          'Checkout admission rejected: cart-scoped reservation engine is unavailable.',
        );
      }

      const plan = prepared.cart.items.map((item) => ({
        productId: item.productId,
        expectedQuantity: item.quantity,
      }));
      let markResult: Awaited<ReturnType<CheckoutReservationStateService['checkoutMark']>>;
      try {
        markResult = await this.checkoutReservationState.checkoutMark(
          prepared.cart.id,
          userId,
          idempotencyKey,
          plan,
          Date.now(),
          CHECKOUT_PENDING_INITIAL_LEASE_SECONDS,
        );
      } catch (markErr) {
        await this.markCreatedAttemptFailed(
          createdAttemptByUs ? attempt : undefined,
          userId,
          'CHECKOUT_MARK_ERROR',
          markErr instanceof Error ? markErr.message : String(markErr),
        );
        throw markErr;
      }
      if (!markResult.ok) {
        await this.markCreatedAttemptFailed(
          createdAttemptByUs ? attempt : undefined,
          userId,
          markResult.code ?? 'CHECKOUT_MARK_REJECTED',
          `Checkout admission rejected by reservation engine: ${markResult.code}`,
        );
        throw new ConflictException(`Checkout admission rejected by reservation engine: ${markResult.code}`);
      }
    }

    let order: OrderWithDetails;
    try {
      order = await this.prisma.$transaction((tx) =>
        this.createOrderInTransaction(
          tx,
          prepared,
          buildLegacyPricingSnapshot(prepared.cart),
          verifiedQuote,
          attempt,
        ),
      );
    } catch (error) {
      await this.markCreatedAttemptFailed(
        createdAttemptByUs ? attempt : undefined,
        userId,
        error instanceof CartMutationBarrierActiveError
          ? 'CART_MUTATION_BARRIER_ACTIVE'
          : 'ORDER_TRANSACTION_FAILED',
        error instanceof Error ? error.message : String(error),
      );
      if (error instanceof CartMutationBarrierActiveError) {
        throw new ServiceUnavailableException(CART_MUTATION_BARRIER_ACTIVE_MESSAGE);
      }
      throw error;
    }

    if (modePlan.requiresCartScopedMark && this.checkoutReservationRecovery) {
      try {
        await this.checkoutReservationRecovery.finalizeCheckoutConsumption(prepared.cart.id, idempotencyKey);
      } catch (err: any) {
        this.logger.warn(
          `Non-fatal Redis finalization failure for cart "${prepared.cart.id}". Attempt committed successfully.`,
        );
      }
    }

    // Release legacy soft holds (authoritative in LEGACY/MIRROR; defensive sweep otherwise)
    const purchasedProductIds = new Set(prepared.cart.items.map((item) => item.productId));
    for (const productId of purchasedProductIds) {
      try {
        await this.inventoryReservations.release(productId, prepared.cart.id);
      } catch (err: any) {
        this.logger.warn(
          `Non-fatal soft reservation release failure for product "${productId}" on cart "${prepared.cart.id}". Soft hold will expire via Redis TTL.`,
        );
      }

      if (
        modePlan.isMirrorMode &&
        typeof this.inventoryReservations?.releaseReservation === 'function'
      ) {
        try {
          const mirrorRelease = await this.inventoryReservations.releaseReservation(
            prepared.cart.id,
            productId,
          );
          if (mirrorRelease?.underflow) {
            this.logger.warn(
              `Non-fatal MIRROR C3 release observed underflow for product "${productId}" on cart "${prepared.cart.id}".`,
            );
          }
        } catch (err: any) {
          this.logger.warn(
            `Non-fatal MIRROR C3 release failure for product "${productId}" on cart "${prepared.cart.id}": ${err?.message ?? err}`,
          );
        }
      }
    }

    const total = order.vendorOrders.reduce(
      (sum, vendorOrder) => sum + vendorOrder.subtotal.toNumber(),
      0,
    );
    const itemCount = order.vendorOrders.reduce(
      (count, vendorOrder) => count + vendorOrder.items.length,
      0,
    );
    try {
      await this.eventEmitter.emitAsync(
        OrderPlacedEvent.eventName,
        new OrderPlacedEvent(userId, order.id, total.toFixed(2), itemCount),
      );
    } catch (err: any) {
      // F06: Log sanitized warning without leaking tokens, secrets, or PII
      this.logger.warn(
        `Non-fatal domain event emission failure for order "${order.id}". Order placement was successfully committed.`,
      );
    }

    let payment: PaymentResponseEntity | undefined;
    let paymentRedirectUrl: string | undefined;

    try {
      const initiation = await this.paymentsService.initiatePayment({
        orderId: order.id,
        amount: total,
        currency: 'JMD',
        provider: dto.paymentMethod,
      });
      payment = initiation.payment;
      paymentRedirectUrl = initiation.redirectUrl;
    } catch (paymentError) {
      // Post-commit initiation failure. The order and inventory changes are committed and durable.
      const storedPayment = await this.paymentsService.getByOrderId(order.id);

      const maxErrorLength = 500;
      // If payment-state persistence failed and the record is not in RECONCILE_REQUIRED,
      // do not falsely claim that reconciliation state was saved. Rethrow to surface persistence failure.
      if (storedPayment?.initiationStatus !== 'RECONCILE_REQUIRED') {
        this.logger.error(
          `Payment initiation failed and payment state could not be confirmed as RECONCILE_REQUIRED for order "${order.id}".`,
          {
            orderId: order.id,
            paymentId: storedPayment?.id,
            error: sanitizeErrorMessage(
              paymentError instanceof Error ? paymentError.message : String(paymentError),
              maxErrorLength,
            ),
          },
        );
        throw paymentError;
      }

      this.logger.warn(
        `Payment initiation failed after committed checkout for order "${order.id}". ` +
          `Order is durable and payment is in RECONCILE_REQUIRED status.`,
        {
          orderId: order.id,
          paymentId: storedPayment.id,
          error: sanitizeErrorMessage(
            paymentError instanceof Error ? paymentError.message : String(paymentError),
            maxErrorLength,
          ),
        },
      );

      payment = storedPayment;
      paymentRedirectUrl = undefined;
    }

    return {
      ...toOrderResponse(order),
      payment,
      paymentRedirectUrl,
    };
  }

  // Phase 16A.0-D, Unit D.1. Every read-only validation OrdersService.checkout
  // performs before opening a transaction - a typed result, not a thrown exception.
  async prepareCheckout(userId: string, dto: CheckoutDto): Promise<PrepareCheckoutResult> {
    const cart = await this.cartRepository.findOrCreateByCustomerId(userId);
    if (cart.items.length === 0) {
      return { ok: false, code: 'CART_EMPTY' };
    }

    const additionalAmountByVendorId = new Map<string, number>();

    for (const item of cart.items) {
      if (!item.product.isActive) {
        return {
          ok: false,
          code: 'PRODUCT_NOT_AVAILABLE',
          productId: item.productId,
          productName: item.product.name,
        };
      }
      if (
        item.product.lot &&
        (item.product.lot.foodSafetyStatus !== 'SAFE' ||
          !SeafoodLotsService.isGradingSellable(item.product.lot))
      ) {
        return {
          ok: false,
          code: 'PRODUCT_FOOD_SAFETY_HOLD',
          productId: item.productId,
          productName: item.product.name,
        };
      }

      const vendor = await this.vendorsRepository.findById(item.product.vendorId);
      if (!vendor || vendor.status !== 'APPROVED') {
        return {
          ok: false,
          code: 'VENDOR_NOT_APPROVED',
          productId: item.productId,
          productName: item.product.name,
        };
      }

      const itemSubtotal = item.product.price.times(item.quantity).toNumber();
      additionalAmountByVendorId.set(
        vendor.id,
        (additionalAmountByVendorId.get(vendor.id) ?? 0) + itemSubtotal,
      );
    }

    for (const [vendorId, additionalAmount] of additionalAmountByVendorId) {
      const vendor = await this.vendorsRepository.findById(vendorId);
      if (vendor) {
        try {
          await this.vendorPermissionsService.assertSalesLimitNotExceeded(
            vendorId,
            vendor.tier,
            additionalAmount,
          );
        } catch (error) {
          if (error instanceof ForbiddenException) {
            return { ok: false, code: 'VENDOR_SALES_LIMIT_EXCEEDED', vendorId, message: error.message };
          }
          throw error;
        }
      }
    }

    // Resolved directly from the global PrismaService, not a DeliveryModule
    // import: DeliveryModule already imports OrdersModule, so importing it
    // back here would create a circular dependency. See ZoneResolutionService
    // for the equivalent lookup used within DeliveryModule itself.
    const zoneMapping = await this.prisma.deliveryZoneParish.findUnique({
      where: { parish: dto.deliveryParish },
      select: { zoneId: true },
    });
    const deliveryZoneId = zoneMapping?.zoneId ?? null;

    return { ok: true, prepared: { cart, dto, deliveryZoneId } };
  }

  // Phase 16A.0-D, Unit D.1/D.1.1. The durable write portion of
  // OrdersService.checkout - requires an externally-owned
  // Prisma.TransactionClient, never opens its own $transaction, so
  // CheckoutCoordinatorService can include CheckoutAttempt's
  // PROCESSING -> COMMITTED transition in the same transaction. pricing is
  // REQUIRED, never optional - pricing.currency is the single authority
  // for both Order.currency and every OrderItem.currency; legacy checkout()
  // and the Phase-D coordinator each supply their own snapshot.
  async createOrderInTransaction(
    tx: Prisma.TransactionClient,
    prepared: PreparedCheckout,
    pricing: OrderPricingSnapshot,
    verifiedQuote?: SeafoodCheckoutQuotePayload,
    attempt?: CheckoutAttempt,
  ): Promise<OrderWithDetails> {
    await this.mutationBarrier.assertNotActive(tx);

    // F01: Parameterized PostgreSQL query via $queryRaw for exclusive transaction-scoped advisory lock
    if (verifiedQuote) {
      await tx.$queryRaw`SELECT 1 as locked FROM pg_advisory_xact_lock(hashtext('checkout_quote'), hashtext(${verifiedQuote.quoteId}))`;

      const priorConsent = await tx.customerCheckoutCeilingConsent.findFirst({
        where: { quoteId: verifiedQuote.quoteId },
        select: { id: true },
      });
      if (priorConsent) {
        throw new ConflictException(
          `Quote "${verifiedQuote.quoteId}" has already been consumed by an existing order. Duplicate checkout is rejected.`,
        );
      }
    }

    const { cart, dto, deliveryZoneId } = prepared;
    const pricingByProductId = validatePricingSnapshot(cart, pricing);
    const vendorGroups = new Map<
      string,
      { vendorId: string; subtotal: Decimal; items: VendorOrderItemInput[]; hasSeafood: boolean }
    >();
    const seafoodItemsToInitialize: Array<{
      orderItemId: string;
      quotedItem: QuotedSeafoodItem;
    }> = [];

    const quotePayloadHash = verifiedQuote ? computeQuotePayloadHash(verifiedQuote) : undefined;

    // Enforce deterministic listing lock ordering for multi-listing seafood orders to prevent deadlocks
    if (verifiedQuote) {
      const seafoodListingIds = Array.from(
        new Set(
          cart.items
            .filter((item) => this.isCatchWeightSeafoodProduct(item.product))
            .map((item) => {
              const quoted = verifiedQuote.items.find(
                (q) => q.cartItemId === item.id && q.productId === item.productId,
              );
              return quoted?.listingId;
            })
            .filter((id): id is string => typeof id === 'string' && id.length > 0),
        ),
      ).sort();

      for (const listingId of seafoodListingIds) {
        await tx.$queryRaw`SELECT id FROM vendor_daily_listings WHERE id = ${listingId} FOR UPDATE`;
      }
    }

    for (const item of cart.items) {
      const pricingLine = pricingByProductId.get(item.productId)!;

      await this.productsRepository.adjustStock(item.productId, -item.quantity, tx);

      const itemSubtotal = pricingLine.unitPrice.times(item.quantity);
      const isSeafood = Boolean(verifiedQuote && this.isCatchWeightSeafoodProduct(item.product));

      let orderItemId: string | undefined;
      let originalLotId: string | undefined;
      let originalListingId: string | undefined;
      let purchaseSnapshot: Prisma.InputJsonValue | undefined;

      if (isSeafood && verifiedQuote) {
        const quotedItem = verifiedQuote.items.find(
          (q) => q.cartItemId === item.id && q.productId === item.productId,
        );
        if (!quotedItem) {
          throw new BadRequestException(
            `Seafood item "${item.productId}" is not covered by the verified checkout quote.`,
          );
        }

        // Atomic conditional inventory decrement on authoritative listing in tx
        const updated = await tx.$queryRaw<Array<{ id: string; quantityAvailable: Decimal; quantitySold: Decimal }>>`
          UPDATE vendor_daily_listings
          SET 
            "quantityAvailable" = "quantityAvailable" - ${item.quantity}::decimal,
            "quantitySold" = "quantitySold" + ${item.quantity}::decimal,
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = ${quotedItem.listingId}
            AND status = 'PUBLISHED'
            AND "expiresAt" > CURRENT_TIMESTAMP
            AND "quantityAvailable" >= ${item.quantity}::decimal
          RETURNING id, "quantityAvailable", "quantitySold"
        `;

        if (!updated || updated.length === 0) {
          const currentListing = await tx.vendorDailyListing.findUnique({
            where: { id: quotedItem.listingId },
            select: { status: true, expiresAt: true, quantityAvailable: true },
          });
          if (!currentListing) {
            throw new NotFoundException(`Authoritative listing "${quotedItem.listingId}" was not found.`);
          }
          if (currentListing.status !== 'PUBLISHED') {
            throw new ConflictException(
              `Authoritative listing "${quotedItem.listingId}" is not published (status: ${currentListing.status}).`,
            );
          }
          if (new Date(currentListing.expiresAt).getTime() <= Date.now()) {
            throw new BadRequestException(
              `Authoritative listing "${quotedItem.listingId}" has expired.`,
            );
          }
          if (new Decimal(currentListing.quantityAvailable).lessThan(item.quantity)) {
            throw new ConflictException(
              `Insufficient inventory for listing "${quotedItem.listingId}": requested ${item.quantity}, but only ${currentListing.quantityAvailable} available.`,
            );
          }
          throw new ConflictException(
            `Listing inventory update failed for listing "${quotedItem.listingId}".`,
          );
        }

        // F03: Authoritative database verification against current state in tx
        const listing = await tx.vendorDailyListing.findUnique({
          where: { id: quotedItem.listingId },
          include: { lot: true, vendor: true, product: true },
        });

        if (!listing) {
          throw new BadRequestException(
            `Authoritative listing "${quotedItem.listingId}" for product "${item.productId}" was not found.`,
          );
        }

        // 1. Relational consistency: product and vendor match
        if (listing.productId !== item.productId) {
          throw new ConflictException(
            `Authoritative listing product "${listing.productId}" does not match cart item product "${item.productId}".`,
          );
        }
        if (listing.vendorId !== item.product.vendorId) {
          throw new ConflictException(
            `Authoritative listing vendor "${listing.vendorId}" does not match product vendor "${item.product.vendorId}".`,
          );
        }

        // 2. Relational consistency: lot identity and ownership
        if (listing.lotId !== quotedItem.lotId) {
          throw new ConflictException(
            `Authoritative listing lot "${listing.lotId}" does not match quote lot "${quotedItem.lotId}".`,
          );
        }
        if (!listing.lot) {
          throw new BadRequestException(
            `Authoritative seafood lot "${listing.lotId}" was not found for listing "${listing.id}".`,
          );
        }
        if (listing.lot.vendorId !== item.product.vendorId) {
          throw new ConflictException(
            `Authoritative lot vendor "${listing.lot.vendorId}" does not match product vendor "${item.product.vendorId}".`,
          );
        }

        // 3. F03: Lot food-safety verification - NO DEFAULTS! Real DB status only
        if (!listing.lot.foodSafetyStatus || listing.lot.foodSafetyStatus !== 'SAFE') {
          throw new BadRequestException(
            `Seafood product "${item.product.name}" lot is not SAFE (status: "${listing.lot.foodSafetyStatus ?? 'UNKNOWN'}").`,
          );
        }
        if (!SeafoodLotsService.isGradingSellable(listing.lot)) {
          throw new BadRequestException(
            `Seafood product "${item.product.name}" lot grading is not sellable.`,
          );
        }

        // 4. Listing lifecycle status and expiration check
        if (listing.status !== 'PUBLISHED') {
          throw new BadRequestException(
            `Authoritative listing "${listing.id}" is not active (status: "${listing.status}").`,
          );
        }
        if (new Date(listing.expiresAt).getTime() <= Date.now()) {
          throw new BadRequestException(
            `Authoritative listing "${listing.id}" expired at "${listing.expiresAt.toISOString()}".`,
          );
        }

        // 5. Unit price consistency between quote and authoritative listing
        if (!new Decimal(quotedItem.unitPrice).equals(listing.price)) {
          throw new ConflictException(
            `Quoted unit price (${quotedItem.unitPrice}) does not match authoritative listing price (${listing.price.toFixed(2)}).`,
          );
        }

        orderItemId = crypto.randomUUID();
        originalLotId = listing.lotId;
        originalListingId = listing.id;

        const snapshot = buildProvenanceSnapshotV2({
          orderItemId,
          listing: {
            id: listing.id,
            vendorId: listing.vendorId,
            lotId: listing.lotId,
            productId: listing.productId,
          },
          lot: {
            id: listing.lot.id,
            vendorId: listing.lot.vendorId,
            species: listing.lot.species ?? undefined,
            foodSafetyStatus: listing.lot.foodSafetyStatus, // Real DB status, never defaulted
          },
          product: {
            id: item.product.id,
            name: item.product.name,
            description: item.product.description ?? null,
            weightLbs: item.product.weightLbs ?? undefined,
          },
          unit: item.product.unit,
          unitPrice: quotedItem.unitPrice,
          currency: 'JMD',
          pieceCount: quotedItem.pieceCount,
          estimatedWeightLbs:
            quotedItem.estimatedBillableWeight !== undefined && quotedItem.estimatedBillableWeight !== null
              ? Number(quotedItem.estimatedBillableWeight)
              : undefined,
          fishCount: quotedItem.fishCount ?? undefined,
          originalWholeWeightLbs: quotedItem.originalWholeWeightLbs ?? undefined,
          originalWholeWeightUnit: quotedItem.originalWholeWeightUnit ?? undefined,
          pricingBasis: quotedItem.pricingBasis,
          selectedPreparationOption: quotedItem.selectedPreparationOption
            ? {
                id: quotedItem.selectedPreparationOption.id,
                name: quotedItem.selectedPreparationOption.name,
                chargeMethod: quotedItem.selectedPreparationOption.chargeMethod,
                rate: quotedItem.selectedPreparationOption.rate,
                fee: quotedItem.selectedPreparationOption.fee,
                currency: 'JMD',
              }
            : undefined,
          usablePartsPreference: quotedItem.usablePartsPreference ?? undefined,
          authorizedCeilingJmd: quotedItem.customerAuthorizedCeilingJmd,
          termsVersion: verifiedQuote.termsVersion,
          quoteId: verifiedQuote.quoteId,
          payloadHash: quotePayloadHash!,
          consentedAt: verifiedQuote.issuedAt,
          purchasedAt: new Date().toISOString(),
        });

        purchaseSnapshot = snapshot as unknown as Prisma.InputJsonValue;
        seafoodItemsToInitialize.push({ orderItemId, quotedItem });
      }

      // F04: For seafood items, pass exact Decimal to preserve monetary precision.
      // For ordinary grocery, preserve existing numeric pricing semantics.
      const unitPriceValue = isSeafood ? pricingLine.unitPrice : pricingLine.unitPrice.toNumber();
      const subtotalValue = isSeafood ? itemSubtotal : itemSubtotal.toNumber();

      const orderItem: VendorOrderItemInput = {
        ...(orderItemId ? { id: orderItemId } : {}),
        productId: item.productId,
        productName: item.product.name,
        unitPrice: unitPriceValue,
        unit: item.product.unit,
        quantity: item.quantity,
        subtotal: subtotalValue,
        currency: pricing.currency,
        ...(originalLotId ? { originalLotId } : {}),
        ...(originalListingId ? { originalListingId } : {}),
        ...(purchaseSnapshot ? { purchaseSnapshot } : {}),
      };

      const existingGroup = vendorGroups.get(item.product.vendorId);
      if (existingGroup) {
        existingGroup.items.push(orderItem);
        existingGroup.subtotal = existingGroup.subtotal.plus(itemSubtotal);
        if (isSeafood) {
          existingGroup.hasSeafood = true;
        }
      } else {
        vendorGroups.set(item.product.vendorId, {
          vendorId: item.product.vendorId,
          subtotal: itemSubtotal,
          items: [orderItem],
          hasSeafood: isSeafood,
        });
      }
    }

    const created = await this.ordersRepository.create(
      {
        customerId: cart.customerId,
        deliveryAddressLine1: dto.deliveryAddressLine1,
        deliveryAddressLine2: dto.deliveryAddressLine2,
        deliveryParish: dto.deliveryParish,
        deliveryPhone: dto.deliveryPhone,
        deliveryZoneId,
        currency: pricing.currency,
        vendorOrders: Array.from(vendorGroups.values()).map((g) => ({
          vendorId: g.vendorId,
          subtotal: g.subtotal,
          items: g.items,
        })),
      },
      tx,
    );

    for (const vendorOrder of created.vendorOrders) {
      for (const item of vendorOrder.items) {
        await this.inventoryEventsRepository.create(
          {
            productId: item.productId,
            eventType: 'DECREMENTED',
            quantityDelta: -item.quantity,
            vendorOrderId: vendorOrder.id,
          },
          tx,
        );
      }
    }

    if (verifiedQuote && seafoodItemsToInitialize.length > 0) {
      for (const { orderItemId, quotedItem } of seafoodItemsToInitialize) {
        await this.weightAdjustmentSnapshotInitializationService.initializeSnapshot(
          {
            orderItemId,
            authoritativeListingId: quotedItem.listingId,
            customerAuthorizedCeilingJmd: quotedItem.customerAuthorizedCeilingJmd,
            termsVersion: verifiedQuote.termsVersion,
            explicitPricingBasis: quotedItem.pricingBasis,
            selectedPreparationServiceName: quotedItem.selectedPreparationOption?.name,
            usablePartsPreference: quotedItem.usablePartsPreference,
            preparationChargeMethod: quotedItem.selectedPreparationOption?.chargeMethod,
            fishCount: quotedItem.fishCount,
            originalWholeWeightLbs: quotedItem.originalWholeWeightLbs,
            originalWholeWeightUnit: quotedItem.originalWholeWeightUnit,
            quoteId: verifiedQuote.quoteId,
            quotePayloadHash,
            consentedAt: verifiedQuote.issuedAt,
          },
          tx,
        );
      }
    }

    // DA.1B checkout-clear correction: clear() alone never advances the
    // sync marker - pair it with advanceForClearedCart in this same tx.
    await this.cartRepository.clear(cart.id, tx);
    await this.syncStateRepository.advanceForClearedCart(
      cart.id,
      cart.items.map((item) => ({ productId: item.productId, mutationVersion: item.mutationVersion })),
      tx,
    );

    if (attempt && this.checkoutAttemptRepository) {
      const commitResult = await this.checkoutAttemptRepository.markCommitted(
        tx,
        attempt.id,
        cart.customerId,
        created.id,
        new Date(),
      );
      if (commitResult.count === 0) {
        throw new ConflictException('Checkout attempt was terminally fenced or expired by recovery.');
      }
    }

    return created;
  }

  async getCustomerOrders(
    userId: string,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedOrdersEntity> {
    const { items, total } = await this.ordersRepository.findManyByCustomer(userId, {
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    });

    const withPayments = await Promise.all(items.map((order) => this.toResponseWithPayment(order)));

    return {
      items: withPayments,
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async getCustomerOrderById(userId: string, orderId: string): Promise<OrderResponseEntity> {
    const order = await this.getOwnedOrder(userId, orderId);
    return this.toResponseWithPayment(order);
  }

  async cancelOrder(userId: string, orderId: string): Promise<OrderResponseEntity> {
    const order = await this.getOwnedOrder(userId, orderId);

    const cancellable = order.vendorOrders.filter(
      (vendorOrder) => vendorOrder.status === CANCELLABLE_STATUS,
    );
    if (cancellable.length === 0) {
      throw new BadRequestException(
        'No part of this order is still pending, so none of it can be cancelled',
      );
    }

    // Sort cancellable vendor orders by id ASC for canonical lock hierarchy
    const sortedCancellable = [...cancellable].sort((a, b) => a.id.localeCompare(b.id));

    await this.prisma.$transaction(async (tx) => {
      // Canonical row locking: Order -> VendorOrders (id ASC) -> Payment -> Products (id ASC) -> Listings (id ASC)
      let paymentRow: { id: string; status: PaymentStatus; amount: Prisma.Decimal } | null = null;

      if ((tx as any).$queryRaw) {
        // 1. Lock Order parent row
        await (tx as any).$queryRaw(
          Prisma.sql`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`,
        );

        // 2. Lock VendorOrders child rows in deterministic ascending ID order
        await (tx as any).$queryRaw(
          Prisma.sql`SELECT "id", "status" FROM "vendor_orders" WHERE "orderId" = ${orderId} ORDER BY "id" ASC FOR UPDATE`,
        );

        // 3. Lock Payment row
        const paymentRows = (await (tx as any).$queryRaw(
          Prisma.sql`SELECT "id", "status", "amount" FROM "payments" WHERE "orderId" = ${orderId} FOR UPDATE`,
        )) as Array<{ id: string; status: PaymentStatus; amount: Prisma.Decimal }>;
        paymentRow = paymentRows[0] ?? null;

        // 4. Lock Products across all cancellable items in deterministic ascending ID order
        const allProductIds = Array.from(
          new Set(sortedCancellable.flatMap((vo) => vo.items.map((i) => i.productId))),
        ).sort();
        for (const pid of allProductIds) {
          await (tx as any).$queryRaw(
            Prisma.sql`SELECT "id" FROM "products" WHERE "id" = ${pid} FOR UPDATE`,
          );
        }

        // 5. Lock VendorDailyListings across all cancellable items in deterministic ascending ID order
        const allListingIds = Array.from(
          new Set(
            sortedCancellable
              .flatMap((vo) => vo.items.map((i) => i.originalListingId))
              .filter(Boolean) as string[],
          ),
        ).sort();
        for (const lid of allListingIds) {
          await (tx as any).$queryRaw(
            Prisma.sql`SELECT "id" FROM "vendor_daily_listings" WHERE "id" = ${lid} FOR UPDATE`,
          );
        }
      } else if ((tx as any).payment?.findUnique) {
        paymentRow = await (tx as any).payment.findUnique({ where: { orderId } });
      }

      for (const vendorOrder of sortedCancellable) {
        await this.restoreStockAndCancel(vendorOrder, tx);
      }

      if (
        paymentRow &&
        (paymentRow.status === PaymentStatus.PAID ||
          paymentRow.status === PaymentStatus.PARTIALLY_REFUNDED)
      ) {
        await this.createRefundObligation(
          tx,
          paymentRow,
          sortedCancellable,
          `refund_order_cancel_${paymentRow.id}`,
          'Customer order cancellation',
        );
      }
    });

    const updated = await this.getOwnedOrder(userId, orderId);
    return this.toResponseWithPayment(updated);
  }

  async cancelVendorOrder(
    userId: string,
    orderId: string,
    vendorOrderId: string,
  ): Promise<OrderResponseEntity> {
    const order = await this.getOwnedOrder(userId, orderId);
    const vendorOrder = order.vendorOrders.find((candidate) => candidate.id === vendorOrderId);
    if (!vendorOrder) {
      throw new NotFoundException('Vendor order not found');
    }
    if (vendorOrder.status !== CANCELLABLE_STATUS) {
      throw new BadRequestException(
        'This part of the order has already been accepted and can no longer be cancelled',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // Canonical row locking: Order -> VendorOrders (id ASC) -> Payment -> Products (id ASC) -> Listings (id ASC)
      let paymentRow: { id: string; status: PaymentStatus; amount: Prisma.Decimal } | null = null;

      if ((tx as any).$queryRaw) {
        // 1. Lock Order parent row
        await (tx as any).$queryRaw(
          Prisma.sql`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`,
        );

        // 2. Lock VendorOrders child rows in deterministic ascending ID order
        await (tx as any).$queryRaw(
          Prisma.sql`SELECT "id", "status" FROM "vendor_orders" WHERE "orderId" = ${orderId} ORDER BY "id" ASC FOR UPDATE`,
        );

        // 3. Lock Payment row
        const paymentRows = (await (tx as any).$queryRaw(
          Prisma.sql`SELECT "id", "status", "amount" FROM "payments" WHERE "orderId" = ${orderId} FOR UPDATE`,
        )) as Array<{ id: string; status: PaymentStatus; amount: Prisma.Decimal }>;
        paymentRow = paymentRows[0] ?? null;

        // 4. Lock Products of this vendor order in deterministic ascending ID order
        const sortedProductIds = Array.from(
          new Set(vendorOrder.items.map((i) => i.productId)),
        ).sort();
        for (const pid of sortedProductIds) {
          await (tx as any).$queryRaw(
            Prisma.sql`SELECT "id" FROM "products" WHERE "id" = ${pid} FOR UPDATE`,
          );
        }

        // 5. Lock VendorDailyListings of this vendor order in deterministic ascending ID order
        const listingIds = Array.from(
          new Set(
            vendorOrder.items.map((i) => i.originalListingId).filter(Boolean) as string[],
          ),
        ).sort();
        for (const lid of listingIds) {
          await (tx as any).$queryRaw(
            Prisma.sql`SELECT "id" FROM "vendor_daily_listings" WHERE "id" = ${lid} FOR UPDATE`,
          );
        }
      } else if ((tx as any).payment?.findUnique) {
        paymentRow = await (tx as any).payment.findUnique({ where: { orderId } });
      }

      await this.restoreStockAndCancel(vendorOrder, tx);

      if (
        paymentRow &&
        (paymentRow.status === PaymentStatus.PAID ||
          paymentRow.status === PaymentStatus.PARTIALLY_REFUNDED)
      ) {
        await this.createRefundObligation(
          tx,
          paymentRow,
          [vendorOrder],
          `refund_vendor_order_cancel_${paymentRow.id}_${vendorOrder.id}`,
          'Customer vendor order cancellation',
        );
      }
    });

    const updated = await this.getOwnedOrder(userId, orderId);
    return this.toResponseWithPayment(updated);
  }

  private async createRefundObligation(
    tx: Prisma.TransactionClient,
    payment: { id: string; status: PaymentStatus; amount: Prisma.Decimal | number | string },
    cancelledVendorOrders: Array<{ subtotal: Prisma.Decimal | number | string }>,
    idempotencyKey: string,
    reason: string,
  ): Promise<void> {
    await createOrPreserveRefundObligation(
      tx,
      payment,
      cancelledVendorOrders,
      idempotencyKey,
      reason,
    );
  }

  private async restoreStockAndCancel(
    vendorOrder: VendorOrder & { items: OrderItem[] },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await restoreVendorOrderStockAndTransition({
      vendorOrder,
      targetStatus: 'CANCELLED',
      dispositionLabel: 'EXPIRED_ON_CANCEL',
      tx,
      productsRepository: this.productsRepository,
      inventoryEventsRepository: this.inventoryEventsRepository,
      vendorOrdersRepository: this.vendorOrdersRepository,
    });
  }
  private async getOwnedOrder(userId: string, orderId: string): Promise<OrderWithDetails> {
    const order = await this.ordersRepository.findById(orderId);
    if (!order || order.customerId !== userId) {
      throw new ForbiddenException('You do not have access to this order');
    }
    return order;
  }

  private async toResponseWithPayment(order: OrderWithDetails): Promise<OrderResponseEntity> {
    const payment = await this.paymentsService.getByOrderId(order.id);
    return { ...toOrderResponse(order), payment: payment ?? undefined };
  }

  // D.2: exposes toResponse for a caller with a payment result already in
  // hand (CheckoutCoordinatorService), avoiding an extra getByOrderId read.
  toOrderResponseWithPayment(
    order: OrderWithDetails,
    payment?: PaymentResponseEntity,
    paymentRedirectUrl?: string,
  ): OrderResponseEntity {
    return { ...toOrderResponse(order), payment, paymentRedirectUrl };
  }
}
