import { ApiProperty } from '@nestjs/swagger';
import { VendorOrderStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListVendorOrdersDto extends PaginationDto {
  @ApiProperty({ enum: VendorOrderStatus, required: false })
  @IsOptional()
  @IsEnum(VendorOrderStatus)
  status?: VendorOrderStatus;
}
