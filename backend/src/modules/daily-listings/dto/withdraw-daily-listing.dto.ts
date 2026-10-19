import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class WithdrawDailyListingDto {
  @ApiProperty({ description: 'Reason for withdrawing this listing from sale', example: 'Catch batch reserved for private catering event' })
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  reason: string;
}
