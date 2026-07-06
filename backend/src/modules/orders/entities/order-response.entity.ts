import { ApiProperty } from '@nestjs/swagger';
import { Parish } from '@prisma/client';

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

  @ApiProperty({ type: VendorOrderResponseEntity, isArray: true })
  vendorOrders!: VendorOrderResponseEntity[];

  @ApiProperty()
  createdAt!: Date;
}
