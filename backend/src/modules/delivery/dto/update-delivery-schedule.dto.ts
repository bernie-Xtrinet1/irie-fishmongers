import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

export class UpdateDeliveryScheduleDto {
  @ApiProperty({ required: false, description: 'Start of the appointment window for vendor pickup' })
  @IsOptional()
  @IsDateString()
  scheduledPickupWindowStart?: string;

  @ApiProperty({ required: false, description: 'End of the appointment window for vendor pickup' })
  @IsOptional()
  @IsDateString()
  scheduledPickupWindowEnd?: string;

  @ApiProperty({ required: false, description: 'Start of the customer-facing delivery window' })
  @IsOptional()
  @IsDateString()
  customerDeliveryWindowStart?: string;

  @ApiProperty({ required: false, description: 'End of the customer-facing delivery window' })
  @IsOptional()
  @IsDateString()
  customerDeliveryWindowEnd?: string;
}
