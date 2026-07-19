import { ApiProperty } from '@nestjs/swagger';
import { DeliveryExceptionType } from '@prisma/client';

export class DeliveryExceptionResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  deliveryId!: string;

  @ApiProperty({ enum: DeliveryExceptionType })
  type!: DeliveryExceptionType;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ type: [String] })
  photos!: string[];

  @ApiProperty({ required: false, nullable: true })
  notes!: string | null;

  @ApiProperty()
  resolved!: boolean;

  @ApiProperty({ required: false, nullable: true })
  resolvedAt!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  resolvedById!: string | null;

  @ApiProperty()
  createdAt!: Date;
}
