import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListAuditLogsDto extends PaginationDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  entityId?: string;
}
