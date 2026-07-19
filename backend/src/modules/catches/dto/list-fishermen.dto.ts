import { ApiProperty } from '@nestjs/swagger';
import { FishermanStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListFishermenDto extends PaginationDto {
  @ApiProperty({ enum: FishermanStatus, required: false })
  @IsOptional()
  @IsEnum(FishermanStatus)
  status?: FishermanStatus;
}
