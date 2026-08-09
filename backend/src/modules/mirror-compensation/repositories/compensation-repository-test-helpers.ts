import { randomUUID } from 'crypto';

import { Category, RoleName, Vendor } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { CategoriesRepository } from '../../products/repositories/categories.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CreateCompensationInput } from './compensation.repository';

// Shared plumbing for CompensationRepository's real-Postgres specs
// (compensation.repository.spec.ts and
// compensation-resolution.repository.spec.ts). No assertions or business
// scenarios belong in this file - only fixture setup/cleanup and unique
// ID generation, matching inventory-reservations.redis-test-helpers.ts's
// established role for the Redis-side specs.

export interface CompensationTestFixture {
  prisma: PrismaService;
  vendor: Vendor;
  category: Category;
  userIds: string[];
}

// Idempotent, matching prisma/seed.ts's own role.upsert convention -
// these specs must not depend on the application seed script having been
// run first. Safe to call repeatedly/concurrently across spec files: a
// second upsert against an already-existing role is a no-op write, never
// a duplicate-row error.
async function ensureRole(prisma: PrismaService, name: RoleName): Promise<{ id: string }> {
  return prisma.role.upsert({ where: { name }, update: {}, create: { name } });
}

export async function setUpCompensationFixture(prisma: PrismaService): Promise<CompensationTestFixture> {
  const usersRepository = new UsersRepository(prisma);
  const vendorsRepository = new VendorsRepository(prisma);
  const categoriesRepository = new CategoriesRepository(prisma);

  const vendorRole = await ensureRole(prisma, RoleName.VENDOR);
  const vendorUser = await usersRepository.create({
    email: `compensation-repo-vendor-${randomUUID()}@example.com`,
    passwordHash: 'hashed',
    firstName: 'Vera',
    lastName: 'Vendor',
    roleId: vendorRole.id,
    emailVerificationTokenHash: 'token-hash',
    emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
  });
  const vendor = await vendorsRepository.create({
    userId: vendorUser.id,
    businessName: "Vera's Catch",
    parish: 'KINGSTON',
    termsAcceptedAt: new Date(),
  });
  const category = await categoriesRepository.create({
    name: `Compensation Repo Category ${randomUUID()}`,
    slug: `compensation-repo-category-${randomUUID()}`,
  });

  return { prisma, vendor, category, userIds: [vendorUser.id] };
}

export async function tearDownCompensationFixture(fixture: CompensationTestFixture): Promise<void> {
  const { prisma, vendor, category, userIds } = fixture;
  const products = await prisma.product.findMany({ where: { vendorId: vendor.id }, select: { id: true } });
  await prisma.cartReservationCompensation.deleteMany({
    where: { productId: { in: products.map((p) => p.id) } },
  });
  for (const id of userIds) {
    await prisma.user.delete({ where: { id } });
  }
  await prisma.category.delete({ where: { id: category.id } });
}

export async function seedCartAndProduct(
  fixture: CompensationTestFixture,
): Promise<{ cartId: string; productId: string; customerId: string }> {
  const { prisma, vendor, category, userIds } = fixture;
  const usersRepository = new UsersRepository(prisma);
  const cartRepository = new CartRepository(prisma);
  const productsRepository = new ProductsRepository(prisma);

  const customerRole = await ensureRole(prisma, RoleName.CUSTOMER);
  const customer = await usersRepository.create({
    email: `compensation-repo-customer-${randomUUID()}@example.com`,
    passwordHash: 'hashed',
    firstName: 'Cara',
    lastName: 'Customer',
    roleId: customerRole.id,
    emailVerificationTokenHash: 'token-hash',
    emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
  });
  userIds.push(customer.id);

  const cart = await cartRepository.findOrCreateByCustomerId(customer.id);
  const product = await productsRepository.create({
    vendorId: vendor.id,
    categoryId: category.id,
    name: 'Fresh Snapper',
    description: 'Caught this morning off the north coast.',
    unit: 'PER_POUND',
    price: 850,
    quantityAvailable: 10,
    imageUrl: 'https://cdn.example.com/snapper.jpg',
  });

  return { cartId: cart.id, productId: product.id, customerId: customer.id };
}

export function baseCreateInput(overrides: Partial<CreateCompensationInput> = {}): CreateCompensationInput {
  return {
    operation: 'RESERVE_MIRROR',
    cartId: overrides.cartId!,
    productId: overrides.productId!,
    customerId: overrides.customerId ?? null,
    desiredQuantity: overrides.desiredQuantity ?? 5,
    reasonCode: overrides.reasonCode ?? 'UNKNOWN_INFRA_FAILURE',
    lastError: overrides.lastError ?? 'sanitized failure',
  };
}
