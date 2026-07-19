import { ApiProperty } from '@nestjs/swagger';
import { SLABreachType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListSLABreachesDto extends PaginationDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  resolved?: boolean;

  @ApiProperty({ enum: SLABreachType, required: false })
  @IsOptional()
  @IsEnum(SLABreachType)
  type?: SLABreachType;
}
