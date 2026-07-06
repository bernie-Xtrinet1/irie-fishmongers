import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export class GenerateSettlementsDto {
  @ApiProperty({
    example: '2026-06-29',
    description:
      'Any date within the target settlement week (Jamaica-local); normalized to that week\'s Monday 00:00 through Sunday 23:59.',
  })
  @IsDateString()
  weekStart!: string;
}
