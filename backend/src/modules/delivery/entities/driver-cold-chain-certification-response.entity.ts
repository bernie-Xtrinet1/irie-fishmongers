import { ApiProperty } from '@nestjs/swagger';
import { DriverCertificationStatus } from '@prisma/client';

export class DriverColdChainCertificationResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  driverId!: string;

  @ApiProperty()
  issuedBy!: string;

  @ApiProperty()
  issuedAt!: Date;

  @ApiProperty()
  expiresAt!: Date;

  @ApiProperty({ enum: DriverCertificationStatus })
  status!: DriverCertificationStatus;

  @ApiProperty({ required: false, nullable: true })
  documentUrl!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
