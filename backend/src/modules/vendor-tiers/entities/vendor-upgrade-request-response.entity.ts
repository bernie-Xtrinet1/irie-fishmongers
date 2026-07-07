import { ApiProperty } from '@nestjs/swagger';
import { TierRequestStatus, VendorTier } from '@prisma/client';

export class VendorUpgradeRequestResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  vendorId!: string;

  @ApiProperty({ enum: VendorTier })
  requestedTier!: VendorTier;

  @ApiProperty({ enum: TierRequestStatus })
  status!: TierRequestStatus;

  @ApiProperty({ required: false, nullable: true })
  reason!: string | null;

  @ApiProperty({ required: false, nullable: true })
  reviewedById!: string | null;

  @ApiProperty({ required: false, nullable: true })
  reviewedAt!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  reviewNotes!: string | null;

  @ApiProperty()
  createdAt!: Date;
}
