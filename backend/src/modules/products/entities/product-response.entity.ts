import { ApiProperty } from '@nestjs/swagger';
import { ProductUnit } from '@prisma/client';

import { CataloguePhotoEntity } from '../../catalogue/entities/catalogue-photo.entity';

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

  @ApiProperty({ required: false, nullable: true })
  catalogueItemId?: string | null;

  @ApiProperty({ required: false, nullable: true })
  speciesId?: string | null;

  @ApiProperty({ required: false, nullable: true })
  speciesName?: string | null;

  @ApiProperty({ required: false, nullable: true })
  cataloguePhotoId?: string | null;

  @ApiProperty({ required: false, default: false })
  isCatalogueReferencePhoto?: boolean;

  @ApiProperty({ required: false, nullable: true, type: CataloguePhotoEntity })
  cataloguePhoto?: CataloguePhotoEntity | null;

  @ApiProperty({ required: false, default: 'LEGACY_PRODUCT' })
  inventoryMode?: string;

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

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Decimal string in pounds, e.g. "15.00" - null if not yet set',
  })
  weightLbs!: string | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ enum: ProductAvailability })
  availability!: ProductAvailability;

  @ApiProperty()
  createdAt!: Date;
}
