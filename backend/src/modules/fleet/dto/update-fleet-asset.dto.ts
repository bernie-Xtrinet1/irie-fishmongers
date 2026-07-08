import { ApiProperty } from '@nestjs/swagger';
import { FleetAssetStatus } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';

export class UpdateFleetAssetDto {
  @ApiProperty({ enum: FleetAssetStatus, required: false })
  @IsOptional()
  @IsEnum(FleetAssetStatus)
  status?: FleetAssetStatus;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Driver currently operating this asset, or null to unassign',
  })
  @IsOptional()
  @IsString()
  currentDriverId?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  coldChainCapable?: boolean;
}
