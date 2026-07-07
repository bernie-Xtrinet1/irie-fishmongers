import { ApiProperty } from '@nestjs/swagger';
import { VendorTier } from '@prisma/client';

export class VendorPermissionsEntity {
  @ApiProperty({ enum: VendorTier })
  tier!: VendorTier;

  @ApiProperty()
  badge!: string;

  @ApiProperty({ required: false, nullable: true, description: 'Decimal string, null means unlimited' })
  dailySalesLimit!: string | null;

  @ApiProperty({ required: false, nullable: true, description: 'Decimal string, null means unlimited' })
  monthlySalesLimit!: string | null;

  @ApiProperty({ required: false, nullable: true, description: 'null means unlimited' })
  maxActiveListings!: number | null;

  @ApiProperty()
  canSellRetail!: boolean;

  @ApiProperty()
  canSellWholesale!: boolean;

  @ApiProperty()
  canAcceptHotelOrders!: boolean;

  @ApiProperty()
  canAcceptRestaurantOrders!: boolean;

  @ApiProperty()
  canAcceptGovernmentOrders!: boolean;

  @ApiProperty()
  canExportProducts!: boolean;

  @ApiProperty()
  canAccessAnalytics!: boolean;

  @ApiProperty()
  canAccessPromotions!: boolean;

  @ApiProperty()
  canUseApiAccess!: boolean;

  @ApiProperty()
  canOperateMultipleZones!: boolean;
}
