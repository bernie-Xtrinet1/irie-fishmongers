import { ApiProperty } from '@nestjs/swagger';

import { ProductResponseEntity } from './product-response.entity';

export class PaginatedProductsEntity {
  @ApiProperty({ type: ProductResponseEntity, isArray: true })
  items!: ProductResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
