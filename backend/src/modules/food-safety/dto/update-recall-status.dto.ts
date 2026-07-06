import { ApiProperty } from '@nestjs/swagger';
import { RecallStatus } from '@prisma/client';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

// DRAFT is the only creation-time status; every other status is reached
// only via this endpoint, in the strict linear order recall-management.md
// defines (Draft -> Active -> Investigating -> Resolved -> Closed).
export const ASSIGNABLE_RECALL_STATUSES = [
  RecallStatus.ACTIVE,
  RecallStatus.INVESTIGATING,
  RecallStatus.RESOLVED,
  RecallStatus.CLOSED,
] as const;

export class UpdateRecallStatusDto {
  @ApiProperty({ enum: ASSIGNABLE_RECALL_STATUSES })
  @IsIn(ASSIGNABLE_RECALL_STATUSES)
  status!: (typeof ASSIGNABLE_RECALL_STATUSES)[number];

  @ApiProperty({ required: false, example: 'Contaminated ice supply at the packing facility' })
  @IsOptional()
  @IsString()
  @MinLength(5)
  rootCause?: string;

  @ApiProperty({ required: false, example: 'All affected inventory destroyed and disposed per health authority guidance' })
  @IsOptional()
  @IsString()
  @MinLength(5)
  resolutionNotes?: string;
}
