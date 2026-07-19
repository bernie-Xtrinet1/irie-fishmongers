import { ApiProperty } from '@nestjs/swagger';
import { DocumentReviewStatus, VendorDocumentType, VendorTier } from '@prisma/client';

export type RequiredDocumentStatus = DocumentReviewStatus | 'MISSING';

export class RequiredDocumentStatusEntity {
  @ApiProperty({ enum: VendorDocumentType })
  type!: VendorDocumentType;

  @ApiProperty({
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'MISSING'],
    description: 'MISSING means the vendor has not uploaded this document type at all',
  })
  status!: RequiredDocumentStatus;
}

export class VendorComplianceStatusEntity {
  @ApiProperty({ enum: VendorTier })
  tier!: VendorTier;

  @ApiProperty({ description: 'True once every document type required by this tier is APPROVED' })
  canSell!: boolean;

  @ApiProperty({ type: [RequiredDocumentStatusEntity] })
  requiredDocuments!: RequiredDocumentStatusEntity[];
}
