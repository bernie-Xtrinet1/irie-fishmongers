import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ListingLifecycleStatus, ProductUnit } from '@prisma/client';

import { DailyListingSpeciesResponseEntity } from './daily-listing-species-response.entity';
import { ListingPhotoResponseEntity } from './listing-photo-response.entity';

export class DailyListingResponseEntity {
  @ApiProperty({ example: 'a1234567-89ab-cdef-0123-456789abcdef' })
  id: string;

  @ApiProperty({ example: 'v1234567-89ab-cdef-0123-456789abcdef' })
  vendorId: string;

  @ApiProperty({ example: 'p1234567-89ab-cdef-0123-456789abcdef' })
  productId: string;

  @ApiProperty({ example: 'c1234567-89ab-cdef-0123-456789abcdef' })
  catalogueItemId: string;

  @ApiProperty({ example: 'l1234567-89ab-cdef-0123-456789abcdef' })
  lotId: string;

  @ApiPropertyOptional({ example: 'ls123456-89ab-cdef-0123-456789abcdef' })
  landingSiteId?: string | null;

  @ApiPropertyOptional({ example: 'Fresh Morning Snapper Catch' })
  listingTitle?: string | null;

  @ApiPropertyOptional({ example: 'Landed at sunrise, cold-chain iced on boat' })
  description?: string | null;

  @ApiProperty({ example: '2026-10-19T05:00:00.000Z' })
  catchDate: Date;

  @ApiProperty({ example: '2026-10-19T06:00:00.000Z' })
  availableFrom: Date;

  @ApiProperty({ example: '2026-10-19T20:00:00.000Z' })
  expiresAt: Date;

  @ApiProperty({ enum: ProductUnit, example: ProductUnit.PER_POUND })
  unit: ProductUnit;

  @ApiProperty({ example: 850.0 })
  price: number;

  @ApiProperty({ example: 'JMD' })
  currency: string;

  @ApiProperty({ example: 50.0 })
  quantityUploaded: number;

  @ApiProperty({ example: 45.0 })
  quantityAvailable: number;

  @ApiProperty({ example: 5.0 })
  quantityReserved: number;

  @ApiProperty({ example: 0.0 })
  quantitySold: number;

  @ApiPropertyOptional({ example: [{ id: 'scaled', label: 'Scaled & Gutted', fee: 150 }] })
  preparationOptions?: any;

  @ApiProperty({ example: true })
  deliveryAvailable: boolean;

  @ApiProperty({ example: true })
  pickupAvailable: boolean;

  @ApiProperty({ enum: ListingLifecycleStatus, example: ListingLifecycleStatus.PUBLISHED })
  status: ListingLifecycleStatus;

  @ApiProperty({
    description: 'Derived read-time lifecycle status (DRAFT | PUBLISHED | EXPIRED | SOLD_OUT | WITHDRAWN | SUSPENDED)',
    example: 'PUBLISHED',
  })
  derivedStatus: string;

  @ApiPropertyOptional({ example: '2026-10-19T06:30:00.000Z' })
  publishedAt?: Date | null;

  @ApiPropertyOptional({ example: null })
  withdrawnAt?: Date | null;

  @ApiPropertyOptional({ example: null })
  withdrawnReason?: string | null;

  @ApiPropertyOptional({ example: null })
  suspendedAt?: Date | null;

  @ApiPropertyOptional({ example: null })
  suspensionReason?: string | null;

  @ApiProperty({ example: '2026-10-19T06:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-10-19T06:30:00.000Z' })
  updatedAt: Date;

  @ApiPropertyOptional({ type: ListingPhotoResponseEntity })
  primaryPhoto?: ListingPhotoResponseEntity | null;

  @ApiPropertyOptional({ type: [ListingPhotoResponseEntity] })
  photos?: ListingPhotoResponseEntity[];

  @ApiPropertyOptional({ type: [DailyListingSpeciesResponseEntity] })
  speciesDeclarations?: DailyListingSpeciesResponseEntity[];

  @ApiPropertyOptional()
  vendor?: {
    id: string;
    businessName: string;
    tier: string;
    parish?: string;
  };

  @ApiPropertyOptional()
  catalogueItem?: {
    id: string;
    name: string;
    commonName: string;
    categoryId: string;
    compositionMode: string;
    referenceImageUrl?: string | null;
  };

  @ApiPropertyOptional()
  lot?: {
    id: string;
    lotNumber: string;
    publicTraceToken: string;
    freshnessGrade?: string | null;
    foodSafetyStatus: string;
    originType?: string | null;
    acquisitionType?: string | null;
  };

  @ApiPropertyOptional()
  landingSite?: {
    id: string;
    name: string;
    parish: string;
  } | null;
}
