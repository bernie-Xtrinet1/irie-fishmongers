import { ApiProperty } from '@nestjs/swagger';

import { QualityInspectionResponseEntity } from './quality-inspection-response.entity';

export class PaginatedQualityInspectionsEntity {
  @ApiProperty({ type: QualityInspectionResponseEntity, isArray: true })
  items!: QualityInspectionResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
