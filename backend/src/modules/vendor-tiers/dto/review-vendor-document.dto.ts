import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export const DOCUMENT_REVIEW_DECISIONS = ['APPROVED', 'REJECTED'] as const;

export class ReviewVendorDocumentDto {
  @ApiProperty({ enum: DOCUMENT_REVIEW_DECISIONS })
  @IsIn(DOCUMENT_REVIEW_DECISIONS)
  decision!: (typeof DOCUMENT_REVIEW_DECISIONS)[number];

  @ApiProperty({ required: false, example: 'Document image is illegible - please resubmit' })
  @IsOptional()
  @IsString()
  @MinLength(5)
  rejectionReason?: string;
}
