import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

// A moderator must always state why a review was removed - the reason is a
// required part of the audit trail (Phase 13B), never optional telemetry.
export class RemoveReviewDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(({ value }): unknown => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(3, 500)
  reason!: string;
}
