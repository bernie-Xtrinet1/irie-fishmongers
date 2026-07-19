import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export const MANUAL_AVAILABILITY_STATUSES = ['ONLINE', 'OFFLINE'] as const;

export class UpdateDriverAvailabilityDto {
  @ApiProperty({
    enum: MANUAL_AVAILABILITY_STATUSES,
    description: 'BUSY is set automatically when a delivery is claimed and cannot be set manually',
  })
  @IsIn(MANUAL_AVAILABILITY_STATUSES)
  status!: (typeof MANUAL_AVAILABILITY_STATUSES)[number];
}
