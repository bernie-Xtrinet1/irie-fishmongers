import { ApiProperty } from '@nestjs/swagger';
import { DeliveryRunStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListDeliveryRunsDto extends PaginationDto {
  @ApiProperty({ enum: DeliveryRunStatus, required: false })
  @IsOptional()
  @IsEnum(DeliveryRunStatus)
  status?: DeliveryRunStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  zoneId?: string;
}
