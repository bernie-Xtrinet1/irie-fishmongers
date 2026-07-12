import {
  NotificationChannel,
  NotificationEventType,
  Parish,
  PrismaClient,
  RegulatoryStatus,
  RoleName,
  SeafoodStorageType,
  VendorTier,
  VendorTierFeatureFlag,
} from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_CATEGORIES = [
  { name: 'Fish', slug: 'fish' },
  { name: 'Shellfish', slug: 'shellfish' },
  { name: 'Crustaceans', slug: 'crustaceans' },
  { name: 'Mollusks', slug: 'mollusks' },
];

// docs/reference/jamaica-delivery-zones.md - the authoritative parish/zone
// mapping (also cited in ADR-002-delivery-zones.md's "Initial target: Zone
// 1, Zone 2, Zone 3").
const DELIVERY_ZONES: { code: string; name: string; parishes: Parish[] }[] = [
  {
    code: 'ZONE_1',
    name: 'Zone 1',
    parishes: ['KINGSTON', 'ST_ANDREW', 'ST_CATHERINE'],
  },
  {
    code: 'ZONE_2',
    name: 'Zone 2',
    parishes: ['CLARENDON', 'MANCHESTER', 'ST_ELIZABETH'],
  },
  {
    code: 'ZONE_3',
    name: 'Zone 3',
    parishes: [
      'HANOVER',
      'WESTMORELAND',
      'ST_JAMES',
      'TRELAWNY',
      'ST_ANN',
      'ST_MARY',
      'PORTLAND',
      'ST_THOMAS',
    ],
  },
];

// Figures taken directly from .claude/marketplace/vendor-tier-rules.md's
// per-tier tables. null means "unlimited / not specified in the source doc",
// never a magic sentinel number.
const VENDOR_TIER_CONFIGS: {
  tier: VendorTier;
  dailySalesLimit: number | null;
  monthlySalesLimit: number | null;
  maxActiveListings: number | null;
  badge: string;
}[] = [
  {
    tier: 'COMMUNITY_FISHER',
    dailySalesLimit: 50000,
    monthlySalesLimit: 500000,
    maxActiveListings: 50,
    badge: '🐟 Community Fisher',
  },
  {
    tier: 'VERIFIED_VENDOR',
    dailySalesLimit: null,
    monthlySalesLimit: null,
    maxActiveListings: 500,
    badge: '✓ Verified Vendor',
  },
  {
    tier: 'COMMERCIAL_SUPPLIER',
    dailySalesLimit: null,
    monthlySalesLimit: null,
    maxActiveListings: null,
    badge: '✓ Commercial Supplier',
  },
  {
    tier: 'ENTERPRISE_SUPPLIER',
    dailySalesLimit: null,
    monthlySalesLimit: null,
    maxActiveListings: null,
    badge: '✓ Enterprise Supplier',
  },
];

// The Feature Flag Rules' "Required Functions" table, seeded true/false per
// tier directly from vendor-tier-rules.md's per-tier Permissions sections.
const VENDOR_TIER_FEATURES: { tier: VendorTier; feature: VendorTierFeatureFlag; enabled: boolean }[] = [
  // COMMUNITY_FISHER
  { tier: 'COMMUNITY_FISHER', feature: 'SELL_RETAIL', enabled: true },
  { tier: 'COMMUNITY_FISHER', feature: 'SELL_WHOLESALE', enabled: false },
  { tier: 'COMMUNITY_FISHER', feature: 'ACCEPT_HOTEL_ORDERS', enabled: false },
  { tier: 'COMMUNITY_FISHER', feature: 'ACCEPT_RESTAURANT_ORDERS', enabled: false },
  { tier: 'COMMUNITY_FISHER', feature: 'ACCEPT_GOVERNMENT_ORDERS', enabled: false },
  { tier: 'COMMUNITY_FISHER', feature: 'EXPORT_PRODUCTS', enabled: false },
  { tier: 'COMMUNITY_FISHER', feature: 'ACCESS_ANALYTICS', enabled: false },
  { tier: 'COMMUNITY_FISHER', feature: 'ACCESS_PROMOTIONS', enabled: false },
  { tier: 'COMMUNITY_FISHER', feature: 'API_ACCESS', enabled: false },
  { tier: 'COMMUNITY_FISHER', feature: 'MULTI_ZONE_OPERATIONS', enabled: false },
  // VERIFIED_VENDOR
  { tier: 'VERIFIED_VENDOR', feature: 'SELL_RETAIL', enabled: true },
  { tier: 'VERIFIED_VENDOR', feature: 'SELL_WHOLESALE', enabled: false },
  { tier: 'VERIFIED_VENDOR', feature: 'ACCEPT_HOTEL_ORDERS', enabled: false },
  { tier: 'VERIFIED_VENDOR', feature: 'ACCEPT_RESTAURANT_ORDERS', enabled: false },
  { tier: 'VERIFIED_VENDOR', feature: 'ACCEPT_GOVERNMENT_ORDERS', enabled: false },
  { tier: 'VERIFIED_VENDOR', feature: 'EXPORT_PRODUCTS', enabled: false },
  { tier: 'VERIFIED_VENDOR', feature: 'ACCESS_ANALYTICS', enabled: true },
  { tier: 'VERIFIED_VENDOR', feature: 'ACCESS_PROMOTIONS', enabled: true },
  { tier: 'VERIFIED_VENDOR', feature: 'API_ACCESS', enabled: false },
  { tier: 'VERIFIED_VENDOR', feature: 'MULTI_ZONE_OPERATIONS', enabled: false },
  // COMMERCIAL_SUPPLIER
  { tier: 'COMMERCIAL_SUPPLIER', feature: 'SELL_RETAIL', enabled: true },
  { tier: 'COMMERCIAL_SUPPLIER', feature: 'SELL_WHOLESALE', enabled: true },
  { tier: 'COMMERCIAL_SUPPLIER', feature: 'ACCEPT_HOTEL_ORDERS', enabled: true },
  { tier: 'COMMERCIAL_SUPPLIER', feature: 'ACCEPT_RESTAURANT_ORDERS', enabled: true },
  { tier: 'COMMERCIAL_SUPPLIER', feature: 'ACCEPT_GOVERNMENT_ORDERS', enabled: true },
  { tier: 'COMMERCIAL_SUPPLIER', feature: 'EXPORT_PRODUCTS', enabled: false },
  { tier: 'COMMERCIAL_SUPPLIER', feature: 'ACCESS_ANALYTICS', enabled: true },
  { tier: 'COMMERCIAL_SUPPLIER', feature: 'ACCESS_PROMOTIONS', enabled: true },
  { tier: 'COMMERCIAL_SUPPLIER', feature: 'API_ACCESS', enabled: false },
  { tier: 'COMMERCIAL_SUPPLIER', feature: 'MULTI_ZONE_OPERATIONS', enabled: false },
  // ENTERPRISE_SUPPLIER
  { tier: 'ENTERPRISE_SUPPLIER', feature: 'SELL_RETAIL', enabled: true },
  { tier: 'ENTERPRISE_SUPPLIER', feature: 'SELL_WHOLESALE', enabled: true },
  { tier: 'ENTERPRISE_SUPPLIER', feature: 'ACCEPT_HOTEL_ORDERS', enabled: true },
  { tier: 'ENTERPRISE_SUPPLIER', feature: 'ACCEPT_RESTAURANT_ORDERS', enabled: true },
  { tier: 'ENTERPRISE_SUPPLIER', feature: 'ACCEPT_GOVERNMENT_ORDERS', enabled: true },
  { tier: 'ENTERPRISE_SUPPLIER', feature: 'EXPORT_PRODUCTS', enabled: true },
  { tier: 'ENTERPRISE_SUPPLIER', feature: 'ACCESS_ANALYTICS', enabled: true },
  { tier: 'ENTERPRISE_SUPPLIER', feature: 'ACCESS_PROMOTIONS', enabled: true },
  { tier: 'ENTERPRISE_SUPPLIER', feature: 'API_ACCESS', enabled: true },
  { tier: 'ENTERPRISE_SUPPLIER', feature: 'MULTI_ZONE_OPERATIONS', enabled: true },
];

// One row per (eventType, channel) actually wired by NotificationEventsListener
// (see docs/database-design.md's Notifications section for the full list and
// the deferred events notification-standards.md also describes).
const NOTIFICATION_TEMPLATES: {
  eventType: NotificationEventType;
  channel: NotificationChannel;
  subject: string;
  body: string;
  variables: string[];
}[] = [
  {
    eventType: 'REGISTRATION_CONFIRMED',
    channel: 'EMAIL',
    subject: 'Welcome to Irie Fishmongers, {{firstName}}!',
    body: 'Hi {{firstName}}, thanks for joining Irie Fishmongers. Your account has been created successfully.',
    variables: ['firstName'],
  },
  {
    eventType: 'REGISTRATION_CONFIRMED',
    channel: 'IN_APP',
    subject: 'Welcome to Irie Fishmongers',
    body: 'Hi {{firstName}}, your account has been created successfully.',
    variables: ['firstName'],
  },
  {
    eventType: 'VENDOR_APPROVED',
    channel: 'EMAIL',
    subject: 'Your vendor account has been approved',
    body: 'Congratulations! {{businessName}} has been approved to sell on Irie Fishmongers. You can now list products and receive orders.',
    variables: ['businessName'],
  },
  {
    eventType: 'VENDOR_APPROVED',
    channel: 'PUSH',
    subject: 'Vendor account approved',
    body: '{{businessName}} is now approved and can start selling.',
    variables: ['businessName'],
  },
  {
    eventType: 'VENDOR_APPROVED',
    channel: 'IN_APP',
    subject: 'Vendor account approved',
    body: '{{businessName}} has been approved to sell on Irie Fishmongers.',
    variables: ['businessName'],
  },
  {
    eventType: 'ORDER_PLACED',
    channel: 'EMAIL',
    subject: 'Order confirmed',
    body: 'Your order {{orderId}} ({{itemCount}} item(s), total JMD {{totalAmount}}) has been placed and sent to the vendor(s).',
    variables: ['orderId', 'itemCount', 'totalAmount'],
  },
  {
    eventType: 'ORDER_PLACED',
    channel: 'PUSH',
    subject: 'Order confirmed',
    body: 'Your order {{orderId}} has been placed.',
    variables: ['orderId'],
  },
  {
    eventType: 'ORDER_PLACED',
    channel: 'IN_APP',
    subject: 'Order confirmed',
    body: 'Your order {{orderId}} ({{itemCount}} item(s), total JMD {{totalAmount}}) has been placed.',
    variables: ['orderId', 'itemCount', 'totalAmount'],
  },
  {
    eventType: 'ORDER_ACCEPTED',
    channel: 'EMAIL',
    subject: 'Your order has been accepted',
    body: '{{vendorBusinessName}} has accepted your order {{orderId}} and is preparing it now.',
    variables: ['orderId', 'vendorBusinessName'],
  },
  {
    eventType: 'ORDER_ACCEPTED',
    channel: 'PUSH',
    subject: 'Order accepted',
    body: '{{vendorBusinessName}} accepted your order {{orderId}}.',
    variables: ['orderId', 'vendorBusinessName'],
  },
  {
    eventType: 'ORDER_ACCEPTED',
    channel: 'IN_APP',
    subject: 'Order accepted',
    body: '{{vendorBusinessName}} has accepted your order {{orderId}} and is preparing it now.',
    variables: ['orderId', 'vendorBusinessName'],
  },
  {
    eventType: 'PAYMENT_CONFIRMED',
    channel: 'EMAIL',
    subject: 'Payment received',
    body: "We've received your payment of {{currency}} {{amount}} for order {{orderId}}.",
    variables: ['orderId', 'amount', 'currency'],
  },
  {
    eventType: 'PAYMENT_CONFIRMED',
    channel: 'IN_APP',
    subject: 'Payment received',
    body: "We've received your payment of {{currency}} {{amount}} for order {{orderId}}.",
    variables: ['orderId', 'amount', 'currency'],
  },
  {
    eventType: 'DELIVERY_STATUS_UPDATED',
    channel: 'EMAIL',
    subject: 'Delivery update',
    body: 'Your delivery for order {{vendorOrderId}} is now {{stage}}.',
    variables: ['vendorOrderId', 'stage'],
  },
  {
    eventType: 'DELIVERY_STATUS_UPDATED',
    channel: 'PUSH',
    subject: 'Delivery update',
    body: 'Your delivery for order {{vendorOrderId}} is now {{stage}}.',
    variables: ['vendorOrderId', 'stage'],
  },
  {
    eventType: 'DELIVERY_STATUS_UPDATED',
    channel: 'IN_APP',
    subject: 'Delivery update',
    body: 'Your delivery for order {{vendorOrderId}} is now {{stage}}.',
    variables: ['vendorOrderId', 'stage'],
  },
  {
    eventType: 'REFUND_STATUS_CHANGED',
    channel: 'EMAIL',
    subject: 'Refund update',
    body: 'Your refund of {{amount}} is now {{status}}.',
    variables: ['amount', 'status'],
  },
  {
    eventType: 'REFUND_STATUS_CHANGED',
    channel: 'IN_APP',
    subject: 'Refund update',
    body: 'Your refund of {{amount}} is now {{status}}.',
    variables: ['amount', 'status'],
  },
  {
    eventType: 'DRIVER_ASSIGNED',
    channel: 'EMAIL',
    subject: 'A driver has been assigned to your order',
    body: '{{driverFirstName}} has been assigned to deliver your order {{vendorOrderId}}.',
    variables: ['vendorOrderId', 'driverFirstName'],
  },
  {
    eventType: 'DRIVER_ASSIGNED',
    channel: 'PUSH',
    subject: 'Driver assigned',
    body: '{{driverFirstName}} is bringing your order {{vendorOrderId}}.',
    variables: ['vendorOrderId', 'driverFirstName'],
  },
  {
    eventType: 'DRIVER_ASSIGNED',
    channel: 'IN_APP',
    subject: 'Driver assigned',
    body: '{{driverFirstName}} has been assigned to deliver your order {{vendorOrderId}}.',
    variables: ['vendorOrderId', 'driverFirstName'],
  },
  {
    eventType: 'AWAITING_CUSTOMER_ACCEPTANCE',
    channel: 'EMAIL',
    subject: 'Please confirm your delivery',
    body: 'Your order {{vendorOrderId}} has been delivered. Please review it and confirm you accept it.',
    variables: ['vendorOrderId'],
  },
  {
    eventType: 'AWAITING_CUSTOMER_ACCEPTANCE',
    channel: 'PUSH',
    subject: 'Confirm your delivery',
    body: 'Your order {{vendorOrderId}} arrived. Tap to confirm you accept it.',
    variables: ['vendorOrderId'],
  },
  {
    eventType: 'AWAITING_CUSTOMER_ACCEPTANCE',
    channel: 'IN_APP',
    subject: 'Confirm your delivery',
    body: 'Your order {{vendorOrderId}} has been delivered. Please review it and confirm you accept it.',
    variables: ['vendorOrderId'],
  },
  {
    eventType: 'COLD_CHAIN_ALERT_RAISED',
    channel: 'EMAIL',
    subject: 'Cold-chain temperature alert',
    body: 'Lot {{lotNumber}} recorded a {{severity}} temperature reading of {{temperatureC}}C at the {{checkpoint}} checkpoint. Please review immediately.',
    variables: ['lotNumber', 'severity', 'temperatureC', 'checkpoint'],
  },
  {
    eventType: 'COLD_CHAIN_ALERT_RAISED',
    channel: 'IN_APP',
    subject: 'Cold-chain temperature alert',
    body: 'Lot {{lotNumber}} recorded a {{severity}} temperature reading of {{temperatureC}}C at the {{checkpoint}} checkpoint. Please review immediately.',
    variables: ['lotNumber', 'severity', 'temperatureC', 'checkpoint'],
  },
  {
    eventType: 'RECALL_ISSUED',
    channel: 'EMAIL',
    subject: 'Important: product recall affecting your order',
    body: 'A seafood lot ({{lotNumber}}) in your order {{orderId}} has been recalled. Reason: {{reason}}. Please do not consume this product and contact support for a refund.',
    variables: ['orderId', 'lotNumber', 'reason'],
  },
  {
    eventType: 'RECALL_ISSUED',
    channel: 'IN_APP',
    subject: 'Product recall affecting your order',
    body: 'A seafood lot ({{lotNumber}}) in your order {{orderId}} has been recalled. Reason: {{reason}}.',
    variables: ['orderId', 'lotNumber', 'reason'],
  },
  {
    eventType: 'FLEET_MAINTENANCE_OVERDUE',
    channel: 'EMAIL',
    subject: 'Vehicle maintenance overdue',
    body: 'Maintenance on vehicle {{licensePlate}} is overdue (next service was due {{nextServiceDue}}). Please schedule service before your next delivery run.',
    variables: ['licensePlate', 'nextServiceDue'],
  },
  {
    eventType: 'FLEET_MAINTENANCE_OVERDUE',
    channel: 'IN_APP',
    subject: 'Vehicle maintenance overdue',
    body: 'Maintenance on vehicle {{licensePlate}} is overdue (next service was due {{nextServiceDue}}).',
    variables: ['licensePlate', 'nextServiceDue'],
  },
];

// seafood-compliance-rules.md's own species examples; Conch is seeded
// RESTRICTED per the same doc's regulatory-status example.
const SPECIES: {
  scientificName: string;
  commercialName: string;
  regulatoryStatus: RegulatoryStatus;
}[] = [
  { scientificName: 'Lutjanus analis', commercialName: 'Snapper', regulatoryStatus: 'UNRESTRICTED' },
  { scientificName: 'Scomberomorus cavalla', commercialName: 'King Fish', regulatoryStatus: 'UNRESTRICTED' },
  { scientificName: 'Scomber scombrus', commercialName: 'Mackerel', regulatoryStatus: 'UNRESTRICTED' },
  { scientificName: 'Panulirus argus', commercialName: 'Lobster', regulatoryStatus: 'UNRESTRICTED' },
  { scientificName: 'Penaeus spp.', commercialName: 'Shrimp', regulatoryStatus: 'UNRESTRICTED' },
  { scientificName: 'Lobatus gigas', commercialName: 'Conch', regulatoryStatus: 'RESTRICTED' },
];

// seafood-compliance-rules.md's own regulatory-alignment examples -
// starting reference rows so RegulatoryCertification.issuingAuthorityId
// has real authorities to point at from day one.
const REGULATORY_AUTHORITIES: { name: string; country: string }[] = [
  { name: 'Fisheries Division / National Fisheries Authority', country: 'Jamaica' },
  { name: 'Ministry of Health', country: 'Jamaica' },
  { name: 'Bureau of Standards Jamaica', country: 'Jamaica' },
];

// Platform-wide default thresholds (deviceId: null) - replaces the
// previously-hardcoded FRESH_MAX_C/FROZEN_MAX_C constants with real,
// admin-editable data. warningBandC is how far past min/max a reading must
// be to escalate WARNING -> CRITICAL; EMERGENCY is 2x warningBandC further.
const TEMPERATURE_THRESHOLDS: {
  storageType: SeafoodStorageType;
  minC: number;
  maxC: number;
  warningBandC: number;
}[] = [
  { storageType: 'FRESH', minC: 0, maxC: 4, warningBandC: 3 },
  { storageType: 'FROZEN', minC: -100, maxC: -18, warningBandC: 3 },
];

async function main(): Promise<void> {
  for (const name of Object.values(RoleName)) {
    await prisma.role.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  for (const category of DEFAULT_CATEGORIES) {
    await prisma.category.upsert({
      where: { slug: category.slug },
      update: {},
      create: category,
    });
  }

  const existingRateConfig = await prisma.settlementRateConfig.findFirst();
  if (!existingRateConfig) {
    await prisma.settlementRateConfig.create({
      data: {
        baseFee: 150,
        distanceCompensationEnabled: true,
        distanceRatePerKm: 20,
        heavyLoadThresholdLbs: 50,
        heavyLoadBonus: 200,
        peakBonus: 100,
        volumeBonusTier1Threshold: 20,
        volumeBonusTier1Amount: 1000,
        volumeBonusTier2Threshold: 40,
        volumeBonusTier2Amount: 3000,
        volumeBonusTier3Threshold: 60,
        volumeBonusTier3Amount: 5000,
      },
    });
  }

  const existingCommissionConfig = await prisma.platformCommissionConfig.findFirst();
  if (!existingCommissionConfig) {
    await prisma.platformCommissionConfig.create({
      data: { commissionRate: 0.1 },
    });
  }

  for (const template of NOTIFICATION_TEMPLATES) {
    await prisma.notificationTemplate.upsert({
      where: { eventType_channel: { eventType: template.eventType, channel: template.channel } },
      update: { subject: template.subject, body: template.body, variables: template.variables },
      create: template,
    });
  }

  for (const config of VENDOR_TIER_CONFIGS) {
    await prisma.vendorTierConfig.upsert({
      where: { tier: config.tier },
      update: config,
      create: config,
    });
  }

  for (const feature of VENDOR_TIER_FEATURES) {
    await prisma.vendorTierFeature.upsert({
      where: { tier_feature: { tier: feature.tier, feature: feature.feature } },
      update: { enabled: feature.enabled },
      create: feature,
    });
  }

  // marketplace-modes.md's own Phase 1 default: Customer Selected Vendor
  // enabled, Marketplace Fulfillment (Best Available Vendor) disabled.
  const existingModeConfig = await prisma.marketplaceModeConfig.findFirst();
  if (!existingModeConfig) {
    await prisma.marketplaceModeConfig.create({
      data: { customerSelectedEnabled: true, bestAvailableEnabled: false },
    });
  }

  // Default weight distribution follows fulfillment-strategy.md's Selection
  // Priority ordering (Inventory > Compliance > Freshness > Distance >
  // Delivery Capacity > Rating) and sums to 1.0000. Rating is weighted
  // lowest because no Review/Rating model exists yet (see docs/database-
  // design.md scoping notes) - it contributes a neutral score today.
  const existingWeightConfig = await prisma.vendorSelectionWeightConfig.findFirst();
  if (!existingWeightConfig) {
    await prisma.vendorSelectionWeightConfig.create({
      data: {
        inventoryWeight: 0.3,
        complianceWeight: 0.2,
        freshnessWeight: 0.2,
        distanceWeight: 0.15,
        deliveryCapacityWeight: 0.1,
        ratingWeight: 0.05,
      },
    });
  }

  for (const zone of DELIVERY_ZONES) {
    const upsertedZone = await prisma.deliveryZone.upsert({
      where: { code: zone.code },
      update: { name: zone.name },
      create: { code: zone.code, name: zone.name },
    });

    for (const parish of zone.parishes) {
      await prisma.deliveryZoneParish.upsert({
        where: { parish },
        update: { zoneId: upsertedZone.id },
        create: { parish, zoneId: upsertedZone.id },
      });
    }
  }

  for (const species of SPECIES) {
    await prisma.species.upsert({
      where: { scientificName: species.scientificName },
      update: { commercialName: species.commercialName, regulatoryStatus: species.regulatoryStatus },
      create: species,
    });
  }

  for (const authority of REGULATORY_AUTHORITIES) {
    await prisma.regulatoryAuthority.upsert({
      where: { name: authority.name },
      update: { country: authority.country },
      create: authority,
    });
  }

  for (const threshold of TEMPERATURE_THRESHOLDS) {
    const existing = await prisma.temperatureThreshold.findFirst({
      where: { deviceId: null, storageType: threshold.storageType },
    });
    if (!existing) {
      await prisma.temperatureThreshold.create({ data: threshold });
    }
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
