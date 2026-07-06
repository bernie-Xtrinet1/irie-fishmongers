import { ApiProperty } from '@nestjs/swagger';
import { SeafoodStorageType, WeightUnit } from '@prisma/client';
import { IsDateString, IsEnum, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreateSeafoodLotDto {
  @ApiProperty({ example: 'Yellowfin Snapper' })
  @IsString()
  @MinLength(2)
  species!: string;

  @ApiProperty({ enum: SeafoodStorageType })
  @IsEnum(SeafoodStorageType)
  storageType!: SeafoodStorageType;

  @ApiProperty({ example: '2027-01-15' })
  @IsDateString()
  catchDate!: string;

  @ApiProperty({ required: false, example: 'North Coast, Trelawny' })
  @IsOptional()
  @IsString()
  catchLocation?: string;

  @ApiProperty({ required: false, example: 'Falmouth Landing Site' })
  @IsOptional()
  @IsString()
  landingSite?: string;

  @ApiProperty({ example: 50 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  weight!: number;

  @ApiProperty({ enum: WeightUnit })
  @IsEnum(WeightUnit)
  weightUnit!: WeightUnit;
}
