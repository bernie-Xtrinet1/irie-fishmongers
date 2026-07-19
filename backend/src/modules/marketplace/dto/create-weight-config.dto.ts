import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Max, Min } from 'class-validator';

export class CreateWeightConfigDto {
  @ApiProperty({ example: 0.3 })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  inventoryWeight!: number;

  @ApiProperty({ example: 0.2 })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  freshnessWeight!: number;

  @ApiProperty({ example: 0.2 })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  complianceWeight!: number;

  @ApiProperty({ example: 0.15 })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  distanceWeight!: number;

  @ApiProperty({ example: 0.05 })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  ratingWeight!: number;

  @ApiProperty({ example: 0.1 })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  deliveryCapacityWeight!: number;
}
