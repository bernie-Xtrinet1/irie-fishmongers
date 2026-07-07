import { ForbiddenException, Injectable } from '@nestjs/common';
import { VendorTier, VendorTierFeature } from '@prisma/client';

import { VendorPermissionsEntity } from '../entities/vendor-permissions.entity';
import { VendorSalesRepository } from '../repositories/vendor-sales.repository';
import { VendorTierConfigsRepository } from '../repositories/vendor-tier-configs.repository';
import { VendorTierFeaturesRepository } from '../repositories/vendor-tier-features.repository';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Per vendor-tier-rules.md's Feature Flag Rules ("Never hardcode vendor
 * tier checks... permissions = getVendorTierPermissions()"): this is the
 * ONLY place tier-derived capability decisions are made. Everything is
 * read from VendorTierConfig/VendorTierFeature (seeded, admin-editable
 * config), never a `tier === 'X'` branch.
 */
@Injectable()
export class VendorPermissionsService {
  constructor(
    private readonly configsRepository: VendorTierConfigsRepository,
    private readonly featuresRepository: VendorTierFeaturesRepository,
    private readonly salesRepository: VendorSalesRepository,
  ) {}

  async getPermissions(tier: VendorTier): Promise<VendorPermissionsEntity> {
    const [config, features] = await Promise.all([
      this.configsRepository.findByTier(tier),
      this.featuresRepository.findByTier(tier),
    ]);

    const isEnabled = (flag: VendorTierFeature['feature']): boolean =>
      features.find((feature) => feature.feature === flag)?.enabled ?? false;

    return {
      tier,
      badge: config?.badge ?? '',
      dailySalesLimit: config?.dailySalesLimit?.toString() ?? null,
      monthlySalesLimit: config?.monthlySalesLimit?.toString() ?? null,
      maxActiveListings: config?.maxActiveListings ?? null,
      canSellRetail: isEnabled('SELL_RETAIL'),
      canSellWholesale: isEnabled('SELL_WHOLESALE'),
      canAcceptHotelOrders: isEnabled('ACCEPT_HOTEL_ORDERS'),
      canAcceptRestaurantOrders: isEnabled('ACCEPT_RESTAURANT_ORDERS'),
      canAcceptGovernmentOrders: isEnabled('ACCEPT_GOVERNMENT_ORDERS'),
      canExportProducts: isEnabled('EXPORT_PRODUCTS'),
      canAccessAnalytics: isEnabled('ACCESS_ANALYTICS'),
      canAccessPromotions: isEnabled('ACCESS_PROMOTIONS'),
      canUseApiAccess: isEnabled('API_ACCESS'),
      canOperateMultipleZones: isEnabled('MULTI_ZONE_OPERATIONS'),
    };
  }

  /** Product creation gate - vendor-tier-rules.md's per-tier "Maximum Active Listings". */
  async assertListingLimitNotExceeded(vendorId: string, tier: VendorTier): Promise<void> {
    const config = await this.configsRepository.findByTier(tier);
    if (!config?.maxActiveListings) {
      return;
    }

    const activeCount = await this.salesRepository.countActiveListings(vendorId);
    if (activeCount >= config.maxActiveListings) {
      throw new ForbiddenException(
        `This vendor's tier allows a maximum of ${config.maxActiveListings} active listings`,
      );
    }
  }

  /** Checkout gate - vendor-tier-rules.md's per-tier Daily/Monthly Sales Limit. */
  async assertSalesLimitNotExceeded(
    vendorId: string,
    tier: VendorTier,
    additionalAmount: number,
  ): Promise<void> {
    const config = await this.configsRepository.findByTier(tier);
    if (!config) {
      return;
    }

    if (config.dailySalesLimit) {
      const since = new Date(Date.now() - DAY_MS);
      const soldToday = await this.salesRepository.sumVendorOrderSubtotalsSince(vendorId, since);
      if (soldToday + additionalAmount > config.dailySalesLimit.toNumber()) {
        throw new ForbiddenException("This vendor's daily sales limit would be exceeded");
      }
    }

    if (config.monthlySalesLimit) {
      const since = new Date(Date.now() - 30 * DAY_MS);
      const soldThisMonth = await this.salesRepository.sumVendorOrderSubtotalsSince(vendorId, since);
      if (soldThisMonth + additionalAmount > config.monthlySalesLimit.toNumber()) {
        throw new ForbiddenException("This vendor's monthly sales limit would be exceeded");
      }
    }
  }
}
