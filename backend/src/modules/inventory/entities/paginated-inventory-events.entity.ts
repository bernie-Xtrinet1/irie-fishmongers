import { ApiProperty } from '@nestjs/swagger';

import { InventoryEventResponseEntity } from './inventory-event-response.entity';

export class PaginatedInventoryEventsEntity {
  @ApiProperty({ type: InventoryEventResponseEntity, isArray: true })
  items!: InventoryEventResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
