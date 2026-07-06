import { ApiProperty } from '@nestjs/swagger';
import { ProductUnit } from '@prisma/client';

export class CartItemResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  productId!: string;

  @ApiProperty()
  productName!: string;

  @ApiProperty()
  vendorId!: string;

  @ApiProperty()
  unitPrice!: string;

  @ApiProperty({ enum: ProductUnit })
  unit!: ProductUnit;

  @ApiProperty()
  quantity!: number;

  @ApiProperty({ description: 'unitPrice * quantity, as a decimal string' })
  subtotal!: string;
}
