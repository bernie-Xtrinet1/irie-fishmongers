import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ListingPhotoModerationStatus } from '@prisma/client';

export class ListingPhotoResponseEntity {
  @ApiProperty({ example: 'f87b28d9-21a4-4f05-873b-554433221100' })
  id: string;

  @ApiProperty({ example: 'a1234567-89ab-cdef-0123-456789abcdef' })
  vendorDailyListingId: string;

  @ApiProperty({ example: 'https://storage.iriefishmonger.com/listings/photo-1.jpg' })
  url: string;

  @ApiPropertyOptional({ example: 'Morning catch at Old Harbour Bay' })
  caption?: string | null;

  @ApiProperty({ example: true })
  isPrimary: boolean;

  @ApiProperty({ enum: ListingPhotoModerationStatus, example: ListingPhotoModerationStatus.APPROVED })
  moderationStatus: ListingPhotoModerationStatus;

  @ApiProperty({ example: '2026-10-19T06:00:00.000Z' })
  uploadedAt: Date;

  @ApiPropertyOptional({ example: '2026-10-19T05:30:00.000Z' })
  captureDate?: Date | null;

  @ApiPropertyOptional({ example: null })
  withdrawnAt?: Date | null;

  @ApiPropertyOptional({ example: null })
  withdrawnReason?: string | null;

  @ApiProperty({ example: '2026-10-19T06:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-10-19T06:00:00.000Z' })
  updatedAt: Date;
}
