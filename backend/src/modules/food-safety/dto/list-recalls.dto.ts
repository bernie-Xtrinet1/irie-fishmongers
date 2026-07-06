import { ApiProperty } from '@nestjs/swagger';
import { RecallStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListRecallsDto extends PaginationDto {
  @ApiProperty({ enum: RecallStatus, required: false })
  @IsOptional()
  @IsEnum(RecallStatus)
  status?: RecallStatus;
}
