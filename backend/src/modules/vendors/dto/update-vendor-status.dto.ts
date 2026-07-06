import { ApiProperty } from '@nestjs/swagger';
import { VendorStatus } from '@prisma/client';
import { IsIn } from 'class-validator';

export const ASSIGNABLE_VENDOR_STATUSES = [
  VendorStatus.APPROVED,
  VendorStatus.SUSPENDED,
  VendorStatus.REJECTED,
] as const;

export class UpdateVendorStatusDto {
  @ApiProperty({ enum: ASSIGNABLE_VENDOR_STATUSES })
  @IsIn(ASSIGNABLE_VENDOR_STATUSES)
  status!: (typeof ASSIGNABLE_VENDOR_STATUSES)[number];
}
