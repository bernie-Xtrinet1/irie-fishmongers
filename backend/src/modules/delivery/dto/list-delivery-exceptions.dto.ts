import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListDeliveryExceptionsDto extends PaginationDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  resolved?: boolean;
}
