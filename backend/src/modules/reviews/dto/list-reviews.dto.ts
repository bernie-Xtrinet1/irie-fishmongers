import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

// Public review lists default to newest-first with a 20/page default and a
// 50/page ceiling (Phase 13A). A dedicated DTO rather than the shared
// PaginationDto so the max page size is 50, not 100.
export class ListReviewsDto {
  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiProperty({ required: false, default: 20, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize: number = 20;
}
