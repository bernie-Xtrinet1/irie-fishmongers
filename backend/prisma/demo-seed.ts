/**
 * Demo seed for the GitHub Codespaces / devcontainer demonstration environment.
 *
 * Creates safe, clearly-fictitious login accounts (one per role) plus a small
 * amount of showcase data (an approved vendor with products, an approved
 * online driver) so a reviewer can exercise the full workflow immediately
 * after the one-click startup.
 *
 * This is DEMONSTRATION data only:
 *  - every account uses an @demo.iriefishmongers.test address (non-routable),
 *  - passwords are throwaway demo values documented in .devcontainer/README.md,
 *  - the script is idempotent (safe to re-run; it upserts by email), so it
 *    doubles as the demo "reset data" step.
 *
 * It must never run against production. Run it only after the reference seed
 * (`npm run prisma:seed -w backend`) has populated roles/categories/zones.
 */
import * as bcrypt from 'bcrypt';
import { PrismaClient, RoleName, UserStatus } from '@prisma/client';

const prisma = new PrismaClient();

// Documented in .devcontainer/README.md. Demo-only; not real credentials.
const DEMO_PASSWORD = 'DemoPass!23';
const DEMO_DOMAIN = 'demo.iriefishmongers.test';

interface DemoAccount {
  email: string;
  firstName: string;
  lastName: string;
  role: RoleName;
}

const ACCOUNTS: DemoAccount[] = [
  { email: `admin@${DEMO_DOMAIN}`, firstName: 'Ada', lastName: 'Admin', role: RoleName.ADMINISTRATOR },
  { email: `vendor@${DEMO_DOMAIN}`, firstName: 'Vera', lastName: 'Vendor', role: RoleName.VENDOR },
  { email: `customer@${DEMO_DOMAIN}`, firstName: 'Cory', lastName: 'Customer', role: RoleName.CUSTOMER },
  { email: `driver@${DEMO_DOMAIN}`, firstName: 'Dana', lastName: 'Driver', role: RoleName.DRIVER },
];

async function upsertAccount(account: DemoAccount, passwordHash: string): Promise<string> {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: account.role } });
  const user = await prisma.user.upsert({
    where: { email: account.email },
    update: { status: UserStatus.ACTIVE, firstName: account.firstName, lastName: account.lastName },
    create: {
      email: account.email,
      passwordHash,
      firstName: account.firstName,
      lastName: account.lastName,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: role.id } },
    update: {},
    create: { userId: user.id, roleId: role.id },
  });
  return user.id;
}

async function seedVendor(userId: string): Promise<void> {
  const vendor = await prisma.vendor.upsert({
    where: { userId },
    update: { status: 'APPROVED' },
    create: {
      userId,
      businessName: 'Demo Harbour Seafood',
      description: 'Fresh catch from Kingston Harbour - demonstration vendor.',
      parish: 'KINGSTON',
      status: 'APPROVED',
      tier: 'COMMUNITY_FISHER',
      termsAcceptedAt: new Date(),
    },
  });

  const existingProducts = await prisma.product.count({ where: { vendorId: vendor.id } });
  if (existingProducts > 0) {
    return;
  }

  const category = await prisma.category.findFirst({ orderBy: { name: 'asc' } });
  if (!category) {
    throw new Error('No category found - run the reference seed (prisma:seed) before the demo seed.');
  }

  await prisma.product.createMany({
    data: [
      {
        vendorId: vendor.id,
        categoryId: category.id,
        name: 'Fresh Red Snapper',
        description: 'Whole red snapper, landed this morning.',
        unit: 'PER_POUND',
        price: 950,
        quantityAvailable: 40,
        imageUrl: 'https://placehold.co/600x400?text=Red+Snapper',
      },
      {
        vendorId: vendor.id,
        categoryId: category.id,
        name: 'Jumbo Shrimp',
        description: 'Peeled and deveined jumbo shrimp.',
        unit: 'PER_POUND',
        price: 1650,
        quantityAvailable: 25,
        imageUrl: 'https://placehold.co/600x400?text=Jumbo+Shrimp',
      },
      {
        vendorId: vendor.id,
        categoryId: category.id,
        name: 'Fresh Lobster',
        description: 'Live Caribbean spiny lobster.',
        unit: 'PER_ITEM',
        price: 2800,
        quantityAvailable: 12,
        imageUrl: 'https://placehold.co/600x400?text=Lobster',
      },
    ],
  });
}

async function seedDriver(userId: string): Promise<void> {
  await prisma.driver.upsert({
    where: { userId },
    update: { status: 'APPROVED', availabilityStatus: 'ONLINE' },
    create: {
      userId,
      licensePlate: 'DEMO-001',
      vehicleType: 'CAR',
      vehicleOwnership: 'PERSONAL_VEHICLE',
      status: 'APPROVED',
      availabilityStatus: 'ONLINE',
      capacityLbs: 200,
      coldChainCapable: true,
    },
  });
}

async function main(): Promise<void> {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const ids = new Map<RoleName, string>();
  for (const account of ACCOUNTS) {
    ids.set(account.role, await upsertAccount(account, passwordHash));
  }

  await seedVendor(ids.get(RoleName.VENDOR)!);
  await seedDriver(ids.get(RoleName.DRIVER)!);

  // eslint-disable-next-line no-console
  console.log(
    [
      'Demo data seeded. Accounts (password for all: ' + DEMO_PASSWORD + '):',
      ...ACCOUNTS.map((a) => `  ${a.role.padEnd(13)} ${a.email}`),
    ].join('\n'),
  );
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
