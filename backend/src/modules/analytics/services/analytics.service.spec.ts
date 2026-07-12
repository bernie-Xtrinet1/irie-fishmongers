import { Prisma } from '@prisma/client';

import { HealthService } from '../../../common/health/health.service';
import { DeliveriesRepository } from '../../delivery/repositories/deliveries.repository';
import { DriversRepository } from '../../delivery/repositories/drivers.repository';
import { SLABreachesService } from '../../delivery/services/sla-breaches.service';
import { FleetAssetsService } from '../../fleet/services/fleet-assets.service';
import { ComplianceDashboardService } from '../../food-safety/services/compliance-dashboard.service';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { PaymentsRepository } from '../../payments/repositories/payments.repository';
import { VendorSettlementsRepository } from '../../vendor-settlements/repositories/vendor-settlements.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsService', () => {
  let paymentsRepository: jest.Mocked<Pick<PaymentsRepository, 'sumByStatus' | 'sumByProvider' | 'countByStatus'>>;
  let vendorSettlementsRepository: jest.Mocked<
    Pick<VendorSettlementsRepository, 'sumPlatformFeeByStatus' | 'getTopVendorsByRevenue'>
  >;
  let ordersRepository: jest.Mocked<Pick<OrdersRepository, 'count'>>;
  let vendorOrdersRepository: jest.Mocked<
    Pick<VendorOrdersRepository, 'countByStatus' | 'getTopProductsByRevenue' | 'getSalesByCategory'>
  >;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'getComplianceSummary' | 'countByTier'>>;
  let driversRepository: jest.Mocked<Pick<DriversRepository, 'countByStatus'>>;
  let deliveriesRepository: jest.Mocked<Pick<DeliveriesRepository, 'countByCustomerAcceptanceStatus'>>;
  let slaBreachesService: jest.Mocked<Pick<SLABreachesService, 'getZoneSummary'>>;
  let fleetAssetsService: jest.Mocked<Pick<FleetAssetsService, 'getZoneSummary'>>;
  let complianceDashboardService: jest.Mocked<Pick<ComplianceDashboardService, 'getDashboard'>>;
  let healthService: jest.Mocked<Pick<HealthService, 'checkStatus'>>;
  let service: AnalyticsService;

  const vendorOrdersByStatus = {
    PENDING: 1,
    ACCEPTED: 2,
    PREPARING: 0,
    READY_FOR_PICKUP: 0,
    ASSIGNED_TO_DRIVER: 0,
    IN_TRANSIT: 0,
    DELIVERED: 5,
    DELIVERY_FAILED: 0,
    REJECTED: 0,
    CANCELLED: 0,
  };

  const vendorsByStatus = { PENDING: 2, APPROVED: 10, SUSPENDED: 1, REJECTED: 0 };
  const vendorsByTier = { COMMUNITY_FISHER: 5, VERIFIED_VENDOR: 4, COMMERCIAL_SUPPLIER: 3, ENTERPRISE_SUPPLIER: 1 };
  const driversByStatus = { PENDING: 1, APPROVED: 8, SUSPENDED: 0, REJECTED: 0 };
  const activeAlertsBySeverity = { WARNING: 3, CRITICAL: 1, EMERGENCY: 0 };

  const topProductsByRevenue = [
    { productId: 'product-1', productName: 'Snapper', quantitySold: 20, revenue: '10000' },
  ];
  const salesByCategory = [{ categoryId: 'category-1', categoryName: 'Fish', quantitySold: 20, revenue: '10000' }];

  beforeEach(() => {
    paymentsRepository = {
      sumByStatus: jest.fn().mockResolvedValue(new Prisma.Decimal(5000)),
      sumByProvider: jest
        .fn()
        .mockResolvedValue({ WIPAY: new Prisma.Decimal(3000), CASH_ON_DELIVERY: new Prisma.Decimal(2000) }),
      countByStatus: jest.fn().mockResolvedValue(4),
    };
    vendorSettlementsRepository = {
      sumPlatformFeeByStatus: jest.fn().mockResolvedValue(new Prisma.Decimal(500)),
      getTopVendorsByRevenue: jest
        .fn()
        .mockResolvedValue([{ vendorId: 'vendor-1', businessName: "Vera's Catch", grossAmount: '10000' }]),
    };
    ordersRepository = { count: jest.fn().mockResolvedValue(4) };
    vendorOrdersRepository = {
      countByStatus: jest.fn().mockResolvedValue(vendorOrdersByStatus),
      getTopProductsByRevenue: jest.fn().mockResolvedValue(topProductsByRevenue),
      getSalesByCategory: jest.fn().mockResolvedValue(salesByCategory),
    };
    vendorsRepository = {
      getComplianceSummary: jest.fn().mockResolvedValue({ countByStatus: vendorsByStatus, averageComplianceScore: 90 }),
      countByTier: jest.fn().mockResolvedValue(vendorsByTier),
    };
    driversRepository = { countByStatus: jest.fn().mockResolvedValue(driversByStatus) };
    deliveriesRepository = {
      countByCustomerAcceptanceStatus: jest
        .fn()
        .mockResolvedValue({ PENDING: 1, ACCEPTED: 8, REJECTED: 1 }),
    };
    slaBreachesService = {
      getZoneSummary: jest
        .fn()
        .mockResolvedValue([{ zoneId: 'zone-1', totalBreaches: 3, unresolvedBreaches: 1 }]),
    };
    fleetAssetsService = {
      getZoneSummary: jest.fn().mockResolvedValue([{ zoneId: 'zone-1', status: 'AVAILABLE', count: 4 }]),
    };
    complianceDashboardService = {
      getDashboard: jest.fn().mockResolvedValue({
        activeAlertsBySeverity,
        failedInspectionsLast30Days: 0,
        lotsPendingReview: 0,
        activeRecalls: 2,
        vendorCompliance: { countByStatus: vendorsByStatus, averageComplianceScore: 90 },
        fishermenByStatus: { PENDING: 0, APPROVED: 0, SUSPENDED: 0, REJECTED: 0 },
        generatedAt: new Date(),
      }),
    };
    healthService = { checkStatus: jest.fn().mockResolvedValue({ postgres: 'up', redis: 'up' }) };

    service = new AnalyticsService(
      paymentsRepository as unknown as PaymentsRepository,
      vendorSettlementsRepository as unknown as VendorSettlementsRepository,
      ordersRepository as unknown as OrdersRepository,
      vendorOrdersRepository as unknown as VendorOrdersRepository,
      vendorsRepository as unknown as VendorsRepository,
      driversRepository as unknown as DriversRepository,
      deliveriesRepository as unknown as DeliveriesRepository,
      slaBreachesService as unknown as SLABreachesService,
      fleetAssetsService as unknown as FleetAssetsService,
      complianceDashboardService as unknown as ComplianceDashboardService,
      healthService as unknown as HealthService,
    );
  });

  describe('getDashboardSummary', () => {
    it('composes every KPI group into one summary', async () => {
      const result = await service.getDashboardSummary();

      expect(result).toEqual({
        financials: { grossPaidAmount: '5000', platformCommission: '500', currency: 'JMD' },
        orders: { customerOrdersTotal: 4, vendorOrdersByStatus },
        vendors: { byStatus: vendorsByStatus },
        drivers: { byStatus: driversByStatus },
        compliance: { activeAlertsBySeverity, activeRecalls: 2 },
        systemHealth: { postgres: 'up', redis: 'up' },
      });
    });

    it('passes the from/to range to the financial and order-count queries only', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-01-31');

      await service.getDashboardSummary({ from, to });

      expect(paymentsRepository.sumByStatus).toHaveBeenCalledWith('PAID', { from, to });
      expect(vendorSettlementsRepository.sumPlatformFeeByStatus).toHaveBeenCalledWith('PAID', { from, to });
      expect(ordersRepository.count).toHaveBeenCalledWith({ from, to });
      expect(vendorOrdersRepository.countByStatus).toHaveBeenCalledWith({ from, to });
      // Vendor/driver/compliance counts are point-in-time snapshots - no range argument.
      expect(vendorsRepository.getComplianceSummary).toHaveBeenCalledWith();
      expect(driversRepository.countByStatus).toHaveBeenCalledWith();
      expect(complianceDashboardService.getDashboard).toHaveBeenCalledWith();
    });

    it('does not let a Redis-down systemHealth result reject the overall summary', async () => {
      healthService.checkStatus.mockResolvedValue({ postgres: 'up', redis: 'down' });

      const result = await service.getDashboardSummary();

      expect(result.systemHealth).toEqual({ postgres: 'up', redis: 'down' });
      expect(result.financials.grossPaidAmount).toBe('5000');
    });
  });

  describe('getVendorDashboard', () => {
    it('composes vendor status/tier/compliance/top-vendors into one summary', async () => {
      const result = await service.getVendorDashboard();

      expect(result).toEqual({
        byStatus: vendorsByStatus,
        byTier: vendorsByTier,
        averageComplianceScore: 90,
        topVendorsByRevenue: [{ vendorId: 'vendor-1', businessName: "Vera's Catch", grossAmount: '10000' }],
      });
    });

    it('passes the from/to range to top-vendors-by-revenue only', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-01-31');

      await service.getVendorDashboard({ from, to });

      expect(vendorSettlementsRepository.getTopVendorsByRevenue).toHaveBeenCalledWith(10, { from, to });
      // Vendor status/tier/compliance counts are point-in-time snapshots - no range argument.
      expect(vendorsRepository.getComplianceSummary).toHaveBeenCalledWith();
      expect(vendorsRepository.countByTier).toHaveBeenCalledWith();
    });
  });

  describe('getSalesAnalytics', () => {
    it('composes top products, sales by category, sales by payment method, and average order value', async () => {
      const result = await service.getSalesAnalytics();

      expect(result).toEqual({
        topProductsByRevenue,
        salesByCategory,
        salesByPaymentMethod: { WIPAY: '3000', CASH_ON_DELIVERY: '2000' },
        averageOrderValue: '1250.00',
        currency: 'JMD',
      });
    });

    it('returns a zero average order value when there are no PAID payments', async () => {
      paymentsRepository.countByStatus.mockResolvedValue(0);

      const result = await service.getSalesAnalytics();

      expect(result.averageOrderValue).toBe('0.00');
    });

    it('passes the from/to range to every underlying query', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-01-31');

      await service.getSalesAnalytics({ from, to });

      expect(vendorOrdersRepository.getTopProductsByRevenue).toHaveBeenCalledWith(10, { from, to });
      expect(vendorOrdersRepository.getSalesByCategory).toHaveBeenCalledWith({ from, to });
      expect(paymentsRepository.sumByProvider).toHaveBeenCalledWith('PAID', { from, to });
      expect(paymentsRepository.countByStatus).toHaveBeenCalledWith('PAID', { from, to });
      expect(paymentsRepository.sumByStatus).toHaveBeenCalledWith('PAID', { from, to });
    });
  });

  describe('getDeliveryAnalytics', () => {
    it('composes SLA breaches by zone, fleet by zone, and customer-acceptance counts', async () => {
      const result = await service.getDeliveryAnalytics();

      expect(result).toEqual({
        slaBreachesByZone: [{ zoneId: 'zone-1', totalBreaches: 3, unresolvedBreaches: 1 }],
        totalUnresolvedBreaches: 1,
        fleetByZone: [{ zoneId: 'zone-1', status: 'AVAILABLE', count: 4 }],
        byCustomerAcceptanceStatus: { PENDING: 1, ACCEPTED: 8, REJECTED: 1 },
      });
    });

    it('sums unresolvedBreaches across every zone', async () => {
      slaBreachesService.getZoneSummary.mockResolvedValue([
        { zoneId: 'zone-1', totalBreaches: 3, unresolvedBreaches: 1 },
        { zoneId: 'zone-2', totalBreaches: 5, unresolvedBreaches: 2 },
      ]);

      const result = await service.getDeliveryAnalytics();

      expect(result.totalUnresolvedBreaches).toBe(3);
    });

    it('passes the from/to range to the customer-acceptance query only', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-01-31');

      await service.getDeliveryAnalytics({ from, to });

      expect(deliveriesRepository.countByCustomerAcceptanceStatus).toHaveBeenCalledWith({ from, to });
      // SLA breach and fleet zone summaries are point-in-time snapshots - no range argument.
      expect(slaBreachesService.getZoneSummary).toHaveBeenCalledWith();
      expect(fleetAssetsService.getZoneSummary).toHaveBeenCalledWith();
    });
  });
});
