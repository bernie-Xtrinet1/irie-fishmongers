import { ApiProperty } from '@nestjs/swagger';
import { DocumentReviewStatus, VendorDocumentType } from '@prisma/client';

export class VendorDocumentResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  vendorId!: string;

  @ApiProperty({ enum: VendorDocumentType })
  documentType!: VendorDocumentType;

  @ApiProperty()
  fileUrl!: string;

  @ApiProperty({ required: false, nullable: true })
  documentNumber!: string | null;

  @ApiProperty({ required: false, nullable: true })
  issuedDate!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  expiryDate!: Date | null;

  @ApiProperty({ enum: DocumentReviewStatus })
  status!: DocumentReviewStatus;

  @ApiProperty({ required: false, nullable: true })
  rejectionReason!: string | null;

  @ApiProperty({ required: false, nullable: true })
  verifiedById!: string | null;

  @ApiProperty({ required: false, nullable: true })
  verifiedAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}
