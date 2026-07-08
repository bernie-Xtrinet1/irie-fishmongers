import { ApiProperty } from '@nestjs/swagger';
import { Parish } from '@prisma/client';

import { PaymentResponseEntity } from '../../payments/entities/payment-response.entity';
import { VendorOrderResponseEntity } from './vendor-order-response.entity';

export class OrderResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  customerId!: string;

  @ApiProperty()
  deliveryAddressLine1!: string;

  @ApiProperty({ required: false, nullable: true })
  deliveryAddressLine2!: string | null;

  @ApiProperty({ enum: Parish })
  deliveryParish!: Parish;

  @ApiProperty()
  deliveryPhone!: string;

  @ApiProperty({ required: false, nullable: true })
  deliveryZoneId!: string | null;

  @ApiProperty({ type: VendorOrderResponseEntity, isArray: true })
  vendorOrders!: VendorOrderResponseEntity[];

  @ApiProperty({ type: PaymentResponseEntity, required: false })
  payment?: PaymentResponseEntity;

  @ApiProperty({
    required: false,
    description: 'Hosted checkout URL to redirect the customer to for online providers',
  })
  paymentRedirectUrl?: string;

  @ApiProperty()
  createdAt!: Date;
}
