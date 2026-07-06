import { ApiProperty } from '@nestjs/swagger';
import { VendorSettlementStatus } from '@prisma/client';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export const ASSIGNABLE_VENDOR_SETTLEMENT_STATUSES = [
  VendorSettlementStatus.APPROVED,
  VendorSettlementStatus.PAID,
  VendorSettlementStatus.FAILED,
] as const;

export class UpdateVendorSettlementStatusDto {
  @ApiProperty({ enum: ASSIGNABLE_VENDOR_SETTLEMENT_STATUSES })
  @IsIn(ASSIGNABLE_VENDOR_SETTLEMENT_STATUSES)
  status!: (typeof ASSIGNABLE_VENDOR_SETTLEMENT_STATUSES)[number];

  @ApiProperty({ required: false, example: 'Bank transfer reference #4471' })
  @IsOptional()
  @IsString()
  @MinLength(5)
  notes?: string;
}
