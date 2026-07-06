import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { VendorsModule } from '../vendors/vendors.module';
import { CategoriesController } from './controllers/categories.controller';
import { ProductsController } from './controllers/products.controller';
import { CategoriesRepository } from './repositories/categories.repository';
import { ProductsRepository } from './repositories/products.repository';
import { CategoriesService } from './services/categories.service';
import { ProductsService } from './services/products.service';

@Module({
  imports: [AuthModule, VendorsModule],
  controllers: [ProductsController, CategoriesController],
  providers: [ProductsService, CategoriesService, ProductsRepository, CategoriesRepository],
})
export class ProductsModule {}
