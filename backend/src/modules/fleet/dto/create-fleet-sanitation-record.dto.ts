import { ApiProperty } from '@nestjs/swagger';
import { SanitationStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';

export class CreateFleetSanitationRecordDto {
  @ApiProperty()
  @IsDateString()
  performedAt!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  performedBy?: string;

  @ApiProperty({ required: false, description: 'e.g. "Chlorine wash", "Steam clean"' })
  @IsOptional()
  @IsString()
  method?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  nextDueAt?: string;

  @ApiProperty({ enum: SanitationStatus, required: false })
  @IsOptional()
  @IsEnum(SanitationStatus)
  status?: SanitationStatus;
}
