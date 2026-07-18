import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ReviewModerationStatus } from '@prisma/client';

// Admin moderation queue filters (Phase 13B). Unlike the public list, this
// sees every moderation state and adds moderator-context filters:
// deliveryWasRejected (computed from the joined Delivery) and a created-at
// date range.
export class ListAdminReviewsDto {
  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiProperty({ required: false, default: 20, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize: number = 20;

  @ApiProperty({ required: false, enum: ReviewModerationStatus })
  @IsOptional()
  @IsEnum(ReviewModerationStatus)
  moderationStatus?: ReviewModerationStatus;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(({ value }): unknown => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  })
  @IsBoolean()
  deliveryWasRejected?: boolean;

  @ApiProperty({ required: false, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  createdAfter?: Date;

  @ApiProperty({ required: false, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  createdBefore?: Date;
}
