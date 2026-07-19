import { ApiProperty } from '@nestjs/swagger';

export class ProductAvailabilityEntity {
  @ApiProperty()
  productId!: string;

  @ApiProperty()
  quantityAvailable!: number;

  @ApiProperty({ description: 'Total quantity currently held in other active carts' })
  reserved!: number;

  @ApiProperty({ description: 'quantityAvailable minus reserved, never negative' })
  availableToPurchase!: number;
}
