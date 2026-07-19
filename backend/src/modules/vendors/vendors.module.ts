import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { VendorsController } from './controllers/vendors.controller';
import { VendorsRepository } from './repositories/vendors.repository';
import { VendorPickupQueueService } from './services/vendor-pickup-queue.service';
import { VendorsService } from './services/vendors.service';

@Module({
  imports: [AuthModule],
  controllers: [VendorsController],
  providers: [VendorsService, VendorPickupQueueService, VendorsRepository],
  exports: [VendorsRepository],
})
export class VendorsModule {}
