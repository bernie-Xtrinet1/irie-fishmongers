import { ApiProperty } from '@nestjs/swagger';
import { InventoryEventType } from '@prisma/client';

import { ProductAvailability } from '../../products/entities/product-response.entity';

class ProductAvailabilityCountsEntity implements Record<ProductAvailability, number> {
  @ApiProperty()
  ACTIVE!: number;

  @ApiProperty()
  OUT_OF_STOCK!: number;

  @ApiProperty()
  INACTIVE!: number;

  @ApiProperty()
  ON_HOLD!: number;
}

export class LowStockProductEntity {
  @ApiProperty()
  productId!: string;

  @ApiProperty()
  productName!: string;

  @ApiProperty()
  quantityAvailable!: number;

  @ApiProperty()
  vendorId!: string;
}

export class InventoryEventTypeSummaryEntity {
  @ApiProperty()
  count!: number;

  @ApiProperty({ description: 'sum(InventoryEvent.quantityDelta) for this event type' })
  totalQuantityDelta!: number;
}

class InventoryEventCountsEntity implements Record<InventoryEventType, InventoryEventTypeSummaryEntity> {
  @ApiProperty({ type: InventoryEventTypeSummaryEntity })
  DECREMENTED!: InventoryEventTypeSummaryEntity;

  @ApiProperty({ type: InventoryEventTypeSummaryEntity })
  RESTOCKED!: InventoryEventTypeSummaryEntity;

  @ApiProperty({ type: InventoryEventTypeSummaryEntity })
  MANUAL_ADJUSTMENT!: InventoryEventTypeSummaryEntity;

  @ApiProperty({ type: InventoryEventTypeSummaryEntity })
  DISPOSED!: InventoryEventTypeSummaryEntity;
}

export class InventoryAnalyticsEntity {
  @ApiProperty({ type: ProductAvailabilityCountsEntity, description: 'Point-in-time snapshot - ignores the from/to range' })
  byAvailability!: ProductAvailabilityCountsEntity;

  @ApiProperty({
    type: LowStockProductEntity,
    isArray: true,
    description: 'Active products with 1-10 units remaining, lowest first - point-in-time snapshot',
  })
  lowStockProducts!: LowStockProductEntity[];

  @ApiProperty({ type: InventoryEventCountsEntity })
  eventsByType!: InventoryEventCountsEntity;
}
