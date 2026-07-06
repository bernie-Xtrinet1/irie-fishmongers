import { ApiProperty } from '@nestjs/swagger';
import { FoodSafetyStatus, FreshnessGrade, SeafoodStorageType, WeightUnit } from '@prisma/client';

export class SeafoodLotResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  lotNumber!: string;

  @ApiProperty()
  vendorId!: string;

  @ApiProperty()
  species!: string;

  @ApiProperty({ enum: SeafoodStorageType })
  storageType!: SeafoodStorageType;

  @ApiProperty()
  catchDate!: Date;

  @ApiProperty({ required: false, nullable: true })
  catchLocation!: string | null;

  @ApiProperty({ required: false, nullable: true })
  landingSite!: string | null;

  @ApiProperty()
  weight!: string;

  @ApiProperty({ enum: WeightUnit })
  weightUnit!: WeightUnit;

  @ApiProperty({ enum: FreshnessGrade, required: false, nullable: true })
  freshnessGrade!: FreshnessGrade | null;

  @ApiProperty({ required: false, nullable: true })
  qualityScore!: number | null;

  @ApiProperty({ enum: FoodSafetyStatus })
  foodSafetyStatus!: FoodSafetyStatus;

  @ApiProperty({ required: false, nullable: true })
  statusNotes!: string | null;

  @ApiProperty()
  createdAt!: Date;
}
