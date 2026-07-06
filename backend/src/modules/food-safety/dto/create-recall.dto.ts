import { ApiProperty } from '@nestjs/swagger';
import { RecallSeverityClass } from '@prisma/client';
import { ArrayMinSize, IsArray, IsEnum, IsString, IsUUID, MinLength } from 'class-validator';

export class CreateRecallDto {
  @ApiProperty({ enum: RecallSeverityClass })
  @IsEnum(RecallSeverityClass)
  severityClass!: RecallSeverityClass;

  @ApiProperty({ example: 'Elevated histamine levels detected in post-market sampling' })
  @IsString()
  @MinLength(10)
  reason!: string;

  @ApiProperty({ type: [String], description: 'Seafood lot ids affected by this recall' })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  lotIds!: string[];
}
