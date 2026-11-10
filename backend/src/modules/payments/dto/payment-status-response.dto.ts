import { ApiProperty } from '@nestjs/swagger';
import { PaymentInitiationStatus, PaymentProviderName, PaymentStatus } from '@prisma/client';

export enum CustomerPaymentState {
  NOT_INITIATED = 'NOT_INITIATED',
  PENDING_CONFIRMATION = 'PENDING_CONFIRMATION',
  RECONCILE_REQUIRED = 'RECONCILE_REQUIRED',
  PAID = 'PAID',
  FAILED = 'FAILED',
  CANCELLED_UNPAID = 'CANCELLED_UNPAID',
  CANCELLED_REFUND_PENDING = 'CANCELLED_REFUND_PENDING',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  REFUNDED = 'REFUNDED',
}

export class PaymentStatusResponseEntity {
  @ApiProperty({ description: 'Order identifier' })
  orderId!: string;

  @ApiProperty({ description: 'Payment identifier, or null if uninitiated', nullable: true, required: false })
  paymentId!: string | null;

  @ApiProperty({ enum: PaymentProviderName, description: 'Configured payment provider', nullable: true, required: false })
  provider!: PaymentProviderName | null;

  @ApiProperty({ description: 'Current payment status', enum: PaymentStatus })
  status!: PaymentStatus | 'NOT_INITIATED';

  @ApiProperty({ enum: PaymentInitiationStatus, description: 'Gateway initiation status' })
  initiationStatus!: PaymentInitiationStatus;

  @ApiProperty({ enum: CustomerPaymentState, description: 'Customer-safe consolidated payment state' })
  customerState!: CustomerPaymentState;

  @ApiProperty({ description: 'Whether the payment is awaiting authoritative provider settlement' })
  isPendingConfirmation!: boolean;

  @ApiProperty({ description: 'Whether initiation or settlement is held pending manual or automated reconciliation' })
  isReconciliationRequired!: boolean;

  @ApiProperty({ description: 'Whether payment re-initiation is permitted based on verified durable proof' })
  isRecoveryPermitted!: boolean;

  @ApiProperty({ description: 'Whether the payment has authoritatively settled as PAID' })
  isConfirmed!: boolean;

  @ApiProperty({ description: 'Whether the order is eligible for merchant fulfillment' })
  orderFulfillmentEligible!: boolean;

  @ApiProperty({ description: 'Whether every vendor order belonging to the parent order has been cancelled' })
  allVendorOrdersCancelled!: boolean;

  @ApiProperty({ description: 'Total payment or order amount' })
  amount!: string;

  @ApiProperty({ description: 'Payment currency code', default: 'JMD' })
  currency!: string;

  @ApiProperty({ description: 'Timestamp when settlement was confirmed', nullable: true, required: false })
  paidAt!: Date | null;

  @ApiProperty({ description: 'Timestamp when order or payment was created' })
  createdAt!: Date;

  @ApiProperty({ description: 'Timestamp when order or payment was last updated' })
  updatedAt!: Date;
}
