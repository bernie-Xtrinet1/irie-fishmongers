import { ApiProperty } from '@nestjs/swagger';

// The public, customer-facing shape of a review. Deliberately carries NO
// author id, email, phone, or delivery/address data (Phase 13A privacy
// rule). authorDisplayName is a masked "First L." derived server-side;
// verifiedPurchase is always true because eligibility already gates on a
// real completed order.
export class ReviewResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Masked buyer name, e.g. "Bernard W." - never the full legal name' })
  authorDisplayName!: string;

  @ApiProperty({ description: 'Always true - reviews can only be written after a completed purchase' })
  verifiedPurchase!: boolean;

  @ApiProperty({ minimum: 1, maximum: 5 })
  rating!: number;

  @ApiProperty({ required: false, nullable: true })
  title!: string | null;

  @ApiProperty()
  body!: string;

  @ApiProperty({ required: false, nullable: true, description: 'Null for a vendor-only review' })
  productId!: string | null;

  @ApiProperty({ required: false, nullable: true })
  productName!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({ required: false, nullable: true, description: 'Set when the author has edited the review' })
  editedAt!: Date | null;
}
