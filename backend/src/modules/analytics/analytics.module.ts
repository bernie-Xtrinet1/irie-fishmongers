import { Module } from '@nestjs/common';

import { HealthModule } from '../../common/health/health.module';
import { AuthModule } from '../auth/auth.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { FleetModule } from '../fleet/fleet.module';
import { ComplianceOpsModule } from '../food-safety/compliance-ops.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { ProductsModule } from '../products/products.module';
import { VendorSettlementsModule } from '../vendor-settlements/vendor-settlements.module';
import { VendorsModule } from '../vendors/vendors.module';
import { AnalyticsController } from './controllers/analytics.controller';
import { AnalyticsService } from './services/analytics.service';

// Deliberately has no repository of its own - composes existing
// repositories/services from the modules below rather than duplicating
// their logic. Sits above all of them; none import AnalyticsModule back.
@Module({
  imports: [
    AuthModule,
    HealthModule,
    PaymentsModule,
    VendorSettlementsModule,
    OrdersModule,
    VendorsModule,
    DeliveryModule,
    FleetModule,
    ComplianceOpsModule,
    ProductsModule,
    InventoryModule,
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
