import { ApiPropertyOptional } from '@nestjs/swagger';
import { ListingLifecycleStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryDailyListingsDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by vendor UUID' })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional({ description: 'Filter by master catalogue item UUID' })
  @IsOptional()
  @IsUUID()
  catalogueItemId?: string;

  @ApiPropertyOptional({ enum: ListingLifecycleStatus, description: 'Filter by stored lifecycle status' })
  @IsOptional()
  @IsEnum(ListingLifecycleStatus)
  status?: ListingLifecycleStatus;

  @ApiPropertyOptional({
    description: 'Filter only active, published, non-expired listings (Available Today)',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  activeOnly?: boolean;

  @ApiPropertyOptional({ description: 'Search title or description text' })
  @IsOptional()
  @IsString()
  search?: string;
}
