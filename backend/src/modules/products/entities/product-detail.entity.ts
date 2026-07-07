import { ApiProperty } from '@nestjs/swagger';

import { SeafoodLotPublicEntity } from '../../food-safety/entities/seafood-lot-public.entity';
import {
  ProductDetailMarketplaceModesEntity,
  ProductDetailVendorEntity,
} from './product-detail-vendor.entity';
import { ProductResponseEntity } from './product-response.entity';

// Composes the existing ProductResponseEntity with traceability (via the
// existing SeafoodLotPublicEntity), vendor tier/compliance, and marketplace
// mode data - per customer-screens.md's PRODUCT DETAIL SCREEN spec. Additive
// only: GET /products/:id keeps its existing ProductResponseEntity shape.
export class ProductDetailEntity extends ProductResponseEntity {
  @ApiProperty({ type: SeafoodLotPublicEntity, required: false, nullable: true })
  lot!: SeafoodLotPublicEntity | null;

  @ApiProperty({ type: ProductDetailVendorEntity })
  vendor!: ProductDetailVendorEntity;

  @ApiProperty({ type: ProductDetailMarketplaceModesEntity })
  marketplaceModes!: ProductDetailMarketplaceModesEntity;
}
