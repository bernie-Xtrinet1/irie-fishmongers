import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

// Both optional - default to all-time when omitted. Only narrows the
// financials/orders pieces of the summary (the only ones with a natural
// date dimension via createdAt); vendor/driver/compliance counts are
// point-in-time snapshots and ignore this range regardless.
export class DashboardSummaryQueryDto {
  @ApiProperty({ required: false, example: '2026-01-01', description: 'Defaults to all-time when omitted' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({ required: false, example: '2026-12-31', description: 'Defaults to all-time when omitted' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
