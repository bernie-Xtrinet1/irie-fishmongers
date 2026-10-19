import { Module } from '@nestjs/common';

import { PrismaModule } from '../../database/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { SeafoodLotsModule } from '../food-safety/seafood-lots.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ProductsModule } from '../products/products.module';
import { VendorTiersModule } from '../vendor-tiers/vendor-tiers.module';
import { VendorsModule } from '../vendors/vendors.module';
import { AdminDailyListingsController } from './controllers/admin-daily-listings.controller';
import { DailyListingsController } from './controllers/daily-listings.controller';
import { VendorDailyListingsController } from './controllers/vendor-daily-listings.controller';
import { DailyListingsRepository } from './repositories/daily-listings.repository';
import { DailyListingsService } from './services/daily-listings.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    VendorsModule,
    VendorTiersModule,
    CatalogueModule,
    ProductsModule,
    SeafoodLotsModule,
    InventoryModule,
  ],
  controllers: [
    DailyListingsController,
    VendorDailyListingsController,
    AdminDailyListingsController,
  ],
  providers: [
    DailyListingsRepository,
    DailyListingsService,
  ],
  exports: [
    DailyListingsService,
    DailyListingsRepository,
  ],
})
export class DailyListingsModule {}
