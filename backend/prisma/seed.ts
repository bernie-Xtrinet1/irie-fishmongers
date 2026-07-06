import { PrismaClient, RoleName } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_CATEGORIES = [
  { name: 'Fish', slug: 'fish' },
  { name: 'Shellfish', slug: 'shellfish' },
  { name: 'Crustaceans', slug: 'crustaceans' },
  { name: 'Mollusks', slug: 'mollusks' },
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
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
