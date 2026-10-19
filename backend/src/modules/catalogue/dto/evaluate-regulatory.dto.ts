import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsUUID } from 'class-validator';

export class EvaluateRegulatoryEligibilityDto {
  @ApiProperty({ description: 'ID of the SeafoodCatalogueItem to evaluate' })
  @IsUUID()
  catalogueItemId!: string;

  @ApiProperty({ required: false, description: 'ID of the VendorDailyListing (resolves listing-level species)' })
  @IsOptional()
  @IsUUID()
  vendorDailyListingId?: string;

  @ApiProperty({ required: false, description: 'ID of the SeafoodLot (provenance and lot inspections)' })
  @IsOptional()
  @IsUUID()
  seafoodLotId?: string;

  @ApiProperty({ required: false, description: 'Evaluation point in time (defaults to now)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  atDate?: Date;
}
