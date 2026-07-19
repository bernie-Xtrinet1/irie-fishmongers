import { ApiProperty } from '@nestjs/swagger';
import { CertificationStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsUrl } from 'class-validator';

// Covers renew (status: ACTIVE + a future expiryDate), suspend
// (status: SUSPENDED), reinstate (status: ACTIVE from SUSPENDED), and
// revoke (status: REVOKED) - PENDING -> ACTIVE is a separate, explicit
// /activate action, not reachable through this endpoint.
export class UpdateRegulatoryCertificationDto {
  @ApiProperty({ enum: CertificationStatus, required: false })
  @IsOptional()
  @IsEnum(CertificationStatus)
  status?: CertificationStatus;

  @ApiProperty({ required: false, example: '2028-01-15', description: 'Required when renewing an EXPIRED certificate' })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl()
  documentUrl?: string;
}
