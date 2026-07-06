import { ApiProperty } from '@nestjs/swagger';
import { Parish, ProofOfDeliveryType } from '@prisma/client';

import { DeliveryItemSummaryEntity } from './delivery-item-summary.entity';

export const DELIVERY_STAGES = ['ASSIGNED', 'PICKED_UP', 'DELIVERED', 'FAILED'] as const;
export type DeliveryStage = (typeof DELIVERY_STAGES)[number];

export class DriverDeliveryResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  vendorOrderId!: string;

  @ApiProperty()
  driverId!: string;

  @ApiProperty({ enum: DELIVERY_STAGES })
  stage!: DeliveryStage;

  @ApiProperty()
  pickupVendorName!: string;

  @ApiProperty({ enum: Parish })
  pickupParish!: Parish;

  @ApiProperty({ type: DeliveryItemSummaryEntity, isArray: true })
  items!: DeliveryItemSummaryEntity[];

  @ApiProperty()
  deliveryAddressLine1!: string;

  @ApiProperty({ required: false, nullable: true })
  deliveryAddressLine2!: string | null;

  @ApiProperty({ enum: Parish })
  deliveryParish!: Parish;

  @ApiProperty()
  deliveryPhone!: string;

  @ApiProperty()
  assignedAt!: Date;

  @ApiProperty({ required: false, nullable: true })
  pickedUpAt!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  deliveredAt!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  failedAt!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  failureReason!: string | null;

  @ApiProperty({ enum: ProofOfDeliveryType, required: false, nullable: true })
  proofType!: ProofOfDeliveryType | null;

  @ApiProperty({ required: false, nullable: true })
  proofUrl!: string | null;
}
