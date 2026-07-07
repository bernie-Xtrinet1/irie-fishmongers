import { ApiProperty } from '@nestjs/swagger';
import { VendorTier } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

export class RequestTierUpgradeDto {
  @ApiProperty({ enum: VendorTier })
  @IsEnum(VendorTier)
  requestedTier!: VendorTier;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(5)
  reason?: string;
}
