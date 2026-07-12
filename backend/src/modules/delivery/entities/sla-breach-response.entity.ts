import { ApiProperty } from '@nestjs/swagger';
import { SLABreachType } from '@prisma/client';

export class SLABreachResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  deliveryId!: string;

  @ApiProperty({ enum: SLABreachType })
  type!: SLABreachType;

  @ApiProperty({ description: "The delivery's promised customerDeliveryWindowEnd at time of breach" })
  scheduledEnd!: Date;

  @ApiProperty({ description: 'How many minutes past scheduledEnd this breach was first detected' })
  minutesLate!: number;

  @ApiProperty()
  detectedAt!: Date;

  @ApiProperty()
  resolved!: boolean;

  @ApiProperty({ required: false, nullable: true })
  resolvedAt!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  resolvedById!: string | null;
}
