import { ApiProperty } from '@nestjs/swagger';
import { VendorStatus, VendorTier } from '@prisma/client';

class VendorsByStatusEntity implements Record<VendorStatus, number> {
  @ApiProperty()
  PENDING!: number;

  @ApiProperty()
  APPROVED!: number;

  @ApiProperty()
  SUSPENDED!: number;

  @ApiProperty()
  REJECTED!: number;
}

class VendorsByTierEntity implements Record<VendorTier, number> {
  @ApiProperty()
  COMMUNITY_FISHER!: number;

  @ApiProperty()
  VERIFIED_VENDOR!: number;

  @ApiProperty()
  COMMERCIAL_SUPPLIER!: number;

  @ApiProperty()
  ENTERPRISE_SUPPLIER!: number;
}

export class TopVendorEntity {
  @ApiProperty()
  vendorId!: string;

  @ApiProperty()
  businessName!: string;

  @ApiProperty({ description: 'sum(VendorSettlement.grossAmount) where status=PAID, within the requested range' })
  grossAmount!: string;
}

export class VendorDashboardEntity {
  @ApiProperty({ type: VendorsByStatusEntity, description: 'Point-in-time snapshot - ignores the from/to range' })
  byStatus!: VendorsByStatusEntity;

  @ApiProperty({ type: VendorsByTierEntity, description: 'Point-in-time snapshot - ignores the from/to range' })
  byTier!: VendorsByTierEntity;

  @ApiProperty({ required: false, nullable: true, description: 'Point-in-time snapshot - ignores the from/to range' })
  averageComplianceScore!: number | null;

  @ApiProperty({ type: TopVendorEntity, isArray: true })
  topVendorsByRevenue!: TopVendorEntity[];
}
