import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Payment,
  PaymentInitiationStatus,
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  RoleName,
  VendorOrderStatus,
} from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../../database/prisma.service';
import {
  CustomerPaymentState,
  PaymentStatusResponseEntity,
} from '../dto/payment-status-response.dto';
import {
  PaymentRecoveryResponseEntity,
  RecoveryAction,
} from '../dto/payment-recovery-response.dto';
import { PaymentResponseEntity } from '../entities/payment-response.entity';
import { PaymentsService } from './payments.service';

@Injectable()
export class PaymentRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  /**
   * Read-only status inquiry scoped to authenticated customer or administrator.
   * Derives all status fields strictly from persisted database state without leaking
   * provider reference keys, raw credentials, merchant account details or diagnostic logs.
   */
  async getPaymentStatus(orderId: string, user: RequestUser): Promise<PaymentStatusResponseEntity> {
    const order = await this.findOrderScoped(orderId, user);

    const allVendorOrdersCancelled =
      order.vendorOrders.length > 0 &&
      order.vendorOrders.every((vo) => vo.status === VendorOrderStatus.CANCELLED);

    const payment = order.payment;

    if (!payment) {
      const orderAmount = order.vendorOrders
        .reduce((sum, vo) => sum.plus(vo.subtotal), new Prisma.Decimal(0))
        .toFixed(2);

      return {
        orderId: order.id,
        paymentId: null,
        provider: null,
        status: 'NOT_INITIATED',
        initiationStatus: PaymentInitiationStatus.NOT_STARTED,
        customerState: CustomerPaymentState.NOT_INITIATED,
        isPendingConfirmation: false,
        isReconciliationRequired: false,
        isRecoveryPermitted: false,
        isConfirmed: false,
        orderFulfillmentEligible: false,
        allVendorOrdersCancelled,
        amount: orderAmount,
        currency: order.currency ?? 'JMD',
        paidAt: null,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      };
    }

    const isConfirmed = payment.status === PaymentStatus.PAID;
    const isPendingConfirmation =
      payment.status === PaymentStatus.PENDING &&
      !allVendorOrdersCancelled &&
      (payment.initiationStatus === PaymentInitiationStatus.ESTABLISHED ||
        payment.initiationStatus === PaymentInitiationStatus.INITIATING);
    const isReconciliationRequired =
      payment.initiationStatus === PaymentInitiationStatus.RECONCILE_REQUIRED;
    const orderFulfillmentEligible = isConfirmed && !allVendorOrdersCancelled;

    // Fail-closed recovery permission: only provably unsubmitted (NOT_STARTED)
    // payments with uncancelled orders are permitted to initiate via recovery API.
    const isRecoveryPermitted =
      !allVendorOrdersCancelled &&
      !isConfirmed &&
      payment.status !== PaymentStatus.REFUNDED &&
      payment.status !== PaymentStatus.PARTIALLY_REFUNDED &&
      payment.initiationStatus === PaymentInitiationStatus.NOT_STARTED;

    const customerState = this.deriveCustomerState(payment, allVendorOrdersCancelled);

    return {
      orderId: order.id,
      paymentId: payment.id,
      provider: payment.provider,
      status: payment.status,
      initiationStatus: payment.initiationStatus,
      customerState,
      isPendingConfirmation,
      isReconciliationRequired,
      isRecoveryPermitted,
      isConfirmed,
      orderFulfillmentEligible,
      allVendorOrdersCancelled,
      amount: payment.amount.toFixed(2),
      currency: payment.currency,
      paidAt: payment.paidAt,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
    };
  }

  /**
   * Fail-closed recovery endpoint. Distinguishes confirmed-paid, cancelled,
   * pending, reconciliation-required, and provably unsubmitted states.
   */
  async recoverPayment(orderId: string, user: RequestUser): Promise<PaymentRecoveryResponseEntity> {
    const order = await this.findOrderScoped(orderId, user);

    if (!order.payment) {
      throw new NotFoundException('Payment not found for order');
    }

    const payment = order.payment;

    const allVendorOrdersCancelled =
      order.vendorOrders.length > 0 &&
      order.vendorOrders.every((vo) => vo.status === VendorOrderStatus.CANCELLED);

    // 1. Cancelled order check: reject reinitiation, never reopen cancelled orders
    if (allVendorOrdersCancelled) {
      throw new ConflictException('Order has been cancelled and cannot be recovered or paid');
    }

    // 2. Confirmed paid check: non-mutating terminal conflict
    if (payment.status === PaymentStatus.PAID) {
      throw new ConflictException('Payment has already been completed');
    }

    // 3. Refunded check
    if (
      payment.status === PaymentStatus.REFUNDED ||
      payment.status === PaymentStatus.PARTIALLY_REFUNDED
    ) {
      throw new ConflictException('Payment has been refunded and cannot be recovered');
    }

    // 4. Provably unsubmitted initiation (NOT_STARTED):
    // Initiates safely using the existing PaymentsService atomic initiation claim.
    if (payment.initiationStatus === PaymentInitiationStatus.NOT_STARTED) {
      const initiationResult = await this.paymentsService.initiatePayment({
        orderId: payment.orderId,
        provider: payment.provider,
        amount: payment.amount.toNumber(),
        currency: payment.currency,
      });

      // The caller that successfully claimed and dispatched initiation receives the redirectUrl field in initiationResult.
      // Concurrent callers that failed the atomic claim receive { payment } without the redirectUrl property.
      const isClaimant = 'redirectUrl' in initiationResult;
      const isAuthorized =
        isClaimant &&
        (!!initiationResult.redirectUrl ||
          initiationResult.payment.status === PaymentStatus.PAID ||
          initiationResult.payment.provider === PaymentProviderName.CASH_ON_DELIVERY);

      return {
        action: isAuthorized ? RecoveryAction.RETRY_AUTHORIZED : RecoveryAction.HOLD,
        status: initiationResult.payment.status,
        customerState:
          initiationResult.payment.status === PaymentStatus.PAID
            ? CustomerPaymentState.PAID
            : CustomerPaymentState.PENDING_CONFIRMATION,
        isPendingConfirmation: initiationResult.payment.status === PaymentStatus.PENDING,
        isReconciliationRequired:
          initiationResult.payment.initiationStatus === PaymentInitiationStatus.RECONCILE_REQUIRED,
        isRetryAuthorized: isAuthorized,
        shouldWaitForConfirmation: initiationResult.payment.status === PaymentStatus.PENDING,
        redirectUrl: initiationResult.redirectUrl ?? null,
        message: isAuthorized
          ? 'Payment initiation has been authorized and dispatched.'
          : 'Payment initiation is currently in progress or awaiting confirmation.',
        payment: initiationResult.payment,
      };
    }

    // 5. Pending provider outcome (ESTABLISHED + PENDING)
    if (
      payment.initiationStatus === PaymentInitiationStatus.ESTABLISHED &&
      payment.status === PaymentStatus.PENDING
    ) {
      return {
        action: RecoveryAction.HOLD,
        status: PaymentStatus.PENDING,
        customerState: CustomerPaymentState.PENDING_CONFIRMATION,
        isPendingConfirmation: true,
        isReconciliationRequired: false,
        isRetryAuthorized: false,
        shouldWaitForConfirmation: true,
        redirectUrl: null,
        message: 'Payment is awaiting provider confirmation. Please wait.',
        payment: this.toPaymentResponse(payment),
      };
    }

    // 6. Reconciliation required: a null providerReference does NOT prove the provider
    // was not contacted. Fails closed with non-mutating recovery hold.
    if (payment.initiationStatus === PaymentInitiationStatus.RECONCILE_REQUIRED) {
      return {
        action: RecoveryAction.HOLD,
        status: payment.status,
        customerState: CustomerPaymentState.RECONCILE_REQUIRED,
        isPendingConfirmation: false,
        isReconciliationRequired: true,
        isRetryAuthorized: false,
        shouldWaitForConfirmation: true,
        redirectUrl: null,
        message:
          'Payment initiation timed out or dropped. Reconciliation is in progress; please wait for automated reconciliation or contact support.',
        payment: this.toPaymentResponse(payment),
      };
    }

    // 7. INITIATING: In-flight initiation from concurrent request
    if (payment.initiationStatus === PaymentInitiationStatus.INITIATING) {
      return {
        action: RecoveryAction.HOLD,
        status: payment.status,
        customerState: CustomerPaymentState.PENDING_CONFIRMATION,
        isPendingConfirmation: true,
        isReconciliationRequired: false,
        isRetryAuthorized: false,
        shouldWaitForConfirmation: true,
        redirectUrl: null,
        message: 'Payment initiation is currently in progress. Please wait.',
        payment: this.toPaymentResponse(payment),
      };
    }

    // 8. FAILED initiation or payment status: fail-closed hold
    return {
      action: RecoveryAction.HOLD,
      status: payment.status,
      customerState: CustomerPaymentState.FAILED,
      isPendingConfirmation: false,
      isReconciliationRequired: false,
      isRetryAuthorized: false,
      shouldWaitForConfirmation: false,
      redirectUrl: null,
      message: 'Payment failed. Re-initiation is deferred; please contact customer support.',
      payment: this.toPaymentResponse(payment),
    };
  }

  private async findOrderScoped(orderId: string, user: RequestUser) {
    const isAdmin = user.roles.includes(RoleName.ADMINISTRATOR);
    const order = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        ...(isAdmin ? {} : { customerId: user.id }),
      },
      include: {
        vendorOrders: true,
        payment: true,
      },
    });

    if (!order) {
      // Return 404 for nonexistent or unowned orders without leaking ownership information
      throw new NotFoundException('Order not found');
    }

    return order;
  }

  private deriveCustomerState(payment: Payment, allVendorOrdersCancelled: boolean): CustomerPaymentState {
    if (payment.status === PaymentStatus.PAID) {
      return allVendorOrdersCancelled
        ? CustomerPaymentState.CANCELLED_REFUND_PENDING
        : CustomerPaymentState.PAID;
    }

    if (payment.status === PaymentStatus.REFUNDED) {
      return CustomerPaymentState.REFUNDED;
    }

    if (payment.status === PaymentStatus.PARTIALLY_REFUNDED) {
      return CustomerPaymentState.PARTIALLY_REFUNDED;
    }

    if (allVendorOrdersCancelled) {
      return CustomerPaymentState.CANCELLED_UNPAID;
    }

    if (payment.initiationStatus === PaymentInitiationStatus.RECONCILE_REQUIRED) {
      return CustomerPaymentState.RECONCILE_REQUIRED;
    }

    if (payment.initiationStatus === PaymentInitiationStatus.NOT_STARTED) {
      return CustomerPaymentState.NOT_INITIATED;
    }

    if (
      payment.status === PaymentStatus.FAILED ||
      payment.initiationStatus === PaymentInitiationStatus.FAILED
    ) {
      return CustomerPaymentState.FAILED;
    }

    return CustomerPaymentState.PENDING_CONFIRMATION;
  }

  private toPaymentResponse(payment: Payment): PaymentResponseEntity {
    return {
      id: payment.id,
      orderId: payment.orderId,
      provider: payment.provider,
      status: payment.status,
      initiationStatus: payment.initiationStatus,
      amount: payment.amount.toFixed(2),
      currency: payment.currency,
      paidAt: payment.paidAt,
      createdAt: payment.createdAt,
    };
  }
}
