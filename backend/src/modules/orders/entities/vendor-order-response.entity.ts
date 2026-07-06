import { ApiProperty } from '@nestjs/swagger';
import { VendorOrderStatus } from '@prisma/client';

import { OrderItemResponseEntity } from './order-item-response.entity';

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
}
