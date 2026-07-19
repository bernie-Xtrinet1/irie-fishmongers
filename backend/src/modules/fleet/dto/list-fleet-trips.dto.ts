import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListFleetTripsDto extends PaginationDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  fleetAssetId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  driverId?: string;
}
