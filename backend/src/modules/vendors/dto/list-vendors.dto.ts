import { ApiProperty } from '@nestjs/swagger';
import { VendorStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListVendorsDto extends PaginationDto {
  @ApiProperty({ enum: VendorStatus, required: false })
  @IsOptional()
  @IsEnum(VendorStatus)
  status?: VendorStatus;
}
