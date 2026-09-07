import { Injectable } from '@nestjs/common';
import { ReservationEngineMode } from '@prisma/client';

import { RESERVATION_ENTRY_VERSION } from '../../inventory/constants/inventory.constants';
import { PRICE_LOCK_TTL_SECONDS } from '../../price-lock/constants/price-lock.constants';
import {
  CheckoutShadowResult,
  ShadowLineComparison,
  ShadowReadContext,
} from '../types/checkout-shadow.types';
import { CheckoutRolloutTelemetryService } from './checkout-rollout-telemetry.service';
import { CheckoutShadowReadService } from './checkout-shadow-read.service';

type UnavailableReason = Extract<CheckoutShadowResult, { status: 'UNAVAILABLE' }>['reasonCode'];
const finiteQuantity = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function parseEntry(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

@Injectable()
export class CheckoutShadowComparisonService {
  constructor(
    private readonly reads: CheckoutShadowReadService,
    private readonly telemetry: CheckoutRolloutTelemetryService,
  ) {}

  async compare(context: ShadowReadContext): Promise<CheckoutShadowResult> {
    const started = Date.now();
    let result: CheckoutShadowResult;
    try {
      result = await this.observe(context);
    } catch {
      result = {
        status: 'ERROR',
        reasonCode: 'READ_FAILURE',
        engineMode: null,
        comparisons: [],
        checkoutEligibility: 'UNAVAILABLE',
      };
    }
    try {
      this.telemetry.recordShadowComparison(result, Date.now() - started);
    } catch {
      /* isolated */
    }
    return result;
  }

  private async observe(context: ShadowReadContext): Promise<CheckoutShadowResult> {
    let engineMode: ReservationEngineMode | null = null;
    const comparisons: ShadowLineComparison[] = [];
    const unavailable = (reasonCode: UnavailableReason): CheckoutShadowResult => ({
      status: 'UNAVAILABLE',
      reasonCode,
      engineMode,
      comparisons,
      checkoutEligibility: 'UNAVAILABLE',
    });
    const cart = await this.reads.cart(context.cartId);
    if (!cart) return unavailable('CART_MISSING');
    if (cart.customerId !== context.authenticatedCustomerId)
      return unavailable('OWNERSHIP_MISMATCH');
    const config = await this.reads.mode();
    engineMode = config?.mode ?? ReservationEngineMode.LEGACY;
    if (engineMode === ReservationEngineMode.DRAINING) return unavailable('MODE_NOT_ADMITTING');
    const items = await this.reads.lines(cart.id);
    if (!items.length) return unavailable('CART_EMPTY');

    // This is a non-atomic observation, not a checkout snapshot or admission grant.
    for (const item of items) {
      const product = await this.reads.product(item.productId);
      if (!product) return unavailable('PRODUCT_MISSING');
      if (!product.isActive) return unavailable('PRODUCT_INACTIVE');
      if (
        !finiteQuantity(product.quantityAvailable) ||
        !finiteQuantity(item.quantity) ||
        item.quantity === 0
      )
        return unavailable('MISSING_REQUIRED_READ_DATA');
      const state = await this.reads.reservations(cart.id, product.id);
      const now = Date.now();
      if (state.suspect !== null) return unavailable('RESERVATION_SUSPECT');
      if (state.own === null || state.total === null)
        return unavailable('NO_COMPARABLE_CART_SCOPED_STATE');
      const own = parseEntry(state.own);
      const total = state.total.trim() === '' ? NaN : Number(state.total);
      if (
        !own ||
        own.version !== RESERVATION_ENTRY_VERSION ||
        own.cartId !== cart.id ||
        own.customerId !== cart.customerId ||
        !finiteQuantity(own.quantity) ||
        own.quantity === 0 ||
        !finiteQuantity(own.expiresAt) ||
        !finiteQuantity(total) ||
        total < own.quantity ||
        !['ACTIVE', 'CHECKOUT_PENDING'].includes(String(own.status))
      )
        return unavailable('RESERVATION_STATE_INVALID');
      if (own.expiresAt <= now) return unavailable('RESERVATION_EXPIRED');
      if (own.status === 'CHECKOUT_PENDING') return unavailable('CHECKOUT_PENDING_NOT_COMPARED');
      let legacyOthers = 0;
      for (const [cartId, raw] of Object.entries(state.legacy)) {
        const entry = parseEntry(raw);
        if (!entry || !finiteQuantity(entry.quantity) || !finiteQuantity(entry.expiresAt))
          return unavailable('RESERVATION_STATE_INVALID');
        if (entry.expiresAt > now && cartId !== cart.id) legacyOthers += entry.quantity;
      }
      if (!finiteQuantity(legacyOthers)) return unavailable('RESERVATION_STATE_INVALID');
      if (
        item.lockedUnitPrice === null &&
        item.lockedCurrency === null &&
        item.priceLockedAt === null
      )
        return unavailable('PRICE_LOCK_REQUIRED');
      if (
        item.lockedUnitPrice === null ||
        item.lockedCurrency === null ||
        item.priceLockedAt === null ||
        cart.currency === null ||
        item.lockedCurrency !== cart.currency ||
        !Number.isFinite(item.priceLockedAt.getTime()) ||
        item.priceLockedAt.getTime() > now
      )
        return unavailable('PRICE_LOCK_INVALID');
      if (item.priceLockedAt.getTime() + PRICE_LOCK_TTL_SECONDS * 1000 <= now)
        return unavailable('PRICE_LOCK_EXPIRED');
      const legacyAvailable = Math.max(0, product.quantityAvailable - legacyOthers);
      const cartScopedAvailable = Math.max(0, product.quantityAvailable - (total - own.quantity));
      comparisons.push({
        line: comparisons.length,
        requested: item.quantity,
        stock: product.quantityAvailable,
        legacyAvailable,
        cartScopedAvailable,
        legacyAdmissible: item.quantity <= legacyAvailable,
        cartScopedAdmissible: item.quantity <= cartScopedAvailable,
        priceEqual:
          item.lockedUnitPrice.equals(product.price) && item.lockedCurrency === product.currency,
      });
    }
    const base = { engineMode, comparisons, checkoutEligibility: 'UNAVAILABLE' as const };
    if (comparisons.some((line) => line.legacyAvailable !== line.cartScopedAvailable))
      return { ...base, status: 'MISMATCH', reasonCode: 'AVAILABILITY_DIFFERS' };
    if (comparisons.some((line) => !line.priceEqual))
      return { ...base, status: 'MISMATCH', reasonCode: 'PRICE_DIFFERS' };
    return { ...base, status: 'MATCH', reasonCode: 'MATCH' };
  }
}
