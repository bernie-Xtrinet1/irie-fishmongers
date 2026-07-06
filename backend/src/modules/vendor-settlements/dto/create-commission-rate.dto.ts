import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Max, Min } from 'class-validator';

export class CreateCommissionRateDto {
  @ApiProperty({
    example: 0.1,
    description: 'Platform commission as a fraction of the vendor order subtotal (0.1 = 10%)',
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  commissionRate!: number;
}
