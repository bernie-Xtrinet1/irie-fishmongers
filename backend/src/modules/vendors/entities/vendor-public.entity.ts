import { ApiProperty } from '@nestjs/swagger';
import { Parish, VendorTier } from '@prisma/client';

export class VendorPublicEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  businessName!: string;

  @ApiProperty({ required: false, nullable: true })
  description!: string | null;

  @ApiProperty({ enum: Parish })
  parish!: Parish;

  @ApiProperty({ required: false, nullable: true })
  logoUrl!: string | null;

  @ApiProperty({
    enum: VendorTier,
    description: 'Fetch GET /vendors/:id/permissions for the tier badge and full permission set',
  })
  tier!: VendorTier;

  @ApiProperty({ required: false, nullable: true })
  complianceScore!: number | null;
}
