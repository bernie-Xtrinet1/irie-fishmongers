import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ListComplianceDocumentsDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  lotId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  recallId?: string;
}
