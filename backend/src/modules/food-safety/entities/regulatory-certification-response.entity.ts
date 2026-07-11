import { ApiProperty } from '@nestjs/swagger';
import { CertificationStatus } from '@prisma/client';

export class RegulatoryCertificationResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty({ required: false, nullable: true })
  vendorId!: string | null;

  @ApiProperty({ required: false, nullable: true })
  fishermanId!: string | null;

  @ApiProperty({ required: false, nullable: true })
  landingSiteId!: string | null;

  @ApiProperty()
  certificateType!: string;

  @ApiProperty()
  certificateNumber!: string;

  @ApiProperty()
  issuingAuthorityId!: string;

  @ApiProperty()
  issuedDate!: Date;

  @ApiProperty({ required: false, nullable: true })
  expiryDate!: Date | null;

  @ApiProperty({ enum: CertificationStatus })
  status!: CertificationStatus;

  @ApiProperty({ required: false, nullable: true })
  documentUrl!: string | null;

  @ApiProperty()
  createdAt!: Date;
}
