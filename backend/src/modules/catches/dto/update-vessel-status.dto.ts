import { ApiProperty } from '@nestjs/swagger';
import { VesselRegistrationStatus } from '@prisma/client';
import { IsIn } from 'class-validator';

export const ASSIGNABLE_VESSEL_STATUSES = [
  VesselRegistrationStatus.ACTIVE,
  VesselRegistrationStatus.INACTIVE,
  VesselRegistrationStatus.DECOMMISSIONED,
] as const;

export class UpdateVesselStatusDto {
  @ApiProperty({ enum: ASSIGNABLE_VESSEL_STATUSES })
  @IsIn(ASSIGNABLE_VESSEL_STATUSES)
  status!: (typeof ASSIGNABLE_VESSEL_STATUSES)[number];
}
