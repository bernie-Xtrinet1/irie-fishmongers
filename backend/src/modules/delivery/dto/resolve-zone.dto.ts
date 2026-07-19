import { ApiProperty } from '@nestjs/swagger';
import { Parish } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class ResolveZoneDto {
  @ApiProperty({ enum: Parish })
  @IsEnum(Parish)
  parish!: Parish;
}
