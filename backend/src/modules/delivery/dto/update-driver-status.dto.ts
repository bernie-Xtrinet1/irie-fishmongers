import { ApiProperty } from '@nestjs/swagger';
import { DriverStatus } from '@prisma/client';
import { IsIn } from 'class-validator';

export const ASSIGNABLE_DRIVER_STATUSES = [
  DriverStatus.APPROVED,
  DriverStatus.SUSPENDED,
  DriverStatus.REJECTED,
] as const;

export class UpdateDriverStatusDto {
  @ApiProperty({ enum: ASSIGNABLE_DRIVER_STATUSES })
  @IsIn(ASSIGNABLE_DRIVER_STATUSES)
  status!: (typeof ASSIGNABLE_DRIVER_STATUSES)[number];
}
