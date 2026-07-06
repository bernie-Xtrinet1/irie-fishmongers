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
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
