import { Type } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { RoleName } from '@prisma/client';

import { AnalyticsController } from '../../modules/analytics/controllers/analytics.controller';
import { AdminSeafoodCatalogueController } from '../../modules/catalogue/controllers/admin-seafood-catalogue.controller';
import { CatchesController } from '../../modules/catches/controllers/catches.controller';
import { FishermenController } from '../../modules/catches/controllers/fishermen.controller';
import { LandingSitesController } from '../../modules/catches/controllers/landing-sites.controller';
import { SpeciesController } from '../../modules/catches/controllers/species.controller';
import { VesselsController } from '../../modules/catches/controllers/vessels.controller';
import { RolloutAdminController } from '../../modules/checkout-rollout-admin/controllers/rollout-admin.controller';
import { AdminDailyListingsController } from '../../modules/daily-listings/controllers/admin-daily-listings.controller';
import { DeliveryExceptionsController } from '../../modules/delivery/controllers/delivery-exceptions.controller';
import { DeliveryRunsController } from '../../modules/delivery/controllers/delivery-runs.controller';
import { DeliveryZonesController } from '../../modules/delivery/controllers/delivery-zones.controller';
import { DriversController } from '../../modules/delivery/controllers/drivers.controller';
import { RouteOptimizationController } from '../../modules/delivery/controllers/route-optimization.controller';
import { SLABreachesController } from '../../modules/delivery/controllers/sla-breaches.controller';
import { DispatchController } from '../../modules/dispatch/controllers/dispatch.controller';
import { DriverSettlementsController } from '../../modules/driver-settlements/controllers/driver-settlements.controller';
import { FleetAssetsController } from '../../modules/fleet/controllers/fleet-assets.controller';
import { FleetMaintenanceController } from '../../modules/fleet/controllers/fleet-maintenance.controller';
import { FleetTripsController } from '../../modules/fleet/controllers/fleet-trips.controller';
import { ComplianceAuditLogController } from '../../modules/food-safety/controllers/compliance-audit-log.controller';
import { ComplianceDashboardController } from '../../modules/food-safety/controllers/compliance-dashboard.controller';
import { ComplianceDocumentsController } from '../../modules/food-safety/controllers/compliance-documents.controller';
import { ComplianceReportsController } from '../../modules/food-safety/controllers/compliance-reports.controller';
import { CustodyEventsController } from '../../modules/food-safety/controllers/custody-events.controller';
import { EmergencyResponsesController } from '../../modules/food-safety/controllers/emergency-responses.controller';
import { FoodSafetyIncidentsController } from '../../modules/food-safety/controllers/food-safety-incidents.controller';
import { QualityInspectionsController } from '../../modules/food-safety/controllers/quality-inspections.controller';
import { RecallsController } from '../../modules/food-safety/controllers/recalls.controller';
import { RegulatoryAuthoritiesController } from '../../modules/food-safety/controllers/regulatory-authorities.controller';
import { RegulatoryCertificationsController } from '../../modules/food-safety/controllers/regulatory-certifications.controller';
import { SeafoodLotsController } from '../../modules/food-safety/controllers/seafood-lots.controller';
import { TemperatureDevicesController } from '../../modules/food-safety/controllers/temperature-devices.controller';
import { TemperatureMonitoringController } from '../../modules/food-safety/controllers/temperature-monitoring.controller';
import { TemperatureThresholdsController } from '../../modules/food-safety/controllers/temperature-thresholds.controller';
import { WasteDisposalRecordsController } from '../../modules/food-safety/controllers/waste-disposal-records.controller';
import { InventoryController } from '../../modules/inventory/controllers/inventory.controller';
import { MarketplaceConfigController } from '../../modules/marketplace/controllers/marketplace-config.controller';
import { PaymentsController } from '../../modules/payments/controllers/payments.controller';
import { RefundReconciliationController } from '../../modules/payments/controllers/refund-reconciliation.controller';
import { CategoriesController } from '../../modules/products/controllers/categories.controller';
import { ReviewModerationController } from '../../modules/reviews/controllers/review-moderation.controller';
import { VendorSettlementsController } from '../../modules/vendor-settlements/controllers/vendor-settlements.controller';
import { PrimaryAdminVendorSettlementGuard } from '../../modules/vendor-settlements/guards/primary-admin-vendor-settlement.guard';
import { ComplianceScoreController } from '../../modules/vendor-tiers/controllers/compliance-score.controller';
import { TierUpgradeRequestsController } from '../../modules/vendor-tiers/controllers/tier-upgrade-requests.controller';
import { VendorDocumentsController } from '../../modules/vendor-tiers/controllers/vendor-documents.controller';
import { VendorPermissionsController } from '../../modules/vendor-tiers/controllers/vendor-permissions.controller';
import { VendorTiersController } from '../../modules/vendor-tiers/controllers/vendor-tiers.controller';
import { VendorsController } from '../../modules/vendors/controllers/vendors.controller';
import { TelemetryIngestionController } from '../../modules/telemetry/controllers/telemetry-ingestion.controller';
import { TelemetryOperationsController } from '../../modules/telemetry/controllers/telemetry-operations.controller';
import { TelemetryGatewayAuthGuard } from '../../modules/telemetry/guards/telemetry-gateway-auth.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { HealthController } from '../health/health.controller';

const reflector = new Reflector();

function effectiveRolesFor(ctrl: Type<unknown>, methodName: string): RoleName[] | undefined {
  const proto = ctrl.prototype as Record<string, (...args: unknown[]) => unknown>;
  const method = proto[methodName];
  if (!method) {
    throw new Error(`Missing route handler ${methodName} on ${ctrl.name}`);
  }
  return reflector.getAllAndOverride<RoleName[] | undefined>(ROLES_KEY, [method, ctrl]);
}

function routeMethodNames(ctrl: Type<unknown>): string[] {
  const proto = ctrl.prototype as Record<string, (...args: unknown[]) => unknown>;
  return Object.getOwnPropertyNames(proto).filter((name) => {
    if (name === 'constructor') return false;
    return reflector.get(PATH_METADATA, proto[name]!) !== undefined;
  });
}

describe('Operations Staff & Primary Administrator RBAC Matrix', () => {
  it('excludes OPERATIONS_STAFF from every financial, vendor-settlement, driver-settlement, payment, refund, and sales-analytics handler', () => {
    const strictAdminOnlyControllers = [
      VendorSettlementsController,
      DriverSettlementsController,
      PaymentsController,
      RefundReconciliationController,
      RolloutAdminController,
      MarketplaceConfigController,
    ];

    for (const ctrl of strictAdminOnlyControllers) {
      for (const method of routeMethodNames(ctrl)) {
        const roles = effectiveRolesFor(ctrl, method) ?? [];
        expect(roles).not.toContain(RoleName.OPERATIONS_STAFF);
      }
    }

    expect(effectiveRolesFor(AnalyticsController, 'getSalesAnalytics')).toEqual([
      RoleName.ADMINISTRATOR,
    ]);
  });

  it('keeps catalogue mutations, override approvals, fishermen/vessel status, and reference writes strictly ADMINISTRATOR-only', () => {
    const catalogueAdminOnly = [
      'create',
      'update',
      'submitForReview',
      'approve',
      'reject',
      'retire',
      'requestOverride',
      'approveOverride',
    ];
    for (const method of catalogueAdminOnly) {
      expect(effectiveRolesFor(AdminSeafoodCatalogueController, method)).toEqual([
        RoleName.ADMINISTRATOR,
      ]);
    }

    expect(effectiveRolesFor(FishermenController, 'updateStatus')).toEqual([RoleName.ADMINISTRATOR]);
    expect(effectiveRolesFor(VesselsController, 'updateStatus')).toEqual([RoleName.ADMINISTRATOR]);
    expect(effectiveRolesFor(LandingSitesController, 'create')).toEqual([RoleName.ADMINISTRATOR]);
    expect(effectiveRolesFor(LandingSitesController, 'update')).toEqual([RoleName.ADMINISTRATOR]);
    expect(effectiveRolesFor(SpeciesController, 'create')).toEqual([RoleName.ADMINISTRATOR]);
    expect(effectiveRolesFor(SpeciesController, 'update')).toEqual([RoleName.ADMINISTRATOR]);
    expect(effectiveRolesFor(CategoriesController, 'create')).toEqual([RoleName.ADMINISTRATOR]);
  });

  it('enforces PrimaryAdminVendorSettlementGuard exclusively on vendor settlement payment transitions and payment-reference updates', () => {
    type MethodFn = (...args: unknown[]) => unknown;
    const updateStatusMethod = Reflect.get(VendorSettlementsController.prototype, 'updateStatus') as MethodFn;
    const updateRefMethod = Reflect.get(
      VendorSettlementsController.prototype,
      'updatePaymentReference',
    ) as MethodFn;
    const updateStatusGuards = reflector.get<unknown[]>(GUARDS_METADATA, updateStatusMethod);
    const updateRefGuards = reflector.get<unknown[]>(GUARDS_METADATA, updateRefMethod);

    expect(updateStatusGuards).toContain(PrimaryAdminVendorSettlementGuard);
    expect(updateRefGuards).toContain(PrimaryAdminVendorSettlementGuard);

    for (const method of ['generate', 'list', 'createAdjustment', 'getCommissionRate', 'createCommissionRate', 'getAuditLogs']) {
      const targetMethod = Reflect.get(VendorSettlementsController.prototype, method) as MethodFn;
      expect(targetMethod).toBeDefined();
      const guards = reflector.get<unknown[]>(GUARDS_METADATA, targetMethod) ?? [];
      expect(guards).not.toContain(PrimaryAdminVendorSettlementGuard);
    }
  });

  it('grants OPERATIONS_STAFF access to all allowlisted operational modules, read-only catalogue/catch GETs, and operational analytics', () => {
    const classLevelAllowlist = [
      AdminDailyListingsController,
      TierUpgradeRequestsController,
      ComplianceScoreController,
      DeliveryRunsController,
      DispatchController,
      RouteOptimizationController,
      SLABreachesController,
      FleetAssetsController,
      FleetMaintenanceController,
      FleetTripsController,
      ComplianceAuditLogController,
      ComplianceDashboardController,
      ComplianceDocumentsController,
      ComplianceReportsController,
      CustodyEventsController,
      EmergencyResponsesController,
      RecallsController,
      RegulatoryAuthoritiesController,
      RegulatoryCertificationsController,
      TemperatureThresholdsController,
      InventoryController,
      ReviewModerationController,
    ];

    for (const ctrl of classLevelAllowlist) {
      for (const method of routeMethodNames(ctrl)) {
        const roles = effectiveRolesFor(ctrl, method) ?? [];
        expect(roles).toContain(RoleName.OPERATIONS_STAFF);
        expect(roles).toContain(RoleName.ADMINISTRATOR);
      }
    }

    const methodChecks: Array<[Type<unknown>, string]> = [
      [HealthController, 'checkStatus'],
      [AnalyticsController, 'getDashboardSummary'],
      [AnalyticsController, 'getVendorDashboard'],
      [AnalyticsController, 'getDeliveryAnalytics'],
      [AnalyticsController, 'getInventoryAnalytics'],
      [AdminSeafoodCatalogueController, 'listAll'],
      [AdminSeafoodCatalogueController, 'getById'],
      [CatchesController, 'list'],
      [CatchesController, 'getById'],
      [FishermenController, 'list'],
      [VesselsController, 'list'],
      [VendorsController, 'list'],
      [VendorsController, 'updateStatus'],
      [VendorDocumentsController, 'listForVendor'],
      [VendorDocumentsController, 'review'],
      [VendorPermissionsController, 'getForVendor'],
      [VendorTiersController, 'downgrade'],
      [VendorTiersController, 'listDowngradeEvents'],
      [DriversController, 'list'],
      [DriversController, 'updateStatus'],
      [DriversController, 'getPerformanceMetrics'],
      [DriversController, 'createColdChainCertification'],
      [DriversController, 'listColdChainCertifications'],
      [DriversController, 'revokeColdChainCertification'],
      [DeliveryZonesController, 'create'],
      [DeliveryZonesController, 'update'],
      [DeliveryExceptionsController, 'list'],
      [DeliveryExceptionsController, 'resolve'],
      [FoodSafetyIncidentsController, 'report'],
      [FoodSafetyIncidentsController, 'getForLot'],
      [FoodSafetyIncidentsController, 'list'],
      [FoodSafetyIncidentsController, 'updateStatus'],
      [QualityInspectionsController, 'inspect'],
      [QualityInspectionsController, 'getForLot'],
      [SeafoodLotsController, 'list'],
      [SeafoodLotsController, 'getQrCode'],
      [SeafoodLotsController, 'getById'],
      [SeafoodLotsController, 'updateStatus'],
      [TemperatureDevicesController, 'list'],
      [TemperatureDevicesController, 'calibrate'],
      [TemperatureMonitoringController, 'getReadingsForLot'],
      [TemperatureMonitoringController, 'listAlerts'],
      [TemperatureMonitoringController, 'resolveAlert'],
      [WasteDisposalRecordsController, 'create'],
      [WasteDisposalRecordsController, 'list'],
      [TelemetryOperationsController, 'getActiveRunsLiveOverview'],
      [TelemetryOperationsController, 'getTelemetryDevicesOverview'],
      [TelemetryOperationsController, 'getSensorHistory'],
      [TelemetryOperationsController, 'importEyeAppCsv'],
      [TelemetryOperationsController, 'getDeliveryTelemetryDetail'],
      [TelemetryOperationsController, 'recordPickup'],
      [TelemetryOperationsController, 'recordHandover'],
      [TelemetryOperationsController, 'recordTransfer'],
    ];

    for (const [ctrl, method] of methodChecks) {
      const roles = effectiveRolesFor(ctrl, method) ?? [];
      expect(roles).toContain(RoleName.OPERATIONS_STAFF);
      expect(roles).toContain(RoleName.ADMINISTRATOR);
    }
  });

  it('keeps telemetry hardware provisioning and credential management strictly ADMINISTRATOR-only and device ingestion isolated from User JWTs', () => {
    for (const adminOnlyMethod of [
      'createCompartment',
      'registerTracker',
      'registerSensor',
      'issueCredential',
      'listCredentials',
      'rotateCredential',
      'revokeCredential',
    ]) {
      expect(effectiveRolesFor(TelemetryOperationsController, adminOnlyMethod)).toEqual([
        RoleName.ADMINISTRATOR,
      ]);
    }

    for (const driverAllowedMethod of [
      'getDeliveryTelemetryDetail',
      'recordPickup',
      'recordHandover',
      'recordTransfer',
    ]) {
      expect(effectiveRolesFor(TelemetryOperationsController, driverAllowedMethod)).toContain(
        RoleName.DRIVER,
      );
    }

    const ingestionGuards =
      reflector.get<unknown[]>(GUARDS_METADATA, TelemetryIngestionController) ?? [];
    expect(ingestionGuards).toContain(TelemetryGatewayAuthGuard);
    for (const method of routeMethodNames(TelemetryIngestionController)) {
      expect(effectiveRolesFor(TelemetryIngestionController, method)).toBeUndefined();
    }
  });
});
