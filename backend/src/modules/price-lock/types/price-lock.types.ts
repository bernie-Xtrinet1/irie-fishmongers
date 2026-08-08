// Phase 16A.0-B result/state contracts for PriceLockRepository/
// PriceLockService (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md,
// Decision 7). Additive and unwired: PriceLockModule is not imported by
// any production module yet.

// createPriceLock/reconfirmPrice both classify a CartItem's three lock
// fields (lockedUnitPrice, lockedCurrency, priceLockedAt) into exactly one
// of: MISSING (all null), COMPLETE (all non-null - further split into
// valid/expired by PRICE_LOCK_TTL_SECONDS), or PARTIAL (any other
// combination - PRICE_LOCK_STATE_INVALID, never auto-repaired).

export interface CreatePriceLockInput {
  cartId: string;
  cartItemId: string;
  customerId: string;
  now: Date;
}

export type ReconfirmPriceInput = CreatePriceLockInput;

// A duplicate createPriceLock call against an already-COMPLETE lock never
// reads Product - the stored values are returned exactly as persisted,
// preserving "a valid lock survives a vendor price change until it
// expires" even for a same-caller retry. A COMPLETE lock is not valid
// merely because all three fields are non-null, though: it must also
// agree with Cart.currency (never Product.currency - an existing lock is
// checked against the cart-wide invariant it was created under, not
// current vendor pricing). CART_CURRENCY_MISSING/CART_CURRENCY_MISMATCH
// take priority over the TTL check - an invariant failure is reported
// before staleness is even considered. `conflictingCurrency` is either
// the rejected Product.currency (MISSING-lock path, comparing against
// Cart.currency) or the stored CartItem.lockedCurrency (COMPLETE-lock
// path, also comparing against Cart.currency) - never a fabricated value.
export type CreatePriceLockResult =
  | {
      ok: true;
      action: 'CREATED' | 'ALREADY_LOCKED';
      cartItemId: string;
      productId: string;
      lockedUnitPrice: string;
      lockedCurrency: string;
      priceLockedAt: Date;
    }
  | { ok: false; code: 'PRICE_LOCK_EXPIRED' }
  | { ok: false; code: 'PRICE_LOCK_STATE_INVALID' }
  | { ok: false; code: 'CART_CURRENCY_MISSING' }
  | { ok: false; code: 'CART_CURRENCY_MISMATCH'; cartCurrency: string | null; conflictingCurrency: string }
  | { ok: false; code: 'CART_NOT_FOUND' | 'CART_ITEM_NOT_FOUND' | 'OWNERSHIP_MISMATCH' | 'PRODUCT_NOT_FOUND' };

// reconfirmPrice is the only normal operation that may replace a COMPLETE
// lock's values - it never runs against MISSING (PRICE_LOCK_MISSING) or
// PARTIAL (PRICE_LOCK_STATE_INVALID, never treated as a repair
// opportunity) lock states. Cart.currency must already be non-null before
// Product is ever read (CART_CURRENCY_MISSING, zero Product reads) -
// reconfirmation never repairs a missing Cart.currency automatically.
export type ReconfirmPriceResult =
  | {
      ok: true;
      cartItemId: string;
      productId: string;
      oldUnitPrice: string;
      oldCurrency: string;
      newUnitPrice: string;
      newCurrency: string;
      priceLockedAt: Date;
    }
  | { ok: false; code: 'PRICE_LOCK_MISSING' }
  | { ok: false; code: 'PRICE_LOCK_STATE_INVALID' }
  | { ok: false; code: 'CART_CURRENCY_MISSING' }
  | { ok: false; code: 'CART_CURRENCY_MISMATCH'; cartCurrency: string | null; conflictingCurrency: string }
  | { ok: false; code: 'CART_NOT_FOUND' | 'CART_ITEM_NOT_FOUND' | 'OWNERSHIP_MISMATCH' | 'PRODUCT_NOT_FOUND' };

// getPriceLockState is read-only reporting - CURRENCY_MISMATCH and
// CART_CURRENCY_MISSING are distinct: CART_CURRENCY_MISSING means the
// cart-wide invariant "a COMPLETE lock implies Cart.currency is set" has
// been violated (should be structurally impossible under
// establishCurrencyIfCompatible's ordering); CURRENCY_MISMATCH means both
// values exist but disagree, an ordinary (if unexpected) conflict.
export type PriceLockState =
  | {
      ok: true;
      status: 'VALID' | 'EXPIRED';
      lockedUnitPrice: string;
      lockedCurrency: string;
      priceLockedAt: Date;
      validUntil: Date;
    }
  | { ok: true; status: 'MISSING' }
  | { ok: true; status: 'PRICE_LOCK_STATE_INVALID' }
  | { ok: true; status: 'CART_CURRENCY_MISSING'; lockedCurrency: string; priceLockedAt: Date }
  | { ok: true; status: 'CURRENCY_MISMATCH'; cartCurrency: string; lockedCurrency: string }
  | { ok: false; code: 'CART_NOT_FOUND' | 'CART_ITEM_NOT_FOUND' | 'OWNERSHIP_MISMATCH' };

export interface ValidatedCartPriceLockItem {
  cartItemId: string;
  productId: string;
  quantity: number;
  lockedUnitPrice: string;
  lockedCurrency: string;
  priceLockedAt: Date;
}

// validateCartPriceLocks never reads Product.price - every field in
// ValidatedCartPriceLockItem comes from CartItem alone. Fails closed: any
// non-empty id list on PRICE_LOCKS_INVALID means checkout must not
// proceed for this cart.
export type ValidateCartPriceLocksResult =
  | { ok: true; cartCurrency: string; items: ValidatedCartPriceLockItem[] }
  | { ok: false; code: 'CART_NOT_FOUND' | 'OWNERSHIP_MISMATCH' | 'CART_EMPTY' | 'CART_CURRENCY_MISSING' }
  | {
      ok: false;
      code: 'PRICE_LOCKS_INVALID';
      expiredItemIds: string[];
      missingLockItemIds: string[];
      currencyMismatchItemIds: string[];
      invalidLockStateItemIds: string[];
    };

// Internal classification of a CartItem's raw lock-field triple - not
// exported outside the service/repository pair.
export type CartItemLockClassification =
  | { kind: 'MISSING' }
  | { kind: 'COMPLETE'; lockedUnitPrice: import('@prisma/client').Prisma.Decimal; lockedCurrency: string; priceLockedAt: Date }
  | { kind: 'PARTIAL' };
