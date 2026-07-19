import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { DriverSettlementEngine } from '../driver-settlements/services/driver-settlement-engine.service';
import { DeliveriesController } from './controllers/deliveries.controller';
import { DeliveryExceptionsController } from './controllers/delivery-exceptions.controller';
import { DeliveryRunsController } from './controllers/delivery-runs.controller';
import { DeliveryZonesController } from './controllers/delivery-zones.controller';
import { DriversController } from './controllers/drivers.controller';
import { RouteOptimizationController } from './controllers/route-optimization.controller';
import { SLABreachesController } from './controllers/sla-breaches.controller';
import { DeliveriesRepository } from './repositories/deliveries.repository';
import { DeliveryExceptionsRepository } from './repositories/delivery-exceptions.repository';
import { DeliveryRunsRepository } from './repositories/delivery-runs.repository';
import { DeliveryZonesRepository } from './repositories/delivery-zones.repository';
import { DriverColdChainCertificationsRepository } from './repositories/driver-cold-chain-certifications.repository';
import { DriverLocationsRepository } from './repositories/driver-locations.repository';
import { DriversRepository } from './repositories/drivers.repository';
import { RouteHistoryRepository } from './repositories/route-history.repository';
import { RouteOptimizationRunsRepository } from './repositories/route-optimization-runs.repository';
import { SLABreachesRepository } from './repositories/sla-breaches.repository';
import { DeliveriesService } from './services/deliveries.service';
import { DeliveryExceptionsService } from './services/delivery-exceptions.service';
import { DeliveryRunsService } from './services/delivery-runs.service';
import { DeliveryZonesService } from './services/delivery-zones.service';
import { DriverColdChainCertificationsService } from './services/driver-cold-chain-certifications.service';
import { DriversService } from './services/drivers.service';
import { ParishClusteringRouteOptimizationStrategy } from './services/parish-clustering-route-optimization.strategy';
import { ROUTE_OPTIMIZATION_STRATEGY } from './services/route-optimization-strategy.interface';
import { RouteOptimizationService } from './services/route-optimization.service';
import { SLABreachDetectionService } from './services/sla-breach-detection.service';
import { SLABreachesService } from './services/sla-breaches.service';
import { ZoneResolutionService } from './services/zone-resolution.service';

@Module({
  imports: [AuthModule, OrdersModule],
  controllers: [
    DriversController,
    DeliveriesController,
    DeliveryZonesController,
    DeliveryExceptionsController,
    RouteOptimizationController,
    DeliveryRunsController,
    SLABreachesController,
  ],
  providers: [
    DriversService,
    DeliveriesService,
    DeliveryZonesService,
    DeliveryExceptionsService,
    RouteOptimizationService,
    DeliveryRunsService,
    SLABreachesService,
    SLABreachDetectionService,
    DriverColdChainCertificationsService,
    ZoneResolutionService,
    DriverSettlementEngine,
    { provide: ROUTE_OPTIMIZATION_STRATEGY, useClass: ParishClusteringRouteOptimizationStrategy },
    DriversRepository,
    DriverLocationsRepository,
    DeliveriesRepository,
    DeliveryZonesRepository,
    DeliveryExceptionsRepository,
    RouteHistoryRepository,
    RouteOptimizationRunsRepository,
    DeliveryRunsRepository,
    SLABreachesRepository,
    DriverColdChainCertificationsRepository,
  ],
  exports: [
    DriversRepository,
    DriverLocationsRepository,
    DeliveryZonesRepository,
    DeliveryRunsRepository,
    DeliveryRunsService,
    DeliveriesRepository,
    SLABreachesService,
  ],
})
export class DeliveryModule {}
