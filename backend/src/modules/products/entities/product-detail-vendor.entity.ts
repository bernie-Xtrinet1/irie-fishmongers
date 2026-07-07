import { ApiProperty } from '@nestjs/swagger';
import { Parish, VendorTier } from '@prisma/client';

import { VendorComplianceStatusLabel } from '../../vendor-tiers/entities/vendor-profile-response.entity';

export class ProductDetailVendorEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  businessName!: string;

  @ApiProperty({ enum: VendorTier })
  tier!: VendorTier;

  @ApiProperty()
  badge!: string;

  @ApiProperty({ enum: Parish })
  parish!: Parish;

  @ApiProperty({ required: false, nullable: true })
  complianceScore!: number | null;

  @ApiProperty({ enum: VendorComplianceStatusLabel })
  complianceStatus!: VendorComplianceStatusLabel;

  @ApiProperty({ required: false, nullable: true })
  logoUrl!: string | null;
}

export class ProductDetailMarketplaceModesEntity {
  @ApiProperty()
  customerSelectedEnabled!: boolean;

  @ApiProperty()
  bestAvailableEnabled!: boolean;
}
