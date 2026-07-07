import { ApiProperty } from '@nestjs/swagger';
import { DowngradeReason, VendorTier } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

export class DowngradeVendorDto {
  @ApiProperty({ enum: VendorTier })
  @IsEnum(VendorTier)
  toTier!: VendorTier;

  @ApiProperty({ enum: DowngradeReason })
  @IsEnum(DowngradeReason)
  reason!: DowngradeReason;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(5)
  notes?: string;
}
