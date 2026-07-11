import { Prisma } from '@prisma/client';

import { HealthService } from '../../../common/health/health.service';
import { DriversRepository } from '../../delivery/repositories/drivers.repository';
import { ComplianceDashboardService } from '../../food-safety/services/compliance-dashboard.service';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { PaymentsRepository } from '../../payments/repositories/payments.repository';
import { VendorSettlementsRepository } from '../../vendor-settlements/repositories/vendor-settlements.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsService', () => {
  let paymentsRepository: jest.Mocked<Pick<PaymentsRepository, 'sumByStatus'>>;
  let vendorSettlementsRepository: jest.Mocked<Pick<VendorSettlementsRepository, 'sumPlatformFeeByStatus'>>;
  let ordersRepository: jest.Mocked<Pick<OrdersRepository, 'count'>>;
  let vendorOrdersRepository: jest.Mocked<Pick<VendorOrdersRepository, 'countByStatus'>>;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'getComplianceSummary'>>;
  let driversRepository: jest.Mocked<Pick<DriversRepository, 'countByStatus'>>;
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
  const driversByStatus = { PENDING: 1, APPROVED: 8, SUSPENDED: 0, REJECTED: 0 };
  const activeAlertsBySeverity = { WARNING: 3, CRITICAL: 1, EMERGENCY: 0 };

  beforeEach(() => {
    paymentsRepository = { sumByStatus: jest.fn().mockResolvedValue(new Prisma.Decimal(5000)) };
    vendorSettlementsRepository = {
      sumPlatformFeeByStatus: jest.fn().mockResolvedValue(new Prisma.Decimal(500)),
    };
    ordersRepository = { count: jest.fn().mockResolvedValue(4) };
    vendorOrdersRepository = { countByStatus: jest.fn().mockResolvedValue(vendorOrdersByStatus) };
    vendorsRepository = {
      getComplianceSummary: jest.fn().mockResolvedValue({ countByStatus: vendorsByStatus, averageComplianceScore: 90 }),
    };
    driversRepository = { countByStatus: jest.fn().mockResolvedValue(driversByStatus) };
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
});
