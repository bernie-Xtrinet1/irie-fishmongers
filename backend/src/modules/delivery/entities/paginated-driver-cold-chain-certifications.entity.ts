import { ApiProperty } from '@nestjs/swagger';

import { DriverColdChainCertificationResponseEntity } from './driver-cold-chain-certification-response.entity';

export class PaginatedDriverColdChainCertificationsEntity {
  @ApiProperty({ type: DriverColdChainCertificationResponseEntity, isArray: true })
  items!: DriverColdChainCertificationResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
