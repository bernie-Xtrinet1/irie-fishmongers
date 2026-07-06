import { ApiProperty } from '@nestjs/swagger';

import { TemperatureAlertResponseEntity } from './temperature-alert-response.entity';
import { TemperatureReadingResponseEntity } from './temperature-reading-response.entity';

export class RecordReadingResultEntity {
  @ApiProperty({ type: TemperatureReadingResponseEntity })
  reading!: TemperatureReadingResponseEntity;

  @ApiProperty({ type: TemperatureAlertResponseEntity, required: false })
  alert?: TemperatureAlertResponseEntity;
}
