import { ApiProperty } from '@nestjs/swagger';

import { FleetSanitationRecordResponseEntity } from './fleet-sanitation-record-response.entity';

export class PaginatedFleetSanitationRecordsEntity {
  @ApiProperty({ type: FleetSanitationRecordResponseEntity, isArray: true })
  items!: FleetSanitationRecordResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
