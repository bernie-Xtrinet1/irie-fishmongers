import { ApiProperty } from '@nestjs/swagger';
import { DriverStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListDriversDto extends PaginationDto {
  @ApiProperty({ enum: DriverStatus, required: false })
  @IsOptional()
  @IsEnum(DriverStatus)
  status?: DriverStatus;
}
