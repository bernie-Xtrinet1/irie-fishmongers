import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export const REPORT_FORMATS = ['json', 'csv'] as const;

export class ReportFormatDto {
  @ApiProperty({ enum: REPORT_FORMATS, required: false, default: 'json' })
  @IsOptional()
  @IsIn(REPORT_FORMATS)
  format?: (typeof REPORT_FORMATS)[number];
}
