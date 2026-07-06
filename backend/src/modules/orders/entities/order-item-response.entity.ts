import { ApiProperty } from '@nestjs/swagger';
import { ProductUnit } from '@prisma/client';

export class OrderItemResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  productId!: string;

  @ApiProperty()
  productName!: string;

  @ApiProperty()
  unitPrice!: string;

  @ApiProperty({ enum: ProductUnit })
  unit!: ProductUnit;

  @ApiProperty()
  quantity!: number;

  @ApiProperty()
  subtotal!: string;
}
