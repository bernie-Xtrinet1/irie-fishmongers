import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProductUnit } from '@prisma/client';

import { DailyListingResponseEntity } from './daily-listing-response.entity';

export class AvailableTodayItemEntity {
  @ApiProperty({ example: 'c1234567-89ab-cdef-0123-456789abcdef' })
  catalogueItemId: string;

  @ApiProperty({ example: 'Yellowtail Snapper' })
  name: string;

  @ApiProperty({ example: 'Yellowtail' })
  commonName: string;

  @ApiProperty({ example: 'Ocyurus chrysurus' })
  scientificName: string;

  @ApiProperty({ example: 'cat-1234567' })
  categoryId: string;

  @ApiProperty({ example: 'Snapper Family' })
  categoryName: string;

  @ApiPropertyOptional({ example: 'https://example.com/snapper-ref.jpg' })
  referenceImageUrl: string | null;

  @ApiProperty({ example: 85.0 })
  totalQuantityAvailable: number;

  @ApiProperty({ enum: ProductUnit, example: ProductUnit.PER_POUND })
  unit: ProductUnit;

  @ApiProperty({ example: 3 })
  sellerCount: number;

  @ApiProperty({ example: 850.0 })
  minPrice: number;

  @ApiProperty({ example: 1000.0 })
  maxPrice: number;

  @ApiProperty({ example: 'JMD' })
  currency: string;

  @ApiProperty({ example: '2026-10-19T05:00:00.000Z' })
  earliestCatchDate: Date;

  @ApiProperty({ example: 3 })
  activeListingsCount: number;

  @ApiProperty({ example: true })
  hasPreparationOptions: boolean;

  @ApiProperty({ example: true })
  deliveryAvailable: boolean;

  @ApiProperty({ example: true })
  pickupAvailable: boolean;

  @ApiProperty({ type: [String], example: ['KINGSTON', 'PORTLAND'] })
  parishes: string[];

  @ApiProperty({ type: [DailyListingResponseEntity] })
  listingsPreview: DailyListingResponseEntity[];
}

export class PaginatedAvailableTodayEntity {
  @ApiProperty({ type: [AvailableTodayItemEntity] })
  items: AvailableTodayItemEntity[];

  @ApiProperty({ example: 15 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 12 })
  limit: number;

  @ApiProperty({ example: 2 })
  totalPages: number;
}
