import { ApiProperty } from '@nestjs/swagger';
import { AlertSeverity } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListTemperatureAlertsDto extends PaginationDto {
  @ApiProperty({ enum: AlertSeverity, required: false })
  @IsOptional()
  @IsEnum(AlertSeverity)
  severity?: AlertSeverity;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  resolved?: boolean;
}
