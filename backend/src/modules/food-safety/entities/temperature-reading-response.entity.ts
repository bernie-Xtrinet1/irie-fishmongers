import { ApiProperty } from '@nestjs/swagger';
import { TemperatureCheckpoint } from '@prisma/client';

export class TemperatureReadingResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  lotId!: string;

  @ApiProperty({ enum: TemperatureCheckpoint })
  checkpoint!: TemperatureCheckpoint;

  @ApiProperty()
  temperatureC!: string;

  @ApiProperty({ required: false, nullable: true })
  latitude!: number | null;

  @ApiProperty({ required: false, nullable: true })
  longitude!: number | null;

  @ApiProperty({ required: false, nullable: true })
  photoUrl!: string | null;

  @ApiProperty()
  recordedAt!: Date;
}
