import { ApiProperty } from '@nestjs/swagger';

import { AdminReviewEntity } from './admin-review.entity';
import { ReviewAuditLogEntity } from './review-audit-log.entity';

// A single review plus its full moderation audit trail, for the admin
// detail dialog (Phase 13B).
export class AdminReviewDetailEntity extends AdminReviewEntity {
  @ApiProperty({ type: ReviewAuditLogEntity, isArray: true })
  auditLogs!: ReviewAuditLogEntity[];
}
