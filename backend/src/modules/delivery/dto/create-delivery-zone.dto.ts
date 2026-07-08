import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class CreateDeliveryZoneDto {
  @ApiProperty({ example: 'Zone 1' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: 'ZONE_1' })
  @IsString()
  @MinLength(2)
  code!: string;

  @ApiProperty({ required: false, example: 'Kingston, St. Andrew, St. Catherine' })
  @IsOptional()
  @IsString()
  description?: string;
}
