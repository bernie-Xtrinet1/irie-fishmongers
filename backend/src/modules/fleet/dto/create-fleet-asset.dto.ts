import { ApiProperty } from '@nestjs/swagger';
import { FleetAssetType, FleetOwnership } from '@prisma/client';
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreateFleetAssetDto {
  @ApiProperty({ description: 'The DeliveryZone this asset is based in' })
  @IsString()
  zoneId!: string;

  @ApiProperty({ enum: FleetAssetType })
  @IsEnum(FleetAssetType)
  assetType!: FleetAssetType;

  @ApiProperty({ enum: FleetOwnership })
  @IsEnum(FleetOwnership)
  ownership!: FleetOwnership;

  @ApiProperty({ example: 'ZN 1234' })
  @IsString()
  @MinLength(3)
  licensePlate!: string;

  @ApiProperty({ example: 2000, description: 'Maximum load capacity in pounds' })
  @IsNumber()
  @Min(0)
  capacityLbs!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  coldChainCapable?: boolean;
}
