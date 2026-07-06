import { ApiProperty } from '@nestjs/swagger';

import { TemperatureReadingResponseEntity } from './temperature-reading-response.entity';

export class PaginatedTemperatureReadingsEntity {
  @ApiProperty({ type: TemperatureReadingResponseEntity, isArray: true })
  items!: TemperatureReadingResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
