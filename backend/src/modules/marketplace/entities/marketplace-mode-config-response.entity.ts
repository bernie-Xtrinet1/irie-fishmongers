import { ApiProperty } from '@nestjs/swagger';

export class MarketplaceModeConfigResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  customerSelectedEnabled!: boolean;

  @ApiProperty()
  bestAvailableEnabled!: boolean;

  @ApiProperty()
  createdAt!: Date;
}
