import { PrismaService } from '../../../database/prisma.service';
import { RESERVATION_OBSERVATION_SCRIPT } from '../lua/reservation-observation-lua';
import {
  OBSERVATION_LIMIT,
  RESTRICTION_STATE_FINDINGS,
  ReservationObservation,
  parseObservedControlState,
  parseRedisObservation,
  uncertainObservation,
} from '../types/reservation-observation.types';
import {
  BLOCKING_RECOVERY_STATES,
  controlBytes,
  productControlKey,
  restrictionDigest,
} from '../../reservation-fence/types/product-reservation-restriction.types';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { transitionTuple } from '../../reservation-fence/repositories/reservation-fence.repository';
import { OrdinaryReservationService } from './ordinary-reservation.service';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { RedisService } from '../../../common/redis/redis.service';
import {
  RESERVATION_HASH_TTL_SECONDS,
  RESERVATION_TTL_SECONDS,
  cartIndexKey,
  productIndexKey,
  productSuspectKey,
  productTotalKey,
  reservationHashKey,
  reservationKey,
} from '../constants/inventory.constants';
import {
  RELEASE_RESERVATION_SCRIPT,
} from '../lua/reservation-lua-scripts';
import {
  RawScriptUnderflow,
  parseScriptResult,
  toUnderflowDetails,
} from './inventory-reservations-script-helpers';
import { observeReservation, ReservationReadObservation, ReservedTotalObservation } from './reservation-read-observation';
import { ReservationUnderflowDetails } from './reservation-accounting.types';
import { isAvailabilityControlClear } from './inventory-availability-control.helper';

interface ReservationEntry {
  quantity: number;
  expiresAt: number;
}

// --- Cart-scoped reservation model (additive; see
// docs/architecture/reservation-lifecycle.md). Not wired to any caller yet -
// CartService/OrdersService/ProductsService continue using the legacy
// methods above unchanged. ---

export type CartReservationStatus = 'ACTIVE' | 'CHECKOUT_PENDING';

export interface CartScopedReservationEntry {
  version: number;
  quantity: number;
  cartId: string;
  customerId: string;
  status: CartReservationStatus;
  createdAt: number;
  lastRenewedAt: number;
  expiresAt: number;
  absoluteExpiresAt: number;
  checkoutIdempotencyKey: string | null;
  checkoutPendingAt: number | null;
  checkoutPendingExpiresAt: number | null;
}

export interface ReserveOrRenewSuccess {
  entry: CartScopedReservationEntry;
  underflow: ReservationUnderflowDetails | null;
}

export type ReserveOrRenewOutcome =
  | { ok: true; result: ReserveOrRenewSuccess }
  | { ok: false; code: 'RESERVATION_CHECKOUT_IN_PROGRESS' }
  | { ok: false; code: 'RESERVATION_PRODUCT_SUSPENDED' }
  | { ok: false; code: 'RESERVATION_ACCOUNTING_UNDERFLOW' }
  | { ok: false; code: 'RESERVATION_ACCOUNTING_CORRUPTION' }
  | { ok: false; code: 'RESERVATION_RESOURCE_GENERATION_MISMATCH' }
  | { ok: false; code: 'RESERVATION_MALFORMED_RESOURCE' }
  | { ok: false; code: 'FENCE_REJECTED' | 'UNCERTAIN_INFRASTRUCTURE' };

export interface ReleaseReservationResult {
  released: boolean;
  quantity: number;
  underflow: ReservationUnderflowDetails | null;
}

interface RawReleaseReservationResult {
  ok: true;
  released: boolean;
  quantity: number;
  underflow?: RawScriptUnderflow | null;
}

export type ProductTotalDriftDirection = 'NO_DRIFT' | 'OVERCOUNT' | 'UNDERCOUNT';

// The one shared result shape for the suspect-aware availability
// calculation (see computeAvailabilityInternal below). SUSPECT means
// productSuspectKey is currently set - the quantity accounting for this
// product cannot be trusted, so no numeric available value is produced at
// all here (callers that need a zero-collapsed number use
// computeAvailableToPurchase instead).
export type SuspectAwareAvailability = { status: 'OK'; available: number } | { status: 'SUSPECT' };



/**
 * Redis-backed soft holds on stock, keyed per product as a hash of
 * cartId -> { quantity, expiresAt }. Expiry is enforced by comparing
 * `expiresAt` against the current time on every read (not by relying on
 * Redis's own per-key TTL), so correctness never depends on Redis's
 * eviction timing. Deliberately takes `quantityAvailable` as a parameter
 * rather than looking the product up itself - see the plan's "Avoiding
 * circular module dependencies" section.
 */
@Injectable()
export class InventoryReservationsService {
  private readonly logger = new Logger(InventoryReservationsService.name);

  @Inject(OrdinaryReservationService)
  private readonly ordinary!: OrdinaryReservationService;

  @Inject(PrismaService)
  private readonly observationPrisma!: PrismaService;

  constructor(private readonly redis: RedisService) {}

  async getReservedByOthers(productId: string, excludingCartId: string): Promise<number> {
    const active = await this.readActiveEntries(productId);
    let total = 0;
    for (const [cartId, entry] of Object.entries(active)) {
      if (cartId !== excludingCartId) {
        total += entry.quantity;
      }
    }
    return total;
  }

  async getAvailableToPurchase(
    productId: string,
    quantityAvailable: number,
    excludingCartId: string,
  ): Promise<number> {
    const reservedByOthers = await this.getReservedByOthers(productId, excludingCartId);
    return Math.max(0, quantityAvailable - reservedByOthers);
  }

  async reserve(productId: string, cartId: string, quantity: number): Promise<void> {
    const key = reservationHashKey(productId);
    const entry: ReservationEntry = {
      quantity,
      expiresAt: Date.now() + RESERVATION_TTL_SECONDS * 1000,
    };
    await this.redis.hset(key, cartId, JSON.stringify(entry));
    await this.redis.expire(key, RESERVATION_HASH_TTL_SECONDS);
  }

  async release(productId: string, cartId: string): Promise<void> {
    await this.redis.hdel(reservationHashKey(productId), cartId);
  }

  private async readActiveEntries(productId: string): Promise<Record<string, ReservationEntry>> {
    const raw = await this.redis.hgetall(reservationHashKey(productId));
    const now = Date.now();
    const active: Record<string, ReservationEntry> = {};

    for (const [cartId, value] of Object.entries(raw)) {
      const entry = JSON.parse(value) as ReservationEntry;
      if (entry.expiresAt > now) {
        active[cartId] = entry;
      }
    }

    return active;
  }

  // --- Cart-scoped reservation model (additive, not yet wired to any
  // caller - see the block comment above the type declarations). ---

  async reserveOrRenew(cartId: string, productId: string, customerId: string, quantity: number): Promise<ReserveOrRenewOutcome> {
    const outcome = await this.ordinary.reserve(cartId, productId, customerId, quantity);
    if (outcome.code === 'ACCEPTED') return { ok: true, result: { entry: outcome.value, underflow: null } };
    if (outcome.code === 'DOMAIN_FAILURE' && outcome.reason === 'RESERVATION_PRODUCT_SUSPENDED') {
      return { ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' };
    }
    if (outcome.code === 'INFRASTRUCTURE_FAILURE') {
      return { ok: false, code: 'UNCERTAIN_INFRASTRUCTURE' };
    }
    if (outcome.code === 'FENCE_REJECTED') {
      switch (outcome.reason) {
        case 'ACCOUNTING_UNDERFLOW':
          this.logger.warn('RESERVATION_TOTAL_UNDERFLOW during reserveOrRenew', {
            productId,
            cartId,
            reason: outcome.reason,
          });
          return { ok: false, code: 'RESERVATION_ACCOUNTING_UNDERFLOW' };
        case 'ACCOUNTING_CORRUPTION':
          this.logger.warn('RESERVATION_ACCOUNTING_CORRUPTION during reserveOrRenew', {
            productId,
            cartId,
            reason: outcome.reason,
          });
          return { ok: false, code: 'RESERVATION_ACCOUNTING_CORRUPTION' };
        case 'RESOURCE_GENERATION_MISMATCH':
          return { ok: false, code: 'RESERVATION_RESOURCE_GENERATION_MISMATCH' };
        case 'MALFORMED_RESOURCE':
        case 'MALFORMED_RESOURCE_GUARD':
          return { ok: false, code: 'RESERVATION_MALFORMED_RESOURCE' };
        case 'CHECKOUT_IN_PROGRESS':
          return { ok: false, code: 'RESERVATION_CHECKOUT_IN_PROGRESS' };
        case 'CAPABILITY_REVOKED':
          return { ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' };
        default:
          return { ok: false, code: 'FENCE_REJECTED' };
      }
    }
    return { ok: false, code: 'FENCE_REJECTED' };
  }

  // Freshness resets require a separate authorization. Never bypass W1 fencing
  // or silently substitute a rolling renewal for the administrative hard reset.
  reserveWithFreshEpoch(_cartId: string, _productId: string, _customerId: string, _quantity: number): Promise<ReserveOrRenewOutcome> {
    return Promise.resolve({ ok: false, code: 'FENCE_REJECTED' });
  }

  async releaseReservation(cartId: string, productId: string): Promise<ReleaseReservationResult> {
    const now = Date.now();
    const keys = [
      reservationKey(cartId, productId),
      cartIndexKey(cartId),
      productIndexKey(productId),
      productTotalKey(productId),
      productSuspectKey(productId),
    ];
    const args = [cartId, productId];

    const raw = await this.redis.eval(RELEASE_RESERVATION_SCRIPT, keys, args);
    const parsed = parseScriptResult<RawReleaseReservationResult>(raw);

    const underflow = toUnderflowDetails(this.logger, parsed.underflow, {
      productId,
      cartId,
      operationName: 'releaseReservation',
      timestamp: now,
    });

    return { released: parsed.released, quantity: parsed.quantity, underflow };
  }

  // Observational only. Expiry grants no add-back; corruption propagates as
  // untrusted availability. No suspect marker, indexes or totals are repaired.
  // Redis failures reject the read rather than becoming ABSENT observations.
  async getActiveReservation(cartId: string, productId: string): Promise<ReservationReadObservation> {
    const raw = await this.redis.get(reservationKey(cartId, productId));
    return observeReservation(raw, cartId, Date.now());
  }

  async getReservedTotalExcludingCart(productId: string, excludingCartId: string): Promise<ReservedTotalObservation> {
    const rawTotal = await this.redis.get(productTotalKey(productId));
    const total = rawTotal === null ? 0 : Number(rawTotal);
    if (!Number.isSafeInteger(total) || total < 0 || (rawTotal !== null && !/^\d+$/.test(rawTotal)))
      return { status: 'SUSPECT' };
    let ownQuantity = 0;
    if (excludingCartId) {
      const observation = await this.getActiveReservation(excludingCartId, productId);
      if (observation.status === 'MALFORMED' || observation.status === 'UNTRUSTED') return { status: 'SUSPECT' };
      if (observation.status === 'ACTIVE') ownQuantity = observation.entry.quantity;
      // ABSENT/EXPIRED grant no add-back. Retained totals are not repaired.
    }
    if (ownQuantity > total) return { status: 'SUSPECT' };
    return { status: 'OK', reservedByOthers: total - ownQuantity };
  }

  // Numeric compatibility boundary: SUSPECT collapses to conservative zero.
  // Richer callers retain the distinction through getAvailabilityWithSuspectStatus.
  async computeAvailableToPurchase(
    productId: string,
    quantityAvailable: number,
    excludingCartId: string,
  ): Promise<number> {
    const result = await this.computeAvailabilityInternal(productId, quantityAvailable, excludingCartId);
    return result.status === 'SUSPECT' ? 0 : result.available;
  }

  // Richer form of computeAvailableToPurchase for callers (Phase 16A.0-C2's
  // ReservationAvailabilityService) that must distinguish "genuinely zero"
  // from "suspect, no trustworthy number available" rather than have both
  // collapse to the same 0. Shares computeAvailabilityInternal with
  // computeAvailableToPurchase - the suspect-flag read, product-total read,
  // own-cart add-back, and zero-floor arithmetic exist in exactly one
  // place.
  async getAvailabilityWithSuspectStatus(
    productId: string,
    quantityAvailable: number,
    excludingCartId: string,
  ): Promise<SuspectAwareAvailability> {
    return this.computeAvailabilityInternal(productId, quantityAvailable, excludingCartId);
  }

  private async computeAvailabilityInternal(
    productId: string,
    quantityAvailable: number,
    excludingCartId: string,
  ): Promise<SuspectAwareAvailability> {
    if (!Number.isInteger(quantityAvailable) || quantityAvailable < 0) return { status: 'SUSPECT' };
    if (!(await isAvailabilityControlClear(this.redis, this.observationPrisma, productId))) return { status: 'SUSPECT' };
    const observation = await this.getReservedTotalExcludingCart(productId, excludingCartId);
    if (observation.status === 'SUSPECT') return observation;
    return { status: 'OK', available: Math.max(0, quantityAvailable - observation.reservedByOthers) };
  }

  // Cross-store reads are observations, never an atomic authority snapshot.
  async observeProductReservations(productId: string, expectedCartIds: readonly string[] = []): Promise<ReservationObservation> {
    const result = uncertainObservation();
    const valid = (id: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(id);
    if (!valid(productId) || expectedCartIds.length > OBSERVATION_LIMIT || !expectedCartIds.every(valid)) return result;
    try {
      const read = async () => {
        const fence = await this.observationPrisma.reservationFenceTransition.findFirst({ orderBy: { revision: 'desc' } });
        const restriction = await this.observationPrisma.productReservationRestriction.findFirst({
          where: { productId }, orderBy: { restrictionRevision: 'desc' },
        });
        const blockingRecovery = await this.observationPrisma.productSuspectRecovery?.findFirst({
          where: { productId, status: { in: [...BLOCKING_RECOVERY_STATES] } }, orderBy: { createdAt: 'desc' },
        }) ?? null;
        const completedRecovery = await this.observationPrisma.productSuspectRecovery?.findFirst({
          where: { productId, status: 'COMPLETED' }, orderBy: { clearedControlRevision: 'desc' },
        }) ?? null;
        const activeRestriction = restriction && restriction.state !== 'CLEARED' ? restriction : null;
        const installation = fence && activeRestriction && (activeRestriction.state === 'PREPARED' || activeRestriction.state === 'ENFORCED')
          ? await this.observationPrisma.productReservationRestrictionInstallation.findUnique({
            where: { restrictionId_incarnation_epoch_protocolVersion: { restrictionId: activeRestriction.id,
              incarnation: fence.incarnation, epoch: fence.epoch, protocolVersion: fence.protocol } },
          }) : null;
        return { fence, restriction, activeRestriction, blockingRecovery, completedRecovery, installation };
      };
      const before = await read();
      const raw = await this.redis.eval(RESERVATION_OBSERVATION_SCRIPT,
        [productIndexKey(productId), productTotalKey(productId), productSuspectKey(productId),
          productControlKey(productId), RESERVATION_FENCE_KEY],
        [productId, Date.now(), OBSERVATION_LIMIT, JSON.stringify(expectedCartIds)]);
      const observed = parseRedisObservation(raw);
      const after = await read();
      result.findings = [...observed.findings];
      result.accounting = observed.accounting;
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        result.findings = [...result.findings.filter(f => f !== 'CONSISTENT'), 'INFRASTRUCTURE_UNCERTAIN'];
        return result;
      }
      const { fence, restriction, activeRestriction, blockingRecovery, completedRecovery, installation } = before;
      const resolvedClearedRev = completedRecovery?.clearedControlRevision ?? 0;
      result.restriction.durableState = restriction?.state ?? 'ABSENT';
      result.restriction.revision = activeRestriction
        ? activeRestriction.restrictionRevision
        : restriction
          ? Math.max(restriction.restrictionRevision, resolvedClearedRev)
          : completedRecovery ? resolvedClearedRev : null;
      result.restriction.observationDigest = restriction?.observationDigest ?? null;
      if (restriction && RESTRICTION_STATE_FINDINGS[restriction.state]) {
        result.findings.push(RESTRICTION_STATE_FINDINGS[restriction.state]!);
      }
      if (blockingRecovery) {
        result.findings.push(blockingRecovery.status === 'AMBIGUOUS_QUARANTINED' ? 'RECOVERY_QUARANTINED' : 'RECOVERY_ACTIVE');
      }
      const parsedControlState = parseObservedControlState(observed.control);
      if (parsedControlState) result.restriction.physicalState = parsedControlState;
      const uncertain = () => { result.findings = [...new Set([...result.findings.filter(f => f !== 'CONSISTENT'), 'MEMBERSHIP_UNCERTAIN' as const])]; };
      if (observed.control === null) result.restriction.physicalState = 'ABSENT';
      if (!fence || fence.status !== 'ACKNOWLEDGED' || fence.protocol !== 1 ||
        observed.fence !== JSON.stringify(transitionTuple(fence))) { uncertain(); return result; }
      if (parsedControlState === 'CLEARANCE_STAGED' || blockingRecovery || activeRestriction?.state === 'CLEARING') {
        uncertain(); return result;
      }
      const enforceRestricted = activeRestriction && (activeRestriction.state === 'PREPARED' || activeRestriction.state === 'ENFORCED');
      const expected = controlBytes({ version: 1, productId, state: enforceRestricted ? 'RESTRICTED' : 'ALLOW',
        restrictionId: enforceRestricted ? activeRestriction.id : null,
        restrictionRevision: enforceRestricted ? activeRestriction.restrictionRevision : resolvedClearedRev,
        incarnation: fence.incarnation, epoch: fence.epoch });
      if (observed.control !== expected) { uncertain(); return result; }
      result.restriction.physicalState = enforceRestricted ? 'RESTRICTED' : 'ALLOW';
      // This is observed equality only; a concurrent change can occur after these reads.
      result.restriction.crossStoreConsistency = 'OBSERVED_MATCH';
      if (enforceRestricted && installation?.acknowledgement === expected && installation.acknowledgementHash === restrictionDigest(expected))
        result.restriction.installation = 'MATCHES_OBSERVED_TUPLE';
      else if (enforceRestricted) uncertain();
      return result;
    } catch { return uncertainObservation(); }
  }
}
