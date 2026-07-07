import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class CreateModeConfigDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  customerSelectedEnabled!: boolean;

  @ApiProperty({ example: false })
  @IsBoolean()
  bestAvailableEnabled!: boolean;
}
