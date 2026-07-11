import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ListCustodyEventsDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  catchId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  lotId?: string;
}
