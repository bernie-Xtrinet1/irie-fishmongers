import { ApiProperty } from '@nestjs/swagger';

import { IncidentResponseEntity } from './incident-response.entity';

export class PaginatedIncidentsEntity {
  @ApiProperty({ type: IncidentResponseEntity, isArray: true })
  items!: IncidentResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
