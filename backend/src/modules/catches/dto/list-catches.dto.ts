import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListCatchesDto extends PaginationDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  fishermanId?: string;
}
