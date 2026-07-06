import { ApiProperty } from '@nestjs/swagger';
import { IncidentSeverity, IncidentStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListIncidentsDto extends PaginationDto {
  @ApiProperty({ enum: IncidentSeverity, required: false })
  @IsOptional()
  @IsEnum(IncidentSeverity)
  severity?: IncidentSeverity;

  @ApiProperty({ enum: IncidentStatus, required: false })
  @IsOptional()
  @IsEnum(IncidentStatus)
  status?: IncidentStatus;
}
