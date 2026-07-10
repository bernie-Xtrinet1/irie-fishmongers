import { ApiProperty } from '@nestjs/swagger';

import { AuditLogResponseEntity } from './audit-log-response.entity';

export class PaginatedAuditLogsEntity {
  @ApiProperty({ type: AuditLogResponseEntity, isArray: true })
  items!: AuditLogResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
