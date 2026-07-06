import { ApiProperty } from '@nestjs/swagger';
import { IsInt, NotEquals } from 'class-validator';

export class AdjustStockDto {
  @ApiProperty({
    example: -5,
    description: 'Amount to add (positive) or remove (negative) from available stock',
  })
  @IsInt()
  @NotEquals(0)
  delta!: number;
}
