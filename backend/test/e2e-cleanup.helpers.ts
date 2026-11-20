import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  ProductUnit,
  SeafoodPricingBasis,
  UsablePartsPreference,
  WeightUnit,
} from '@prisma/client';

import { PrismaService } from '../src/database/prisma.service';
import { CheckoutQuoteService } from '../src/modules/orders/services/checkout-quote.service';

// Shared E2E teardown helper.
//
// The durable add-item idempotency feature (commit ccf2dc6) introduced
// customer-owned child rows that must be removed before a customer User row
// can be deleted, because their foreign keys use onDelete: Restrict:
//   - cart_item_add_attempts.customerId    -> users.id   (Restrict)
//   - checkout_attempts.customerId         -> users.id   (Restrict)
//   - cart_reservation_sync_state.cartId   -> carts.id   (Restrict)
//     (the customer's Cart is itself cascade-deleted with the User, but that
//      cascade is blocked while a sync-state row still references the Cart)
//
// Every affected suite creates these rows via its now-working add-to-cart /
// checkout calls, so each suite's afterAll must clear them first. Cleanup is
// scoped strictly to the suite's own customers (by email) - never a global
// table truncation.
export async function cleanupCustomerCartArtifacts(
  prisma: PrismaService,
  customerEmails: string[],
): Promise<void> {
  if (customerEmails.length === 0) {
    return;
  }
  await prisma.cartItemAddAttempt.deleteMany({
    where: { customer: { email: { in: customerEmails } } },
  });
  await prisma.checkoutAttempt.deleteMany({
    where: { customer: { email: { in: customerEmails } } },
  });
  await prisma.cartReservationSyncState.deleteMany({
    where: { cart: { customer: { email: { in: customerEmails } } } },
  });
}

// Provisions an authoritative VendorDailyListing (if absent) and issues a
// valid HMAC-signed CheckoutQuoteService token for legacy E2E specs that add
// a lot-linked Product directly via HTTP before calling /orders/checkout.
export async function prepareCatchWeightCheckoutQuote(
  app: INestApplication,
  productId: string,
  createdCatalogueIds?: string[],
): Promise<string> {
  const prisma = app.get(PrismaService);
  const quoteService = app.get(CheckoutQuoteService);
  const configService = app.get(ConfigService);

  let cartItem = await prisma.cartItem.findFirstOrThrow({
    where: { productId },
    include: { cart: true, product: { include: { lot: true } } },
    orderBy: { createdAt: 'desc' },
  });
  if (cartItem.mutationVersion <= 0) {
    cartItem = await prisma.cartItem.update({
      where: { id: cartItem.id },
      data: { mutationVersion: 1 },
      include: { cart: true, product: { include: { lot: true } } },
    });
  }

  if (!cartItem.product.lot) {
    throw new Error(`Product "${productId}" has no linked SeafoodLot for catch-weight quote preparation`);
  }
  const lot = cartItem.product.lot;

  let listing = await prisma.vendorDailyListing.findFirst({
    where: { productId: cartItem.productId, lotId: lot.id, status: 'PUBLISHED' },
    orderBy: { createdAt: 'desc' },
  });

  if (!listing) {
    const catalogueItem = await prisma.seafoodCatalogueItem.create({
      data: {
        name: cartItem.product.name,
        commonName: lot.species,
        categoryId: cartItem.product.categoryId,
        compositionMode: 'UNVERIFIED_COMPOSITION',
        lifecycleStatus: 'PUBLISHED',
      },
    });
    createdCatalogueIds?.push(catalogueItem.id);

    listing = await prisma.vendorDailyListing.create({
      data: {
        vendorId: cartItem.product.vendorId,
        productId: cartItem.product.id,
        catalogueItemId: catalogueItem.id,
        lotId: lot.id,
        listingTitle: cartItem.product.name,
        catchDate: lot.catchDate,
        expiresAt: new Date(Date.now() + 86_400_000),
        unit: cartItem.product.unit,
        price: cartItem.product.price,
        quantityUploaded: new Prisma.Decimal('20.00'),
        quantityAvailable: new Prisma.Decimal('20.00'),
        quantityReserved: new Prisma.Decimal('0.00'),
        quantitySold: new Prisma.Decimal('0.00'),
        status: 'PUBLISHED',
      },
    });
  }

  const unitPriceDec = new Prisma.Decimal(cartItem.product.price.toString());
  const itemTotalStr = unitPriceDec.mul(cartItem.quantity).toFixed(2);
  const cartRevisionHash = quoteService.computeCartRevisionHash([
    {
      id: cartItem.id,
      productId: cartItem.productId,
      quantity: cartItem.quantity,
      mutationVersion: cartItem.mutationVersion,
    },
  ]);

  return quoteService.issueQuoteToken(
    {
      authenticatedCustomerId: cartItem.cart.customerId,
      cartId: cartItem.cartId,
      cartRevisionHash,
      items: [
        {
          cartItemId: cartItem.id,
          productId: cartItem.productId,
          mutationVersion: cartItem.mutationVersion,
          listingId: listing.id,
          lotId: lot.id,
          vendorId: cartItem.product.vendorId,
          species: lot.species,
          productTitle: cartItem.product.name,
          productDescription: cartItem.product.description,
          pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
          unit: ProductUnit.PER_POUND,
          unitPrice: unitPriceDec.toFixed(2),
          currency: 'JMD',
          pieceCount: cartItem.quantity,
          estimatedBillableWeight: cartItem.quantity,
          weightUnit: WeightUnit.POUNDS,
          fishCount: cartItem.quantity,
          originalWholeWeightLbs: cartItem.quantity,
          originalWholeWeightUnit: WeightUnit.POUNDS,
          usablePartsPreference: UsablePartsPreference.RETURN_USABLE_PARTS,
          estimatedProductSubtotal: itemTotalStr,
          estimatedPreparationFee: '0.00',
          estimatedItemTotal: itemTotalStr,
          minimumAuthorizedCeilingJmd: itemTotalStr,
          customerAuthorizedCeilingJmd: itemTotalStr,
        },
      ],
      termsVersion: 'v2026.10',
      ttlMs: 15 * 60 * 1000,
    },
    configService.getOrThrow<string>('CHECKOUT_QUOTE_SIGNING_SECRET'),
  );
}
