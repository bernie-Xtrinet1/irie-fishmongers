import { ApiProperty } from '@nestjs/swagger';

import { DeliveryExceptionWithContextEntity } from './delivery-exception-with-context.entity';

export class PaginatedDeliveryExceptionsWithContextEntity {
  @ApiProperty({ type: DeliveryExceptionWithContextEntity, isArray: true })
  items!: DeliveryExceptionWithContextEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
