import { ApiProperty } from '@nestjs/swagger';
import { VendorSettlementStatus } from '@prisma/client';

export class VendorSettlementResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  vendorId!: string;

  @ApiProperty()
  vendorOrderId!: string;

  @ApiProperty()
  grossAmount!: string;

  @ApiProperty()
  platformFee!: string;

  @ApiProperty()
  netAmount!: string;

  @ApiProperty({
    description: 'netAmount plus the sum of any recorded adjustments (e.g. refund clawbacks)',
  })
  adjustedNetAmount!: string;

  @ApiProperty({ enum: VendorSettlementStatus })
  status!: VendorSettlementStatus;

  @ApiProperty({ required: false, nullable: true })
  paymentDate!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  notes!: string | null;

  @ApiProperty()
  createdAt!: Date;
}
