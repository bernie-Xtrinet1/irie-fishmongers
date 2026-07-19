import { ApiProperty } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';

export class RouteHistoryResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  deliveryId!: string;

  @ApiProperty()
  driverId!: string;

  @ApiProperty()
  gpsSamples!: number;

  @ApiProperty({ type: String })
  distanceKm!: Prisma.Decimal;

  @ApiProperty()
  durationMinutes!: number;

  @ApiProperty()
  createdAt!: Date;
}
