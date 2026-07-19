import { ApiProperty } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';

// A single admin moderation action against a review, surfaced in the
// detail view's audit trail (Phase 13B). Admin-only.
export class ReviewAuditLogEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  reviewId!: string;

  @ApiProperty({ description: 'Administrator who performed the action' })
  actorId!: string;

  @ApiProperty({ example: 'REMOVED_BY_ADMIN' })
  action!: string;

  @ApiProperty({ required: false, nullable: true, type: Object })
  beforeValue!: Prisma.JsonValue;

  @ApiProperty({ required: false, nullable: true, type: Object })
  afterValue!: Prisma.JsonValue;

  @ApiProperty({ required: false, nullable: true })
  reason!: string | null;

  @ApiProperty()
  createdAt!: Date;
}
