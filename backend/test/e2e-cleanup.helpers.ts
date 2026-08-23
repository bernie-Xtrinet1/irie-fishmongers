import { PrismaService } from '../src/database/prisma.service';

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
