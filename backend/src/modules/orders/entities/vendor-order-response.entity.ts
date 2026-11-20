import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentProviderName, RefundStatus, VendorOrderStatus } from '@prisma/client';

import { OrderItemResponseEntity } from './order-item-response.entity';

export type VendorOrderRefundOperationalStatus =
  | 'REFUND_COMPLETED'
  | 'MANUAL_REFUND_REQUIRED'
  | 'REFUND_IN_PROGRESS'
  | 'REFUND_RECONCILIATION_REQUIRED'
  | 'REFUND_FAILED';

export class VendorOrderRefundObligationEntity {
  @ApiProperty()
  refundId!: string;

  @ApiProperty({ enum: RefundStatus })
  status!: RefundStatus;

  @ApiProperty()
  amount!: string;

  @ApiProperty()
  currency!: string;

  @ApiProperty({ enum: PaymentProviderName })
  provider!: PaymentProviderName;

  @ApiProperty()
  automatedRefundSupported!: boolean;

  @ApiProperty()
  manualRefundRequired!: boolean;

  @ApiProperty()
  operationalStatus!: VendorOrderRefundOperationalStatus;

  @ApiProperty()
  message!: string;
}

export class VendorOrderResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  orderId!: string;

  @ApiProperty()
  vendorId!: string;

  @ApiProperty({ enum: VendorOrderStatus })
  status!: VendorOrderStatus;

  @ApiProperty()
  subtotal!: string;

  @ApiProperty({ type: OrderItemResponseEntity, isArray: true })
  items!: OrderItemResponseEntity[];

  @ApiProperty()
  createdAt!: Date;

  @ApiPropertyOptional({ type: () => VendorOrderRefundObligationEntity })
  refundObligation?: VendorOrderRefundObligationEntity;
}
