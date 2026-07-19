import { ApiProperty } from '@nestjs/swagger';

import { RegulatoryCertificationResponseEntity } from './regulatory-certification-response.entity';

export class PaginatedRegulatoryCertificationsEntity {
  @ApiProperty({ type: RegulatoryCertificationResponseEntity, isArray: true })
  items!: RegulatoryCertificationResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
