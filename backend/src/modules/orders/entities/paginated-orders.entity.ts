import { ApiProperty } from '@nestjs/swagger';

import { OrderResponseEntity } from './order-response.entity';

export class PaginatedOrdersEntity {
  @ApiProperty({ type: OrderResponseEntity, isArray: true })
  items!: OrderResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
