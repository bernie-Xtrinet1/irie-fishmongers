import { ApiProperty } from '@nestjs/swagger';
import { PaymentInitiationStatus, PaymentProviderName, PaymentStatus } from '@prisma/client';

export class PaymentResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  orderId!: string;

  @ApiProperty({ enum: PaymentProviderName })
  provider!: PaymentProviderName;

  @ApiProperty({ enum: PaymentStatus })
  status!: PaymentStatus;

  @ApiProperty({ enum: PaymentInitiationStatus })
  initiationStatus!: PaymentInitiationStatus;

  @ApiProperty()
  amount!: string;

  @ApiProperty()
  currency!: string;

  @ApiProperty({ required: false, nullable: true })
  paidAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}
