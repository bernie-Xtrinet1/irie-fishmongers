import { ApiProperty } from '@nestjs/swagger';

// Returned by POST /marketplace/best-vendor/resolve. The frontend calls the
// existing, unmodified POST /cart/items with `productId` next - this
// endpoint only resolves which vendor's product wins, it never touches the
// cart itself (see docs/database-design.md's backward-compatibility note).
export class BestVendorResolutionEntity {
  @ApiProperty({ description: "The winning vendor's product id - pass this to POST /cart/items" })
  productId!: string;

  @ApiProperty()
  vendorId!: string;

  @ApiProperty()
  badge!: string;

  @ApiProperty({ description: 'Decimal string, 0-100' })
  totalScore!: string;

  @ApiProperty()
  fulfillmentDecisionId!: string;
}
