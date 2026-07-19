import { ApiProperty } from '@nestjs/swagger';
import { FleetAssetStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListFleetAssetsDto extends PaginationDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  zoneId?: string;

  @ApiProperty({ enum: FleetAssetStatus, required: false })
  @IsOptional()
  @IsEnum(FleetAssetStatus)
  status?: FleetAssetStatus;
}
