import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CartModule } from '../cart/cart.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentsModule } from '../payments/payments.module';
import { ProductsModule } from '../products/products.module';
import { VendorTiersModule } from '../vendor-tiers/vendor-tiers.module';
import { VendorsModule } from '../vendors/vendors.module';
import { OrdersController } from './controllers/orders.controller';
import { VendorOrdersController } from './controllers/vendor-orders.controller';
import { OrdersRepository } from './repositories/orders.repository';
import { VendorOrdersRepository } from './repositories/vendor-orders.repository';
import { OrdersService } from './services/orders.service';
import { VendorOrdersService } from './services/vendor-orders.service';

@Module({
  imports: [
    AuthModule,
    CartModule,
    ProductsModule,
    VendorsModule,
    PaymentsModule,
    VendorTiersModule,
    InventoryModule,
  ],
  controllers: [OrdersController, VendorOrdersController],
  providers: [
    OrdersService,
    VendorOrdersService,
    OrdersRepository,
    VendorOrdersRepository,
  ],
  exports: [OrdersRepository, VendorOrdersRepository],
})
export class OrdersModule {}
