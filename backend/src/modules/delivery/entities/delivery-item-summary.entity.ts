import { ApiProperty } from '@nestjs/swagger';
import { ProductUnit } from '@prisma/client';

export class DeliveryItemSummaryEntity {
  @ApiProperty()
  productName!: string;

  @ApiProperty({ enum: ProductUnit })
  unit!: ProductUnit;

  @ApiProperty()
  quantity!: number;

  @ApiProperty({ required: false, nullable: true })
  lotId?: string | null;

  @ApiProperty({ required: false, nullable: true })
  lotNumber?: string | null;

  @ApiProperty({ required: false, nullable: true })
  species?: string | null;

  @ApiProperty({ required: false, nullable: true })
  storageType?: string | null;
}
