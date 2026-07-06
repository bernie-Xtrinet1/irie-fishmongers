import { ApiProperty } from '@nestjs/swagger';
import { IncidentStatus } from '@prisma/client';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export const ASSIGNABLE_INCIDENT_STATUSES = [
  IncidentStatus.INVESTIGATING,
  IncidentStatus.RESOLVED,
  IncidentStatus.CLOSED,
] as const;

export class UpdateIncidentStatusDto {
  @ApiProperty({ enum: ASSIGNABLE_INCIDENT_STATUSES })
  @IsIn(ASSIGNABLE_INCIDENT_STATUSES)
  status!: (typeof ASSIGNABLE_INCIDENT_STATUSES)[number];

  @ApiProperty({ required: false, example: 'Vendor retrained on packaging procedure; repeat audit scheduled' })
  @IsOptional()
  @IsString()
  @MinLength(5)
  correctiveAction?: string;
}
