import { ApiProperty } from '@nestjs/swagger';
import { ProductUnit } from '@prisma/client';

export enum ProductAvailability {
  ACTIVE = 'ACTIVE',
  OUT_OF_STOCK = 'OUT_OF_STOCK',
  INACTIVE = 'INACTIVE',
  ON_HOLD = 'ON_HOLD',
}

export class ProductResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  vendorId!: string;

  @ApiProperty()
  categoryId!: string;

  @ApiProperty({ required: false, nullable: true })
  lotId!: string | null;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ enum: ProductUnit })
  unit!: ProductUnit;

  @ApiProperty({ description: 'Decimal string, e.g. "850.00"' })
  price!: string;

  @ApiProperty()
  currency!: string;

  @ApiProperty()
  quantityAvailable!: number;

  @ApiProperty()
  imageUrl!: string;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ enum: ProductAvailability })
  availability!: ProductAvailability;

  @ApiProperty()
  createdAt!: Date;
}
