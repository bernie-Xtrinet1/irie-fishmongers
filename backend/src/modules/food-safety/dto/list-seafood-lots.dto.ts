import { ApiProperty } from '@nestjs/swagger';
import { FoodSafetyStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListSeafoodLotsDto extends PaginationDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiProperty({ enum: FoodSafetyStatus, required: false })
  @IsOptional()
  @IsEnum(FoodSafetyStatus)
  status?: FoodSafetyStatus;
}
