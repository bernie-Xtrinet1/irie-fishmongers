import { ApiProperty } from '@nestjs/swagger';

import { DeliveryExceptionResponseEntity } from './delivery-exception-response.entity';

export class PaginatedDeliveryExceptionsEntity {
  @ApiProperty({ type: DeliveryExceptionResponseEntity, isArray: true })
  items!: DeliveryExceptionResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
