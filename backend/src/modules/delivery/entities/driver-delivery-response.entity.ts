import { ApiProperty } from '@nestjs/swagger';
import { CustomerAcceptanceStatus, Parish, ProofOfDeliveryType } from '@prisma/client';

import { DeliveryExceptionResponseEntity } from './delivery-exception-response.entity';
import { DeliveryItemSummaryEntity } from './delivery-item-summary.entity';
import { RouteHistoryResponseEntity } from './route-history-response.entity';

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

  @ApiProperty({ required: false, nullable: true })
  scheduledPickupWindowStart!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  scheduledPickupWindowEnd!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  customerDeliveryWindowStart!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  customerDeliveryWindowEnd!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  vendorConfirmedAt!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  vendorConfirmedById!: string | null;

  @ApiProperty({ enum: CustomerAcceptanceStatus })
  customerAcceptanceStatus!: CustomerAcceptanceStatus;

  @ApiProperty({ required: false, nullable: true })
  customerAcceptedAt!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  customerRejectedAt!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  rejectionReason!: string | null;

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

  @ApiProperty({ type: DeliveryExceptionResponseEntity, isArray: true })
  exceptions!: DeliveryExceptionResponseEntity[];

  @ApiProperty({ type: RouteHistoryResponseEntity, required: false, nullable: true })
  routeHistory!: RouteHistoryResponseEntity | null;
}
