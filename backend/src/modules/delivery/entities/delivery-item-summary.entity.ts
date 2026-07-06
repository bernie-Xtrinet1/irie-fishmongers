import { ApiProperty } from '@nestjs/swagger';
import { ProductUnit } from '@prisma/client';

export class DeliveryItemSummaryEntity {
  @ApiProperty()
  productName!: string;

  @ApiProperty({ enum: ProductUnit })
  unit!: ProductUnit;

  @ApiProperty()
  quantity!: number;
}
