import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CheckoutRolloutBehavior } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class RevisionMutationDto {
  @ApiProperty({ nullable: true, type: Number })
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(2147483646)
  expectedRevision!: number | null;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class CreateRolloutControlDto extends RevisionMutationDto {
  @ApiProperty()
  @IsBoolean()
  newAdmissionStopped!: boolean;

  @ApiProperty({ enum: CheckoutRolloutBehavior })
  @IsEnum(CheckoutRolloutBehavior)
  behavior!: CheckoutRolloutBehavior;

  @ApiProperty({ nullable: true, type: String })
  @ValidateIf((_object, value) => value !== null)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
  eligibleCohort!: string | null;
}

export class CreateRolloutParticipantDto extends RevisionMutationDto {
  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ nullable: true, type: String })
  @ValidateIf((_object, value) => value !== null)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
  cohort!: string | null;
}

export class RolloutHistoryDto {
  @ApiPropertyOptional({ default: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  afterRevision = 0;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;
}
