import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { SeafoodLotsModule } from '../food-safety/seafood-lots.module';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { VendorTiersModule } from '../vendor-tiers/vendor-tiers.module';
import { VendorsModule } from '../vendors/vendors.module';
import { CategoriesController } from './controllers/categories.controller';
import { ProductsController } from './controllers/products.controller';
import { CategoriesRepository } from './repositories/categories.repository';
import { ProductsRepository } from './repositories/products.repository';
import { CategoriesService } from './services/categories.service';
import { ProductsService } from './services/products.service';

@Module({
  imports: [AuthModule, VendorsModule, SeafoodLotsModule, VendorTiersModule, MarketplaceModule],
  controllers: [ProductsController, CategoriesController],
  providers: [ProductsService, CategoriesService, ProductsRepository, CategoriesRepository],
  exports: [ProductsRepository, CategoriesRepository],
})
export class ProductsModule {}
