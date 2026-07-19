import { Module } from '@nestjs/common';

import { AuthModule } from '../../modules/auth/auth.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

// Imports AuthModule for JwtAuthGuard/RolesGuard, needed by the admin-only
// GET /health/status route. AuthModule does not import HealthModule back,
// so this is safe.
@Module({
  imports: [AuthModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
