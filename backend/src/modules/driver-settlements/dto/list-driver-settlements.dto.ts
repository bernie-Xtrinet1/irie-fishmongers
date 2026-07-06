import { ApiProperty } from '@nestjs/swagger';
import { SettlementStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListDriverSettlementsDto extends PaginationDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  driverId?: string;

  @ApiProperty({ enum: SettlementStatus, required: false })
  @IsOptional()
  @IsEnum(SettlementStatus)
  status?: SettlementStatus;
}
