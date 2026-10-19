import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class WithdrawListingPhotoDto {
  @ApiProperty({ description: 'Reason for withdrawing this photo (audited for evidentiary retention)', example: 'Incorrect photo uploaded for this batch' })
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  reason: string;
}
