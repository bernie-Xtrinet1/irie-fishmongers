import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class ListWasteDisposalRecordsDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  lotId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  recallId?: string;
}
