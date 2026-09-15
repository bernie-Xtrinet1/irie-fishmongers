import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { RedisService } from '../../../common/redis/redis.service';
import { openAcquisitionSchema } from '../../checkout/services/checkout-acquisition-test-helpers';
import { setUpCompensationFixture } from '../../mirror-compensation/repositories/compensation-repository-test-helpers';
import { withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { transitionTuple } from '../../reservation-fence/repositories/reservation-fence.repository';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY, resourceGuardKey } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { OrdinaryReservationService } from './ordinary-reservation.service';
import { InventoryReservationsService } from './inventory-reservations.service';
import { cleanupKeys, trackKeysFor } from './inventory-reservations.redis-test-helpers';

// Supplies explicit durable intent for the existing accounting scenarios.
// These scenarios exercise same-generation quantities; real CartService-style
// generation advancement is covered separately by ordinary-reservation.integration.
export async function openOrdinaryAccountingFixture(redis: Redis) {
  const schema = await openAcquisitionSchema();
  const prisma = schema.prisma, keys = new Set<string>();
  try {
    const base = await setUpCompensationFixture(prisma);
    const role = await prisma.role.upsert({ where: { name: 'CUSTOMER' }, update: {}, create: { name: 'CUSTOMER' } });
    const mode = await prisma.reservationEngineModeConfig.create({ data: { mode: 'CART_SCOPED', updatedById: base.userIds[0]! } });
    const fence = await prisma.reservationFenceTransition.create({ data: { incarnation: randomUUID(), epoch: 1,
      revision: 1, phase: 'OPEN', protocol: 1, status: 'ACKNOWLEDGED', acknowledgedAt: new Date(),
      mode: 'CART_SCOPED', modeRevision: mode.revision, reason: 'OPEN', actorId: randomUUID() } });
    keys.add(RESERVATION_FENCE_KEY); keys.add(MUTATION_HISTORY_KEY);
    await redis.set(RESERVATION_FENCE_KEY, JSON.stringify(transitionTuple(fence)));
    await redis.hset(MUTATION_HISTORY_KEY, 'incarnation', fence.incarnation);
    const adapter = new RedisService(redis), service = new InventoryReservationsService(adapter);
    Object.assign(service, { ordinary: new OrdinaryReservationService(prisma, adapter) });
    return {
      service,
      async reserveWithIntent(cartId: string, productId: string, customerId: string, quantity: number) {
        await prisma.user.upsert({ where: { id: customerId }, update: {}, create: { id: customerId,
          email: `${customerId}@example.com`, passwordHash: 'fixture', firstName: 'Test', lastName: 'Customer',
          roles: { create: [{ roleId: role.id }] } } });
        await prisma.cart.upsert({ where: { id: cartId }, update: {}, create: { id: cartId, customerId } });
        await prisma.product.upsert({ where: { id: productId }, update: {}, create: { id: productId,
          vendorId: base.vendor.id, categoryId: base.category.id, name: 'Fixture', description: 'Fixture',
          unit: 'PER_POUND', price: 850, quantityAvailable: 100, imageUrl: 'https://example.com/fixture.jpg' } });
        const marker = await prisma.cartReservationSyncState.upsert({ where: { cartId_productId: { cartId, productId } },
          create: { cartId, productId, generation: 0, expectedQuantity: quantity, expectedMutationVersion: 1 },
          update: { expectedQuantity: quantity } });
        keys.add(resourceGuardKey(marker.id)); trackKeysFor(keys, cartId, productId);
        return service.reserveOrRenew(cartId, productId, customerId, quantity);
      },
      close: () => withCleanup(async () => {}, [() => cleanupKeys(redis, keys), () => schema.close()]),
    };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('Ordinary accounting fixture setup failed');
    return withCleanup(() => Promise.reject(failure), [() => cleanupKeys(redis, keys), () => schema.close()]);
  }
}
