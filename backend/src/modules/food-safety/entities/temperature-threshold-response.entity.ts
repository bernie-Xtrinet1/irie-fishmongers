import { ApiProperty } from '@nestjs/swagger';
import { Prisma, SeafoodStorageType } from '@prisma/client';

export class TemperatureThresholdResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty({ required: false, nullable: true })
  deviceId!: string | null;

  @ApiProperty({ enum: SeafoodStorageType })
  storageType!: SeafoodStorageType;

  @ApiProperty({ type: String })
  minC!: Prisma.Decimal;

  @ApiProperty({ type: String })
  maxC!: Prisma.Decimal;

  @ApiProperty({ type: String })
  warningBandC!: Prisma.Decimal;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
