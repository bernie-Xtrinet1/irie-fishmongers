import { ApiProperty } from '@nestjs/swagger';

export class RateConfigResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  baseFee!: string;

  @ApiProperty()
  distanceCompensationEnabled!: boolean;

  @ApiProperty()
  distanceRatePerKm!: string;

  @ApiProperty()
  heavyLoadThresholdLbs!: string;

  @ApiProperty()
  heavyLoadBonus!: string;

  @ApiProperty()
  peakBonus!: string;

  @ApiProperty()
  volumeBonusTier1Threshold!: number;

  @ApiProperty()
  volumeBonusTier1Amount!: string;

  @ApiProperty()
  volumeBonusTier2Threshold!: number;

  @ApiProperty()
  volumeBonusTier2Amount!: string;

  @ApiProperty()
  volumeBonusTier3Threshold!: number;

  @ApiProperty()
  volumeBonusTier3Amount!: string;

  @ApiProperty()
  createdAt!: Date;
}
