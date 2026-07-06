import { ApiProperty } from '@nestjs/swagger';
import { IsLatitude, IsLongitude } from 'class-validator';

export class RecordLocationDto {
  @ApiProperty({ example: 17.9714 })
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: -76.7931 })
  @IsLongitude()
  longitude!: number;
}
