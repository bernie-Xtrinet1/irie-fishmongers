import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

// Both optional - default to all-time when omitted. Only narrows the
// financials/orders pieces of the summary (the only ones with a natural
// date dimension via createdAt); vendor/driver/compliance counts are
// point-in-time snapshots and ignore this range regardless.
//
// Both bounds are interpreted as UTC instants (a plain date like
// "2026-01-01" parses as 2026-01-01T00:00:00.000Z); `to` is inclusive
// (createdAt <= to). The controller rejects from > to with 400.
export class DashboardSummaryQueryDto {
  @ApiProperty({ required: false, example: '2026-01-01', description: 'Defaults to all-time when omitted (UTC, inclusive lower bound)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({ required: false, example: '2026-12-31', description: 'Defaults to all-time when omitted (UTC, inclusive upper bound)' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
