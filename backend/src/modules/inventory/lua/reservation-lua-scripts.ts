// Lua scripts for the cart-scoped reservation model (see
// docs/architecture/reservation-lifecycle.md). Only reserveOrRenew and
// releaseReservation exist here - checkoutMark/checkoutRevert/
// extendCheckoutLease/finalizeCheckoutConsumption are a later, separate
// unit.
//
// Both scripts atomically touch a fixed set of five keys per call:
//   KEYS[1] reservation key            inv:reserved:{cartId}:productId
//   KEYS[2] cart index                 inv:reserved:cart-index:{cartId}
//   KEYS[3] product index              inv:reserved:product-index:{productId}
//   KEYS[4] product reserved total     inv:reserved:product-total:{productId}
//   KEYS[5] product suspect flag       inv:reserved:product-total-suspect:{productId}
//
// Underflow rule (both scripts): before applying any negative adjustment to
// the product total, the stored total must already be >= the reservation
// quantity being subtracted. If it is not, the total was already
// undercounted by something unrelated to this call - the total is left
// untouched (never clamped, never guessed), the suspect flag is set, and
// the caller is told an underflow occurred alongside the otherwise-
// successful entry mutation. The entry mutation itself (the customer's
// actual add/renew/release) always completes regardless of this check.

// CART_SCOPED activation-boundary gate (see the gate design review's
// final, approved atomic-freshness design). ARGV[9] (forceFreshEpoch,
// '1'/absent) is the ONE additive change to this script: when set AND an
// existing entry is found, createdAt/absoluteExpiresAt are reset to a
// fresh now-anchored epoch before the rest of this script's own, entirely
// unchanged, accounting/index/suspend/checkout-pending logic runs. Every
// existing ARGV[1..8] caller (ordinary reserveOrRenew) never passes
// ARGV[9], so their behavior is byte-for-byte unchanged - this is a pure
// superset, not a second accounting path. Administrative-only in
// practice: reachable exclusively via InventoryReservationsService's
// distinct reserveWithFreshEpoch method (see its own doc comment for why
// it is never a boolean parameter on the ordinary reserveOrRenew call).
export const RESERVE_OR_RENEW_SCRIPT = `
local reservationKey, cartIndexKey, productIndexKey, totalKey, suspectKey =
  KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local cartId, productId, customerId = ARGV[1], ARGV[2], ARGV[3]
local requestedQuantity = tonumber(ARGV[4])
local now = tonumber(ARGV[5])
local rollingTtlMs = tonumber(ARGV[6])
local maxLifetimeMs = tonumber(ARGV[7])
local version = tonumber(ARGV[8])
local forceFreshEpoch = ARGV[9] == '1'

local raw = redis.call('GET', reservationKey)
local oldQuantity = 0
local entry

if raw then
  entry = cjson.decode(raw)
  if entry.status == 'CHECKOUT_PENDING' then
    return cjson.encode({ err = 'RESERVATION_CHECKOUT_IN_PROGRESS' })
  end
  oldQuantity = entry.quantity
  if forceFreshEpoch then
    entry.createdAt = now
    entry.absoluteExpiresAt = now + maxLifetimeMs
  end
else
  entry = {
    version = version,
    cartId = cartId,
    customerId = customerId,
    status = 'ACTIVE',
    createdAt = now,
    absoluteExpiresAt = now + maxLifetimeMs,
    checkoutIdempotencyKey = cjson.null,
    checkoutPendingAt = cjson.null,
    checkoutPendingExpiresAt = cjson.null,
  }
end

local delta = requestedQuantity - oldQuantity

local isSuspended = redis.call('EXISTS', suspectKey) == 1
if isSuspended and delta > 0 then
  return cjson.encode({ err = 'RESERVATION_PRODUCT_SUSPENDED' })
end

entry.quantity = requestedQuantity
entry.lastRenewedAt = now
entry.expiresAt = math.min(now + rollingTtlMs, entry.absoluteExpiresAt)

redis.call('SET', reservationKey, cjson.encode(entry), 'PXAT', entry.absoluteExpiresAt)
redis.call('SADD', cartIndexKey, productId)
redis.call('SADD', productIndexKey, cartId)

local underflow = nil
if delta > 0 then
  redis.call('INCRBY', totalKey, delta)
elseif delta < 0 then
  local storedTotal = tonumber(redis.call('GET', totalKey) or '0')
  if storedTotal < oldQuantity then
    redis.call('SET', suspectKey, '1')
    underflow = {
      reservationQuantity = oldQuantity,
      storedTotal = storedTotal,
    }
  else
    redis.call('SET', totalKey, storedTotal + delta)
  end
end

return cjson.encode({ ok = true, entry = entry, underflow = underflow })
`;

// Legacy cart-scoped release remains unchanged; W3-O does not authorize it.
export const RELEASE_RESERVATION_SCRIPT = `
local reservationKey, cartIndexKey, productIndexKey, totalKey, suspectKey =
  KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local cartId, productId = ARGV[1], ARGV[2]

local raw = redis.call('GET', reservationKey)
if not raw then
  return cjson.encode({ ok = true, released = false, quantity = 0, underflow = nil })
end

local entry = cjson.decode(raw)
redis.call('DEL', reservationKey)
redis.call('SREM', cartIndexKey, productId)
redis.call('SREM', productIndexKey, cartId)

local underflow = nil
if entry.quantity > 0 then
  local storedTotal = tonumber(redis.call('GET', totalKey) or '0')
  if storedTotal < entry.quantity then
    redis.call('SET', suspectKey, '1')
    underflow = {
      reservationQuantity = entry.quantity,
      storedTotal = storedTotal,
    }
  else
    redis.call('SET', totalKey, storedTotal - entry.quantity)
  end
end

return cjson.encode({ ok = true, released = true, quantity = entry.quantity, underflow = underflow })
`;
