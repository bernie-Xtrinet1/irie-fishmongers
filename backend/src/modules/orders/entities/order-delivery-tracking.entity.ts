import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Parish, VendorOrderStatus } from '@prisma/client';

export type CustomerDeliveryTrackingStage =
  | 'AWAITING_PICKUP'
  | 'IN_TRANSIT'
  | 'HANDED_OVER'
  | 'DELIVERED'
  | 'RETURNED'
  | 'CANCELLED'
  | 'FAILED';

export type CustomerTrackedLocationStatus =
  | 'NOT_STARTED'
  | 'LIVE'
  | 'STALE'
  | 'UNAVAILABLE'
  | 'ENDED';

export class CustomerTrackedLocationEntity {
  @ApiProperty({ example: 17.9714 })
  latitude!: number;

  @ApiProperty({ example: -76.7931 })
  longitude!: number;

  @ApiProperty({ format: 'date-time' })
  capturedAt!: string;

  @ApiProperty()
  stale!: boolean;

  @ApiProperty({ example: 'Live vehicle location' })
  label!: string;
}

export class CustomerTrackedDeliveryItemEntity {
  @ApiProperty()
  productName!: string;

  @ApiProperty()
  quantity!: number;
}

export class CustomerTrackedDeliveryPartEntity {
  @ApiProperty()
  vendorOrderId!: string;

  @ApiProperty({ example: 1 })
  deliveryIndex!: number;

  @ApiProperty({ example: 2 })
  totalDeliveries!: number;

  @ApiProperty({ example: 'Part 1 of 2 · Harbour Fresh Seafood' })
  deliveryLabel!: string;

  @ApiProperty()
  vendorName!: string;

  @ApiProperty()
  itemsSummary!: string;

  @ApiProperty({ type: CustomerTrackedDeliveryItemEntity, isArray: true })
  items!: CustomerTrackedDeliveryItemEntity[];

  @ApiProperty({ enum: VendorOrderStatus })
  vendorStatus!: VendorOrderStatus;

  @ApiProperty({
    enum: ['AWAITING_PICKUP', 'IN_TRANSIT', 'HANDED_OVER', 'DELIVERED', 'RETURNED', 'CANCELLED', 'FAILED'],
  })
  stage!: CustomerDeliveryTrackingStage;

  @ApiProperty({ example: 'Picked up / In transit' })
  statusLabel!: string;

  @ApiProperty()
  onBoard!: boolean;

  @ApiProperty()
  isLocationShared!: boolean;

  @ApiProperty({ enum: ['NOT_STARTED', 'LIVE', 'STALE', 'UNAVAILABLE', 'ENDED'] })
  locationStatus!: CustomerTrackedLocationStatus;

  @ApiProperty()
  locationMessage!: string;

  @ApiPropertyOptional({ type: () => CustomerTrackedLocationEntity, nullable: true })
  location!: CustomerTrackedLocationEntity | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  pickedUpAt!: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  customerDeliveryWindowStart!: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  customerDeliveryWindowEnd!: string | null;
}

export class OrderDeliveryTrackingEntity {
  @ApiProperty()
  orderId!: string;

  @ApiProperty({ enum: Parish })
  deliveryParish!: Parish;

  @ApiProperty()
  isSplitOrder!: boolean;

  @ApiProperty()
  hasActiveTracking!: boolean;

  @ApiProperty({ type: CustomerTrackedDeliveryPartEntity, isArray: true })
  deliveries!: CustomerTrackedDeliveryPartEntity[];

  @ApiProperty({ format: 'date-time' })
  checkedAt!: string;
}
