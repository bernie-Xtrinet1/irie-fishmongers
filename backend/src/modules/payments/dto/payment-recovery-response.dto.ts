import { ApiProperty } from '@nestjs/swagger';
import { PaymentStatus } from '@prisma/client';

import { PaymentResponseEntity } from '../entities/payment-response.entity';
import { CustomerPaymentState } from './payment-status-response.dto';

export enum RecoveryAction {
  HOLD = 'HOLD',
  RETRY_AUTHORIZED = 'RETRY_AUTHORIZED',
  ALREADY_COMPLETED = 'ALREADY_COMPLETED',
  CANCELLED = 'CANCELLED',
}

export class PaymentRecoveryResponseEntity {
  @ApiProperty({ enum: RecoveryAction, description: 'Recovery decision action' })
  action!: RecoveryAction;

  @ApiProperty({ enum: PaymentStatus, description: 'Current payment status' })
  status!: PaymentStatus;

  @ApiProperty({ enum: CustomerPaymentState, description: 'Customer-safe consolidated payment state' })
  customerState!: CustomerPaymentState;

  @ApiProperty({ description: 'Whether payment confirmation is pending from the gateway' })
  isPendingConfirmation!: boolean;

  @ApiProperty({ description: 'Whether the payment is awaiting reconciliation' })
  isReconciliationRequired!: boolean;

  @ApiProperty({ description: 'Whether a gateway retry was authorized and dispatched' })
  isRetryAuthorized!: boolean;

  @ApiProperty({ description: 'Whether customer should wait for authoritative confirmation' })
  shouldWaitForConfirmation!: boolean;

  @ApiProperty({ description: 'Provider hosted checkout redirect URL if retry was authorized', nullable: true, required: false })
  redirectUrl!: string | null;

  @ApiProperty({ description: 'Customer-safe advisory message describing current recovery state' })
  message!: string;

  @ApiProperty({ type: PaymentResponseEntity, description: 'Current payment entity', nullable: true, required: false })
  payment!: PaymentResponseEntity | null;
}
