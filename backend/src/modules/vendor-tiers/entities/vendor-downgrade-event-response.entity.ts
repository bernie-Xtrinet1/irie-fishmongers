import { ApiProperty } from '@nestjs/swagger';
import { DowngradeReason, VendorTier } from '@prisma/client';

export class VendorDowngradeEventResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  vendorId!: string;

  @ApiProperty({ enum: VendorTier })
  fromTier!: VendorTier;

  @ApiProperty({ enum: VendorTier })
  toTier!: VendorTier;

  @ApiProperty({ enum: DowngradeReason })
  reason!: DowngradeReason;

  @ApiProperty({ required: false, nullable: true })
  triggeredById!: string | null;

  @ApiProperty({ required: false, nullable: true })
  notes!: string | null;

  @ApiProperty()
  createdAt!: Date;
}
