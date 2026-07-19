import { ApiProperty } from '@nestjs/swagger';
import { InventoryEventType } from '@prisma/client';

export class InventoryEventResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  productId!: string;

  @ApiProperty({ enum: InventoryEventType })
  eventType!: InventoryEventType;

  @ApiProperty()
  quantityDelta!: number;

  @ApiProperty({ required: false, nullable: true })
  vendorOrderId!: string | null;

  @ApiProperty({ required: false, nullable: true })
  triggeredById!: string | null;

  @ApiProperty({ required: false, nullable: true })
  notes!: string | null;

  @ApiProperty()
  createdAt!: Date;
}
