import { ApiProperty } from '@nestjs/swagger';
import { WasteReason, WeightUnit } from '@prisma/client';

export class WasteDisposalRecordResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  lotId!: string;

  @ApiProperty({ required: false, nullable: true })
  productId!: string | null;

  @ApiProperty({ required: false, nullable: true })
  recallId!: string | null;

  @ApiProperty()
  quantity!: string;

  @ApiProperty({ enum: WeightUnit })
  weightUnit!: WeightUnit;

  @ApiProperty({ enum: WasteReason })
  reason!: WasteReason;

  @ApiProperty({ required: false, nullable: true })
  disposalMethod!: string | null;

  @ApiProperty({ type: [String] })
  evidencePhotoUrls!: string[];

  @ApiProperty({ required: false, nullable: true })
  witnessName!: string | null;

  @ApiProperty({ required: false, nullable: true })
  witnessTitle!: string | null;

  @ApiProperty({ required: false, nullable: true })
  witnessSignatureUrl!: string | null;

  @ApiProperty()
  recordedById!: string;

  @ApiProperty()
  disposedAt!: Date;

  @ApiProperty()
  createdAt!: Date;
}
