import { ApiProperty } from '@nestjs/swagger';

import { TemperatureAlertResponseEntity } from './temperature-alert-response.entity';

export class PaginatedTemperatureAlertsEntity {
  @ApiProperty({ type: TemperatureAlertResponseEntity, isArray: true })
  items!: TemperatureAlertResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
