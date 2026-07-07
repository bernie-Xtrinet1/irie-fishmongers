import { NotificationChannel, NotificationEventType, PrismaClient, RoleName } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_CATEGORIES = [
  { name: 'Fish', slug: 'fish' },
  { name: 'Shellfish', slug: 'shellfish' },
  { name: 'Crustaceans', slug: 'crustaceans' },
  { name: 'Mollusks', slug: 'mollusks' },
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
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
