import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export const UPGRADE_REVIEW_DECISIONS = ['APPROVED', 'REJECTED'] as const;

export class ReviewUpgradeRequestDto {
  @ApiProperty({ enum: UPGRADE_REVIEW_DECISIONS })
  @IsIn(UPGRADE_REVIEW_DECISIONS)
  decision!: (typeof UPGRADE_REVIEW_DECISIONS)[number];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(5)
  reviewNotes?: string;
}
