import { ApiProperty } from '@nestjs/swagger';
import { RefundStatus } from '@prisma/client';

export class RefundResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  paymentId!: string;

  @ApiProperty()
  amount!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ enum: RefundStatus })
  status!: RefundStatus;

  @ApiProperty()
  createdAt!: Date;
}
