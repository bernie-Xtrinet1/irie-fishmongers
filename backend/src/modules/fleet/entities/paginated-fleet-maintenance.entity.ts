import { ApiProperty } from '@nestjs/swagger';

import { FleetMaintenanceResponseEntity } from './fleet-maintenance-response.entity';

export class PaginatedFleetMaintenanceEntity {
  @ApiProperty({ type: FleetMaintenanceResponseEntity, isArray: true })
  items!: FleetMaintenanceResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
