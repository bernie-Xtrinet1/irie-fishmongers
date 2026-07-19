import { ApiProperty } from '@nestjs/swagger';
import { CustodyEventType } from '@prisma/client';

export class CustodyEventResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty({ required: false, nullable: true })
  catchId!: string | null;

  @ApiProperty({ required: false, nullable: true })
  lotId!: string | null;

  @ApiProperty({ enum: CustodyEventType })
  eventType!: CustodyEventType;

  @ApiProperty({ required: false, nullable: true })
  fromUserId!: string | null;

  @ApiProperty({ required: false, nullable: true })
  toUserId!: string | null;

  @ApiProperty({ required: false, nullable: true })
  location!: string | null;

  @ApiProperty({ required: false, nullable: true })
  latitude!: number | null;

  @ApiProperty({ required: false, nullable: true })
  longitude!: number | null;

  @ApiProperty({ required: false, nullable: true })
  notes!: string | null;

  @ApiProperty()
  occurredAt!: Date;
}
