import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ReviewModerationController } from './controllers/review-moderation.controller';
import { ReviewsController } from './controllers/reviews.controller';
import { ReviewAuditLogsRepository } from './repositories/review-audit-logs.repository';
import { ReviewsRepository } from './repositories/reviews.repository';
import { ReviewEligibilityService } from './services/review-eligibility.service';
import { ReviewModerationService } from './services/review-moderation.service';
import { ReviewsQueryService } from './services/reviews-query.service';
import { ReviewsService } from './services/reviews.service';

// Imports only AuthModule (for the JWT/roles guards). Order/delivery data
// needed for eligibility is read through the global PrismaService inside
// ReviewsRepository rather than by importing OrdersModule/DeliveryModule -
// that would create a ProductsModule -> ReviewsModule -> OrdersModule ->
// ProductsModule cycle once 13E wires product-detail ratings. Only the
// narrow ReviewsQueryService is exported for other modules to depend on.
@Module({
  imports: [AuthModule],
  controllers: [ReviewsController, ReviewModerationController],
  providers: [
    ReviewsRepository,
    ReviewAuditLogsRepository,
    ReviewEligibilityService,
    ReviewsService,
    ReviewModerationService,
    ReviewsQueryService,
  ],
  exports: [ReviewsQueryService],
})
export class ReviewsModule {}
