import { Injectable, Logger } from '@nestjs/common';

import { RedisService } from '../../../common/redis/redis.service';
import {
  MAX_RESERVATION_LIFETIME_SECONDS,
  RESERVATION_ENTRY_VERSION,
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
  RECONCILE_PRODUCT_RESERVED_TOTAL_SCRIPT,
  RELEASE_RESERVATION_SCRIPT,
  RESERVE_OR_RENEW_SCRIPT,
} from '../lua/reservation-lua-scripts';
import {
  RawScriptUnderflow,
  flagMalformedReservation,
  parseScriptResult,
  toUnderflowDetails,
} from './inventory-reservations-script-helpers';
import { ReservationUnderflowDetails } from './reservation-accounting.types';

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
  | { ok: false; code: 'RESERVATION_PRODUCT_SUSPENDED' };

export interface ReleaseReservationResult {
  released: boolean;
  quantity: number;
  underflow: ReservationUnderflowDetails | null;
}

interface RawReserveOrRenewResult {
  err?: 'RESERVATION_CHECKOUT_IN_PROGRESS' | 'RESERVATION_PRODUCT_SUSPENDED';
  ok?: true;
  entry?: CartScopedReservationEntry;
  underflow?: RawScriptUnderflow | null;
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

export interface ProductReservedTotalReconciliation {
  productId: string;
  membersChecked: number;
  activeReservations: number;
  staleMembersRemoved: number;
  malformedEntries: number;
  versionMismatches: number;
  storedTotal: number;
  calculatedTotal: number;
  difference: number;
  driftDirection: ProductTotalDriftDirection;
  repairedValue: number;
  admissionSuspended: boolean;
}

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

  async reserveOrRenew(
    cartId: string,
    productId: string,
    customerId: string,
    quantity: number,
  ): Promise<ReserveOrRenewOutcome> {
    const now = Date.now();
    const keys = [
      reservationKey(cartId, productId),
      cartIndexKey(cartId),
      productIndexKey(productId),
      productTotalKey(productId),
      productSuspectKey(productId),
    ];
    const args = [
      cartId,
      productId,
      customerId,
      quantity,
      now,
      RESERVATION_TTL_SECONDS * 1000,
      MAX_RESERVATION_LIFETIME_SECONDS * 1000,
      RESERVATION_ENTRY_VERSION,
    ];

    const raw = await this.redis.eval(RESERVE_OR_RENEW_SCRIPT, keys, args);
    const parsed = parseScriptResult<RawReserveOrRenewResult>(raw);

    if (parsed.err) {
      return { ok: false, code: parsed.err };
    }

    const underflow = toUnderflowDetails(this.logger, parsed.underflow, {
      productId,
      cartId,
      operationName: 'reserveOrRenew',
      timestamp: now,
    });

    return { ok: true, result: { entry: parsed.entry!, underflow } };
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

  // A malformed entry (unparseable JSON, an unexpected `version`, or a
  // non-positive `quantity`) is never treated as a plain "no reservation"
  // case the way a missing or expired key is - its quantity cannot be
  // trusted, so it must not silently decrement the product total, and
  // must not be inferred as safe to delete. It is left in place (for
  // diagnostics/reconciliation) and the product is suspended for new
  // admission until reconciliation repairs the total from the product
  // index directly.
  async getActiveReservation(
    cartId: string,
    productId: string,
  ): Promise<CartScopedReservationEntry | null> {
    const key = reservationKey(cartId, productId);
    const raw = await this.redis.get(key);
    if (raw === null) {
      return null;
    }

    let entry: CartScopedReservationEntry;
    try {
      entry = JSON.parse(raw) as CartScopedReservationEntry;
    } catch {
      await flagMalformedReservation(this.redis, this.logger, productId, cartId, 'JSON parse failure', raw);
      return null;
    }

    if (entry.version !== RESERVATION_ENTRY_VERSION) {
      await flagMalformedReservation(
        this.redis,
        this.logger,
        productId,
        cartId,
        'version mismatch',
        raw,
        entry.version,
      );
      return null;
    }

    if (typeof entry.quantity !== 'number' || entry.quantity <= 0) {
      await flagMalformedReservation(
        this.redis,
        this.logger,
        productId,
        cartId,
        'non-positive or missing quantity',
        raw,
      );
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      // A valid, merely-expired entry self-heals through the same atomic
      // release path used everywhere else - never a special case here.
      await this.releaseReservation(cartId, productId);
      return null;
    }

    return entry;
  }

  async getReservedTotalExcludingCart(productId: string, excludingCartId: string): Promise<number> {
    const rawTotal = await this.redis.get(productTotalKey(productId));
    const total = rawTotal ? Number(rawTotal) : 0;

    // An empty/falsy cartId means "no requesting cart" (e.g. a general
    // product-availability view with no cart context) - exclude nothing,
    // and never construct a reservation key with an empty cartId segment.
    let ownQuantity = 0;
    if (excludingCartId) {
      const ownEntry = await this.getActiveReservation(excludingCartId, productId);
      ownQuantity = ownEntry?.quantity ?? 0;
    }

    return Math.max(0, total - ownQuantity);
  }

  // Existing compatibility wrapper - behavior is byte-for-byte unchanged
  // from before this method was split: SUSPECT collapses to a plain 0, OK
  // returns the computed number. No existing caller needs to change.
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
    const suspended = await this.redis.get(productSuspectKey(productId));
    if (suspended !== null) {
      return { status: 'SUSPECT' };
    }

    const reservedByOthers = await this.getReservedTotalExcludingCart(productId, excludingCartId);
    return { status: 'OK', available: Math.max(0, quantityAvailable - reservedByOthers) };
  }

  async reconcileProductReservedTotal(
    productId: string,
  ): Promise<ProductReservedTotalReconciliation> {
    const keys = [productIndexKey(productId), productTotalKey(productId), productSuspectKey(productId)];
    const args = [productId, Date.now(), RESERVATION_ENTRY_VERSION];

    const raw = await this.redis.eval(RECONCILE_PRODUCT_RESERVED_TOTAL_SCRIPT, keys, args);
    const result = parseScriptResult<ProductReservedTotalReconciliation>(raw);

    if (result.driftDirection !== 'NO_DRIFT') {
      this.logger.warn(
        `Product reserved-total reconciliation found ${result.driftDirection} for ${productId}`,
        result,
      );
    }

    return result;
  }
}
