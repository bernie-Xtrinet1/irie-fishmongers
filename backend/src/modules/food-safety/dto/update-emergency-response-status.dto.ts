import { ApiProperty } from '@nestjs/swagger';
import { EmergencyResponseStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateEmergencyResponseStatusDto {
  @ApiProperty({ enum: EmergencyResponseStatus })
  @IsEnum(EmergencyResponseStatus)
  status!: EmergencyResponseStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  actionsTaken?: string;

  @ApiProperty({ required: false, description: 'Required when transitioning to RESOLVED' })
  @IsOptional()
  @IsString()
  @MinLength(10)
  rootCause?: string;

  @ApiProperty({ required: false, description: 'Required when transitioning to RESOLVED' })
  @IsOptional()
  @IsString()
  @MinLength(10)
  correctiveAction?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  preventiveAction?: string;
}
