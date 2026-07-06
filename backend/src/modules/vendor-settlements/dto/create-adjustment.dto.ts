import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, MinLength } from 'class-validator';

export class CreateAdjustmentDto {
  @ApiProperty({
    example: -500,
    description: 'Positive to top up, negative to claw back (e.g. following a customer refund)',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  amount!: number;

  @ApiProperty({ example: 'Partial refund issued for damaged goods (order #1234)' })
  @IsString()
  @MinLength(5)
  reason!: string;
}
