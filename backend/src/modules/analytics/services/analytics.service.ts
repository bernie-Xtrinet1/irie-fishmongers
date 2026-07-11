import { Injectable } from '@nestjs/common';

import { DateRange } from '../../../common/dto/date-range.type';
import { HealthService } from '../../../common/health/health.service';
import { ComplianceDashboardService } from '../../food-safety/services/compliance-dashboard.service';
import { PaymentsRepository } from '../../payments/repositories/payments.repository';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { VendorSettlementsRepository } from '../../vendor-settlements/repositories/vendor-settlements.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { DriversRepository } from '../../delivery/repositories/drivers.repository';
import { DashboardSummaryEntity } from '../entities/dashboard-summary.entity';

// Composes existing repositories/services rather than duplicating their
// logic - no repository of its own. Organized by feature domain (one
// private method per KPI group) so future analytics (12D's Sales/Vendor/
// Fleet/Compliance/Financial Analytics) can become sibling methods without
// restructuring this composer.
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly paymentsRepository: PaymentsRepository,
    private readonly vendorSettlementsRepository: VendorSettlementsRepository,
    private readonly ordersRepository: OrdersRepository,
    private readonly vendorOrdersRepository: VendorOrdersRepository,
    private readonly vendorsRepository: VendorsRepository,
    private readonly driversRepository: DriversRepository,
    private readonly complianceDashboardService: ComplianceDashboardService,
    private readonly healthService: HealthService,
  ) {}

  async getDashboardSummary(range?: DateRange): Promise<DashboardSummaryEntity> {
    const [financials, orders, vendors, drivers, compliance, systemHealth] = await Promise.all([
      this.getFinancials(range),
      this.getOrderCounts(range),
      this.getVendorCounts(),
      this.getDriverCounts(),
      this.getComplianceSummary(),
      this.getSystemHealth(),
    ]);

    return { financials, orders, vendors, drivers, compliance, systemHealth };
  }

  private async getFinancials(range?: DateRange): Promise<DashboardSummaryEntity['financials']> {
    const [grossPaidAmount, platformCommission] = await Promise.all([
      this.paymentsRepository.sumByStatus('PAID', range),
      this.vendorSettlementsRepository.sumPlatformFeeByStatus('PAID', range),
    ]);

    return {
      grossPaidAmount: grossPaidAmount.toString(),
      platformCommission: platformCommission.toString(),
      currency: 'JMD',
    };
  }

  private async getOrderCounts(range?: DateRange): Promise<DashboardSummaryEntity['orders']> {
    const [customerOrdersTotal, vendorOrdersByStatus] = await Promise.all([
      this.ordersRepository.count(range),
      this.vendorOrdersRepository.countByStatus(range),
    ]);

    return { customerOrdersTotal, vendorOrdersByStatus };
  }

  private async getVendorCounts(): Promise<DashboardSummaryEntity['vendors']> {
    const { countByStatus } = await this.vendorsRepository.getComplianceSummary();
    return { byStatus: countByStatus };
  }

  private async getDriverCounts(): Promise<DashboardSummaryEntity['drivers']> {
    const byStatus = await this.driversRepository.countByStatus();
    return { byStatus };
  }

  private async getComplianceSummary(): Promise<DashboardSummaryEntity['compliance']> {
    const { activeAlertsBySeverity, activeRecalls } = await this.complianceDashboardService.getDashboard();
    return { activeAlertsBySeverity, activeRecalls };
  }

  // Isolated from the rest of the Promise.all above via
  // HealthService.checkStatus()'s own internal try/catch per check - a
  // Redis outage degrades this one field, never the whole response. A
  // genuine Postgres outage is allowed to fail the whole endpoint, since
  // every other query here depends on Postgres too.
  private async getSystemHealth(): Promise<DashboardSummaryEntity['systemHealth']> {
    return this.healthService.checkStatus();
  }
}
