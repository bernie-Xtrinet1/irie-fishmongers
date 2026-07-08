import { ApiProperty } from '@nestjs/swagger';

import { FleetTripResponseEntity } from './fleet-trip-response.entity';

export class PaginatedFleetTripsEntity {
  @ApiProperty({ type: FleetTripResponseEntity, isArray: true })
  items!: FleetTripResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
