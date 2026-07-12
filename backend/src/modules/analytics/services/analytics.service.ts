import { Injectable } from '@nestjs/common';

import { DateRange } from '../../../common/dto/date-range.type';
import { HealthService } from '../../../common/health/health.service';
import { ComplianceDashboardService } from '../../food-safety/services/compliance-dashboard.service';
import { PaymentsRepository } from '../../payments/repositories/payments.repository';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { VendorSettlementsRepository } from '../../vendor-settlements/repositories/vendor-settlements.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { DeliveriesRepository } from '../../delivery/repositories/deliveries.repository';
import { DriversRepository } from '../../delivery/repositories/drivers.repository';
import { SLABreachesService } from '../../delivery/services/sla-breaches.service';
import { FleetAssetsService } from '../../fleet/services/fleet-assets.service';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { ProductAvailability } from '../../products/entities/product-response.entity';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { ProductsService } from '../../products/services/products.service';
import { DashboardSummaryEntity } from '../entities/dashboard-summary.entity';
import { DeliveryAnalyticsEntity } from '../entities/delivery-analytics.entity';
import { InventoryAnalyticsEntity } from '../entities/inventory-analytics.entity';
import { SalesAnalyticsEntity } from '../entities/sales-analytics.entity';
import { VendorDashboardEntity } from '../entities/vendor-dashboard.entity';

const TOP_VENDORS_LIMIT = 10;
const TOP_PRODUCTS_LIMIT = 10;
// No stored reorder-point field exists on Product (confirmed: schema has
// no threshold column) - this is a platform-wide operational default, not
// a re-derivation of any per-vendor business rule.
const LOW_STOCK_THRESHOLD = 10;
const LOW_STOCK_LIMIT = 20;

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
    private readonly deliveriesRepository: DeliveriesRepository,
    private readonly slaBreachesService: SLABreachesService,
    private readonly fleetAssetsService: FleetAssetsService,
    private readonly productsRepository: ProductsRepository,
    private readonly inventoryEventsRepository: InventoryEventsRepository,
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

  // 12B Vendor Dashboard - a sibling composer to getDashboardSummary, per
  // this class's own "future analytics become sibling methods" design note.
  async getVendorDashboard(range?: DateRange): Promise<VendorDashboardEntity> {
    const [{ countByStatus, averageComplianceScore }, byTier, topVendorsByRevenue] = await Promise.all([
      this.vendorsRepository.getComplianceSummary(),
      this.vendorsRepository.countByTier(),
      this.vendorSettlementsRepository.getTopVendorsByRevenue(TOP_VENDORS_LIMIT, range),
    ]);

    return {
      byStatus: countByStatus,
      byTier,
      averageComplianceScore,
      topVendorsByRevenue,
    };
  }

  // 12B Sales Analytics - another sibling composer. Average order value is
  // derived from the same PAID-payment sum/count getDashboardSummary()
  // already uses, so it stays consistent with the dashboard's own
  // grossPaidAmount rather than recomputing revenue a different way.
  async getSalesAnalytics(range?: DateRange): Promise<SalesAnalyticsEntity> {
    const [topProductsByRevenue, salesByCategory, salesByPaymentMethod, paidCount, grossPaidAmount] =
      await Promise.all([
        this.vendorOrdersRepository.getTopProductsByRevenue(TOP_PRODUCTS_LIMIT, range),
        this.vendorOrdersRepository.getSalesByCategory(range),
        this.paymentsRepository.sumByProvider('PAID', range),
        this.paymentsRepository.countByStatus('PAID', range),
        this.paymentsRepository.sumByStatus('PAID', range),
      ]);

    return {
      topProductsByRevenue,
      salesByCategory,
      salesByPaymentMethod: {
        WIPAY: salesByPaymentMethod.WIPAY.toString(),
        CASH_ON_DELIVERY: salesByPaymentMethod.CASH_ON_DELIVERY.toString(),
      },
      averageOrderValue: paidCount > 0 ? grossPaidAmount.dividedBy(paidCount).toFixed(2) : '0.00',
      currency: 'JMD',
    };
  }

  // 12B Delivery Analytics - SLA breach and fleet zone summaries are
  // reused wholesale from SLABreachesService/FleetAssetsService (Phase
  // 10D), not re-derived; only the customer-acceptance breakdown is new.
  async getDeliveryAnalytics(range?: DateRange): Promise<DeliveryAnalyticsEntity> {
    const [slaBreachesByZone, fleetByZone, byCustomerAcceptanceStatus] = await Promise.all([
      this.slaBreachesService.getZoneSummary(),
      this.fleetAssetsService.getZoneSummary(),
      this.deliveriesRepository.countByCustomerAcceptanceStatus(range),
    ]);

    return {
      slaBreachesByZone,
      totalUnresolvedBreaches: slaBreachesByZone.reduce((sum, zone) => sum + zone.unresolvedBreaches, 0),
      fleetByZone,
      byCustomerAcceptanceStatus,
    };
  }

  // 12B Inventory Analytics - byAvailability is tallied with
  // ProductsService.computeAvailability(), the exact same rule the public
  // product listing uses, so this never drifts from what customers
  // actually see as purchasable.
  async getInventoryAnalytics(range?: DateRange): Promise<InventoryAnalyticsEntity> {
    const [products, lowStockProducts, eventsByType] = await Promise.all([
      this.productsRepository.findAllForAvailability(),
      this.productsRepository.findLowStock(LOW_STOCK_THRESHOLD, LOW_STOCK_LIMIT),
      this.inventoryEventsRepository.countAndSumByType(range),
    ]);

    const byAvailability: Record<ProductAvailability, number> = {
      [ProductAvailability.ACTIVE]: 0,
      [ProductAvailability.OUT_OF_STOCK]: 0,
      [ProductAvailability.INACTIVE]: 0,
      [ProductAvailability.ON_HOLD]: 0,
    };
    for (const product of products) {
      byAvailability[ProductsService.computeAvailability(product)] += 1;
    }

    return {
      byAvailability,
      lowStockProducts: lowStockProducts.map((product) => ({
        productId: product.id,
        productName: product.name,
        quantityAvailable: product.quantityAvailable,
        vendorId: product.vendorId,
      })),
      eventsByType,
    };
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
