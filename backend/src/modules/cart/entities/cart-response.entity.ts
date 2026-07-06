import { ApiProperty } from '@nestjs/swagger';

import { CartItemResponseEntity } from './cart-item-response.entity';

export class CartResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty({ type: CartItemResponseEntity, isArray: true })
  items!: CartItemResponseEntity[];

  @ApiProperty({ description: 'Sum of all item subtotals, as a decimal string' })
  total!: string;
}
