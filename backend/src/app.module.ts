import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';

import { AppThrottlerGuard } from './common/guards/app-throttler.guard';
import { RedisModule } from './common/redis/redis.module';
import { HealthModule } from './common/health/health.module';
import { ResponseInterceptor } from './common/http/response.interceptor';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './database/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { CartModule } from './modules/cart/cart.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { DriverSettlementsModule } from './modules/driver-settlements/driver-settlements.module';
import { FleetModule } from './modules/fleet/fleet.module';
import { FoodSafetyModule } from './modules/food-safety/food-safety.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { MarketplaceModule } from './modules/marketplace/marketplace.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ProductsModule } from './modules/products/products.module';
import { VendorSettlementsModule } from './modules/vendor-settlements/vendor-settlements.module';
import { VendorTiersModule } from './modules/vendor-tiers/vendor-tiers.module';
import { VendorsModule } from './modules/vendors/vendors.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 100,
      },
    ]),
    EventEmitterModule.forRoot(),
    PrismaModule,
    RedisModule,
    HealthModule,
    AuthModule,
    VendorsModule,
    VendorTiersModule,
    InventoryModule,
    ProductsModule,
    CartModule,
    OrdersModule,
    PaymentsModule,
    DeliveryModule,
    DriverSettlementsModule,
    VendorSettlementsModule,
    FoodSafetyModule,
    FleetModule,
    NotificationsModule,
    MarketplaceModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule {}
