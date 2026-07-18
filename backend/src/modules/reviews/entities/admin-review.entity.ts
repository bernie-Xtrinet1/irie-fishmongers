import { ApiProperty } from '@nestjs/swagger';
import { ReviewModerationStatus } from '@prisma/client';

// Full moderator-facing view of a review (Phase 13B). Unlike the public
// ReviewResponseEntity this deliberately exposes moderation internals -
// authorId, moderation status, removal metadata, and the computed
// deliveryWasRejected flag - because it is only ever returned to
// administrators behind the roles guard, never to customers.
export class AdminReviewEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty({ nullable: true })
  authorId!: string | null;

  @ApiProperty({ description: 'Masked display name (First L.)' })
  authorDisplayName!: string;

  @ApiProperty()
  vendorId!: string;

  @ApiProperty({ nullable: true })
  productId!: string | null;

  @ApiProperty({ nullable: true })
  productName!: string | null;

  @ApiProperty()
  vendorOrderId!: string;

  @ApiProperty()
  rating!: number;

  @ApiProperty({ nullable: true })
  title!: string | null;

  @ApiProperty()
  body!: string;

  @ApiProperty({ enum: ReviewModerationStatus })
  moderationStatus!: ReviewModerationStatus;

  @ApiProperty({ nullable: true })
  removedById!: string | null;

  @ApiProperty({ nullable: true })
  removalReason!: string | null;

  @ApiProperty({ nullable: true })
  removedAt!: Date | null;

  @ApiProperty({
    description: 'Whether the customer rejected the delivery for this order - moderator fraud/quality context',
  })
  deliveryWasRejected!: boolean;

  @ApiProperty({ nullable: true })
  editedAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
