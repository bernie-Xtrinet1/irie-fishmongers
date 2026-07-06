import { ApiProperty } from '@nestjs/swagger';
import { IncidentSeverity } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class CreateIncidentDto {
  @ApiProperty()
  @IsUUID()
  lotId!: string;

  @ApiProperty({ enum: IncidentSeverity })
  @IsEnum(IncidentSeverity)
  severity!: IncidentSeverity;

  @ApiProperty({ example: 'Packaging found torn on arrival with visible ice loss' })
  @IsString()
  @MinLength(10)
  description!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  photoUrl?: string;
}
