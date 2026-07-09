import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional } from 'class-validator';

export class UpdateTemperatureThresholdDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  minC?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  maxC?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  warningBandC?: number;
}
