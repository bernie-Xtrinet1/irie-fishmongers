import { ApiProperty } from '@nestjs/swagger';
import { EmergencyResponseStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

export class ListEmergencyResponsesDto {
  @ApiProperty({ enum: EmergencyResponseStatus, required: false })
  @IsOptional()
  @IsEnum(EmergencyResponseStatus)
  status?: EmergencyResponseStatus;
}
