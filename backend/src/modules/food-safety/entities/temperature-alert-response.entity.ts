import { ApiProperty } from '@nestjs/swagger';
import { AlertSeverity } from '@prisma/client';

export class TemperatureAlertResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  readingId!: string;

  @ApiProperty()
  lotId!: string;

  @ApiProperty({ enum: AlertSeverity })
  severity!: AlertSeverity;

  @ApiProperty()
  actualC!: string;

  @ApiProperty()
  resolved!: boolean;

  @ApiProperty({ required: false, nullable: true })
  resolvedAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}
