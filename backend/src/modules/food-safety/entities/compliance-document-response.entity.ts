import { ApiProperty } from '@nestjs/swagger';
import { ComplianceDocumentType } from '@prisma/client';

export class ComplianceDocumentResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: ComplianceDocumentType })
  documentType!: ComplianceDocumentType;

  @ApiProperty({ required: false, nullable: true })
  relatedLotId!: string | null;

  @ApiProperty({ required: false, nullable: true })
  relatedRecallId!: string | null;

  @ApiProperty()
  fileUrl!: string;

  @ApiProperty()
  version!: number;

  @ApiProperty()
  uploadedById!: string;

  @ApiProperty()
  createdAt!: Date;
}
