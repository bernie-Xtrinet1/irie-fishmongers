import { ApiProperty } from '@nestjs/swagger';
import { RegulatoryOverrideReason } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsNotEmpty, IsOptional, IsString, IsUrl, IsUUID } from 'class-validator';

export class CreateRegulatoryOverrideDto {
  @ApiProperty({ description: 'ID of the SeafoodCatalogueItem' })
  @IsUUID()
  catalogueItemId!: string;

  @ApiProperty({ enum: RegulatoryOverrideReason, default: RegulatoryOverrideReason.DATA_CORRECTION })
  @IsEnum(RegulatoryOverrideReason)
  reason!: RegulatoryOverrideReason;

  @ApiProperty({ description: 'Justification for data-correction override' })
  @IsString()
  @IsNotEmpty()
  justification!: string;

  @ApiProperty({ required: false, description: 'Document evidence link' })
  @IsOptional()
  @IsUrl()
  documentEvidenceUrl?: string;

  @ApiProperty({ description: 'Mandatory bounded expiry timestamp for override' })
  @Type(() => Date)
  @IsDate()
  expiresAt!: Date;
}
