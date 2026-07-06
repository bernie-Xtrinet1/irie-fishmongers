import { ApiProperty } from '@nestjs/swagger';
import { FoodSafetyStatus } from '@prisma/client';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

// RECALLED is deliberately excluded here - a lot only ever becomes RECALLED
// through the Recall workflow (activating a Recall cascades the status),
// never via this direct override endpoint.
export const ASSIGNABLE_LOT_STATUSES = [
  FoodSafetyStatus.SAFE,
  FoodSafetyStatus.UNDER_REVIEW,
  FoodSafetyStatus.SAFETY_HOLD,
  FoodSafetyStatus.QUARANTINED,
  FoodSafetyStatus.REJECTED,
] as const;

export class UpdateLotStatusDto {
  @ApiProperty({ enum: ASSIGNABLE_LOT_STATUSES })
  @IsIn(ASSIGNABLE_LOT_STATUSES)
  status!: (typeof ASSIGNABLE_LOT_STATUSES)[number];

  @ApiProperty({ required: false, example: 'Cleared after corrective action review' })
  @IsOptional()
  @IsString()
  @MinLength(5)
  reason?: string;
}
