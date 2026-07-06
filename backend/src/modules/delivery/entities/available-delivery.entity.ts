import { ApiProperty } from '@nestjs/swagger';
import { Parish } from '@prisma/client';

import { DeliveryItemSummaryEntity } from './delivery-item-summary.entity';

export class AvailableDeliveryEntity {
  @ApiProperty()
  vendorOrderId!: string;

  @ApiProperty()
  pickupVendorName!: string;

  @ApiProperty({ enum: Parish })
  pickupParish!: Parish;

  @ApiProperty({ type: DeliveryItemSummaryEntity, isArray: true })
  items!: DeliveryItemSummaryEntity[];

  @ApiProperty()
  readyForPickupAt!: Date;
}
