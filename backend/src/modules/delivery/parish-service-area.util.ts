import { Parish } from '@prisma/client';

export interface VendorParishCoverageInput {
  parish: Parish;
  secondaryZones?: Array<{
    zone?: {
      active?: boolean;
      parishes?: Array<{ parish: Parish }>;
    } | null;
  }>;
}

export interface OrderParishInput {
  deliveryParish?: Parish | null;
  deliveryZone?: { active?: boolean } | null;
}

/**
 * Returns the set of Jamaican parishes served by a vendor.
 * By default (same-parish pilot / standard vendors), this is the vendor's
 * own configured parish plus any explicitly configured active secondary service zones.
 */
export function getVendorAllowedServiceParishes(vendor: VendorParishCoverageInput): Set<Parish> {
  const allowed = new Set<Parish>([vendor.parish]);
  if (vendor.secondaryZones) {
    for (const sz of vendor.secondaryZones) {
      if (sz.zone && sz.zone.active !== false && sz.zone.parishes) {
        for (const mapping of sz.zone.parishes) {
          allowed.add(mapping.parish);
        }
      }
    }
  }
  return allowed;
}

export function isDeliveryParishEligibleForVendor(
  vendor: VendorParishCoverageInput,
  order?: OrderParishInput | null,
  parishZoneActiveMap?: Map<Parish, boolean>,
): boolean {
  if (!order?.deliveryParish) {
    return true;
  }
  if (order.deliveryZone && order.deliveryZone.active === false) {
    return false;
  }
  if (parishZoneActiveMap && parishZoneActiveMap.has(order.deliveryParish)) {
    if (!parishZoneActiveMap.get(order.deliveryParish)) {
      return false;
    }
  }
  return getVendorAllowedServiceParishes(vendor).has(order.deliveryParish);
}
