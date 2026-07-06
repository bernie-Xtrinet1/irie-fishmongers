import { ApiProperty } from '@nestjs/swagger';
import { VendorSettlementStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ListVendorSettlementsDto extends PaginationDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiProperty({ enum: VendorSettlementStatus, required: false })
  @IsOptional()
  @IsEnum(VendorSettlementStatus)
  status?: VendorSettlementStatus;
}
