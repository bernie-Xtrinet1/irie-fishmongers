import { ApiProperty } from '@nestjs/swagger';

export class VendorSelectionWeightConfigResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  inventoryWeight!: string;

  @ApiProperty()
  freshnessWeight!: string;

  @ApiProperty()
  complianceWeight!: string;

  @ApiProperty()
  distanceWeight!: string;

  @ApiProperty()
  ratingWeight!: string;

  @ApiProperty()
  deliveryCapacityWeight!: string;

  @ApiProperty()
  createdAt!: Date;
}
