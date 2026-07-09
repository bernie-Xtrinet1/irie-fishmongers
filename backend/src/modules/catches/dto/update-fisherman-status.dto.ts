import { ApiProperty } from '@nestjs/swagger';
import { FishermanStatus } from '@prisma/client';
import { IsIn } from 'class-validator';

export const ASSIGNABLE_FISHERMAN_STATUSES = [
  FishermanStatus.APPROVED,
  FishermanStatus.SUSPENDED,
  FishermanStatus.REJECTED,
] as const;

export class UpdateFishermanStatusDto {
  @ApiProperty({ enum: ASSIGNABLE_FISHERMAN_STATUSES })
  @IsIn(ASSIGNABLE_FISHERMAN_STATUSES)
  status!: (typeof ASSIGNABLE_FISHERMAN_STATUSES)[number];
}
