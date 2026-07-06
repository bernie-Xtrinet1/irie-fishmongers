import { ApiProperty } from '@nestjs/swagger';
import { SettlementStatus } from '@prisma/client';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export const ASSIGNABLE_SETTLEMENT_STATUSES = [
  SettlementStatus.APPROVED,
  SettlementStatus.PAID,
  SettlementStatus.FAILED,
  SettlementStatus.DISPUTED,
] as const;

export class UpdateSettlementStatusDto {
  @ApiProperty({ enum: ASSIGNABLE_SETTLEMENT_STATUSES })
  @IsIn(ASSIGNABLE_SETTLEMENT_STATUSES)
  status!: (typeof ASSIGNABLE_SETTLEMENT_STATUSES)[number];

  @ApiProperty({ required: false, example: 'Bank transfer reference #4471' })
  @IsOptional()
  @IsString()
  @MinLength(5)
  notes?: string;
}
