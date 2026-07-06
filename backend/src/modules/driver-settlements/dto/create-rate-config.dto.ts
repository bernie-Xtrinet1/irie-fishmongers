import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNumber, Min } from 'class-validator';

export class CreateRateConfigDto {
  @ApiProperty({ example: 150 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  baseFee!: number;

  @ApiProperty({ example: true })
  @IsBoolean()
  distanceCompensationEnabled!: boolean;

  @ApiProperty({ example: 20 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  distanceRatePerKm!: number;

  @ApiProperty({ example: 50 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  heavyLoadThresholdLbs!: number;

  @ApiProperty({ example: 200 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  heavyLoadBonus!: number;

  @ApiProperty({ example: 100 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  peakBonus!: number;

  @ApiProperty({ example: 20 })
  @IsInt()
  @Min(1)
  volumeBonusTier1Threshold!: number;

  @ApiProperty({ example: 1000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  volumeBonusTier1Amount!: number;

  @ApiProperty({ example: 40 })
  @IsInt()
  @Min(1)
  volumeBonusTier2Threshold!: number;

  @ApiProperty({ example: 3000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  volumeBonusTier2Amount!: number;

  @ApiProperty({ example: 60 })
  @IsInt()
  @Min(1)
  volumeBonusTier3Threshold!: number;

  @ApiProperty({ example: 5000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  volumeBonusTier3Amount!: number;
}
