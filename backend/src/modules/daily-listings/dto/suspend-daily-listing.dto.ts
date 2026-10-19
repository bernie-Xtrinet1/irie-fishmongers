import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class SuspendDailyListingDto {
  @ApiProperty({ description: 'Administrative or compliance reason for suspending this listing', example: 'Emergency regulatory closed season enforcement or inspection defect' })
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  reason: string;
}
