import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import {
  ACTIVE_RESTRICTION_STATES,
  BLOCKING_RECOVERY_STATES,
  ProductRestrictionControl,
  productControlKey,
} from '../../reservation-fence/types/product-reservation-restriction.types';
import { UUID_PATTERN } from '../../reservation-fence/types/reservation-fence.types';
import { productSuspectKey } from '../constants/inventory.constants';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseAllowControl(raw: string, productId: string): ProductRestrictionControl | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || Object.keys(parsed).length !== 7) return null;
    if (
      parsed.version !== 1 ||
      parsed.productId !== productId ||
      parsed.state !== 'ALLOW' ||
      parsed.restrictionId !== null ||
      !Number.isInteger(parsed.restrictionRevision) ||
      (parsed.restrictionRevision as number) < 0 ||
      (parsed.restrictionRevision as number) % 2 !== 0 ||
      typeof parsed.incarnation !== 'string' ||
      !UUID_PATTERN.test(parsed.incarnation) ||
      !Number.isInteger(parsed.epoch) ||
      (parsed.epoch as number) <= 0
    ) {
      return null;
    }
    return parsed as unknown as ProductRestrictionControl;
  } catch {
    return null;
  }
}

function parseFenceBinding(raw: string): { incarnation: string; epoch: number } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (
      typeof parsed.incarnation !== 'string' ||
      !UUID_PATTERN.test(parsed.incarnation) ||
      !Number.isInteger(parsed.epoch) ||
      (parsed.epoch as number) <= 0
    ) {
      return null;
    }
    return { incarnation: parsed.incarnation, epoch: parsed.epoch as number };
  } catch {
    return null;
  }
}

/**
 * Verifies read-only W3-P control, suspect flag, and PG/Redis cross-store consistency
 * before CART_SCOPED availability computation returns an available quantity.
 */
export async function isAvailabilityControlClear(
  redis: RedisService,
  prisma: PrismaService | undefined,
  productId: string,
): Promise<boolean> {
  const controlKey = productControlKey(productId);
  const rawControl = await redis.get(controlKey);

  let parsedControl: ProductRestrictionControl | null = null;
  let redisFence: { incarnation: string; epoch: number } | null = null;

  if (rawControl !== null) {
    parsedControl = parseAllowControl(rawControl, productId);
    if (!parsedControl) return false;

    const redisCompat = redis as unknown as {
      pttl?: (k: string) => Promise<number>;
      getClient?: () => { pttl?: (k: string) => Promise<number> };
    };
    const clientObj = typeof redisCompat.getClient === 'function' ? redisCompat.getClient() : undefined;
    if (typeof redisCompat.pttl === 'function') {
      if ((await redisCompat.pttl(controlKey)) !== -1) return false;
    } else if (clientObj && typeof clientObj.pttl === 'function') {
      if ((await clientObj.pttl(controlKey)) !== -1) return false;
    }

    const rawFence = await redis.get(RESERVATION_FENCE_KEY);
    if (rawFence !== null) {
      redisFence = parseFenceBinding(rawFence);
      if (!redisFence) return false;
      if (redisFence.incarnation !== parsedControl.incarnation || redisFence.epoch !== parsedControl.epoch) {
        return false;
      }
    }
  }

  const suspended = await redis.get(productSuspectKey(productId));
  if (suspended !== null) return false;

  if (!prisma) return true;

  const [activeRestriction, blockingRecovery, completedRecovery, clearedRestriction, latestFence] = await Promise.all([
    prisma.productReservationRestriction.findFirst({
      where: { productId, state: { in: [...ACTIVE_RESTRICTION_STATES] } },
      select: { id: true },
    }),
    prisma.productSuspectRecovery.findFirst({
      where: { productId, status: { in: [...BLOCKING_RECOVERY_STATES] } },
      select: { id: true },
    }),
    prisma.productSuspectRecovery.findFirst({
      where: { productId, status: 'COMPLETED' },
      orderBy: { clearedControlRevision: 'desc' },
      select: { clearedControlRevision: true, incarnation: true, fenceEpoch: true },
    }),
    prisma.productReservationRestriction.findFirst({
      where: { productId, state: 'CLEARED' },
      orderBy: { restrictionRevision: 'desc' },
      select: { restrictionRevision: true },
    }),
    prisma.reservationFenceTransition.findFirst({
      orderBy: { revision: 'desc' },
      select: { incarnation: true, epoch: true, status: true },
    }),
  ]);

  if (activeRestriction || blockingRecovery) return false;
  if (clearedRestriction && !completedRecovery) return false;

  const expectedClearedRevision = completedRecovery?.clearedControlRevision ?? 0;
  if ((completedRecovery || clearedRestriction) && !parsedControl) {
    return false;
  }

  if (parsedControl) {
    if (parsedControl.restrictionRevision !== expectedClearedRevision) return false;
    if (latestFence && (latestFence.incarnation !== parsedControl.incarnation || latestFence.epoch !== parsedControl.epoch)) {
      return false;
    }
  }

  if (redisFence && latestFence) {
    if (redisFence.incarnation !== latestFence.incarnation || redisFence.epoch !== latestFence.epoch) {
      return false;
    }
  }

  return true;
}
