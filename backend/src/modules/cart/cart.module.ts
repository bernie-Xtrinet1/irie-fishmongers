import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ProductsModule } from '../products/products.module';
import { VendorsModule } from '../vendors/vendors.module';
import { CartController } from './controllers/cart.controller';
import { CartRepository } from './repositories/cart.repository';
import { CartService } from './services/cart.service';

@Module({
  imports: [AuthModule, ProductsModule, VendorsModule, InventoryModule],
  controllers: [CartController],
  providers: [CartService, CartRepository],
  exports: [CartRepository],
})
export class CartModule {}
