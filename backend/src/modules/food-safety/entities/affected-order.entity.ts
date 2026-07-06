import { ApiProperty } from '@nestjs/swagger';

export class AffectedOrderEntity {
  @ApiProperty()
  orderId!: string;

  @ApiProperty()
  vendorOrderId!: string;

  @ApiProperty()
  customerId!: string;

  @ApiProperty()
  customerEmail!: string;

  @ApiProperty()
  productId!: string;

  @ApiProperty()
  productName!: string;

  @ApiProperty()
  quantity!: number;

  @ApiProperty()
  lotId!: string;
}
