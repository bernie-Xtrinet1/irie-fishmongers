import { ApiProperty } from '@nestjs/swagger';
import { TierRequestStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListUpgradeRequestsDto extends PaginationDto {
  @ApiProperty({ enum: TierRequestStatus, required: false })
  @IsOptional()
  @IsEnum(TierRequestStatus)
  status?: TierRequestStatus;
}
