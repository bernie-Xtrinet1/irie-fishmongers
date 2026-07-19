import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RegisterTemperatureDeviceDto {
  @ApiProperty({ example: 'FRIDGE-01' })
  @IsString()
  @MinLength(2)
  deviceCode!: string;
}
