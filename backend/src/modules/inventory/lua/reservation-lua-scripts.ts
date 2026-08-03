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

export const RESERVE_OR_RENEW_SCRIPT = `
local reservationKey, cartIndexKey, productIndexKey, totalKey, suspectKey =
  KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local cartId, productId, customerId = ARGV[1], ARGV[2], ARGV[3]
local requestedQuantity = tonumber(ARGV[4])
local now = tonumber(ARGV[5])
local rollingTtlMs = tonumber(ARGV[6])
local maxLifetimeMs = tonumber(ARGV[7])
local version = tonumber(ARGV[8])

local raw = redis.call('GET', reservationKey)
local oldQuantity = 0
local entry

if raw then
  entry = cjson.decode(raw)
  if entry.status == 'CHECKOUT_PENDING' then
    return cjson.encode({ err = 'RESERVATION_CHECKOUT_IN_PROGRESS' })
  end
  oldQuantity = entry.quantity
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

// Atomic reconciliation for one product's reserved-total projection. Runs
// as a single script (not a client-side SMEMBERS-then-GET-loop-then-SET)
// specifically so no concurrent reserveOrRenew/releaseReservation call can
// interleave between reading the product index and writing the repaired
// total - the whole read-classify-repair-verify sequence executes without
// any other command running in between.
//
//   KEYS[1] product index              inv:reserved:product-index:{productId}
//   KEYS[2] product reserved total     inv:reserved:product-total:{productId}
//   KEYS[3] product suspect flag       inv:reserved:product-total-suspect:{productId}
//   ARGV[1] productId
//   ARGV[2] now (ms)
//   ARGV[3] expected RESERVATION_ENTRY_VERSION
//
// Per-cart reservation/cart-index keys are not passed via KEYS - the set
// of cartIds is only known once the product index is read inside the
// script, so they are built by string concatenation, exactly as already
// established for this single (non-cluster) Redis instance (see
// docs/architecture/reservation-lifecycle.md §12).
export const RECONCILE_PRODUCT_RESERVED_TOTAL_SCRIPT = `
local productIndexKey, totalKey, suspectKey = KEYS[1], KEYS[2], KEYS[3]
local productId = ARGV[1]
local now = tonumber(ARGV[2])
local expectedVersion = tonumber(ARGV[3])

local cartIds = redis.call('SMEMBERS', productIndexKey)

local membersChecked = 0
local activeReservations = 0
local staleMembersRemoved = 0
local malformedEntries = 0
local versionMismatches = 0
local calculatedTotal = 0

for _, cartId in ipairs(cartIds) do
  membersChecked = membersChecked + 1
  local reservationKey = 'inv:reserved:{' .. cartId .. '}:' .. productId
  local cartIndexKeyForCart = 'inv:reserved:cart-index:{' .. cartId .. '}'
  local raw = redis.call('GET', reservationKey)

  if not raw then
    -- Stale index member: the reservation key is already gone (evicted,
    -- or never existed). Nothing to preserve.
    redis.call('SREM', productIndexKey, cartId)
    redis.call('SREM', cartIndexKeyForCart, productId)
    staleMembersRemoved = staleMembersRemoved + 1
  else
    local ok, entry = pcall(cjson.decode, raw)
    if not ok then
      -- Malformed JSON: cannot trust the quantity. Remove from both
      -- indexes so it stops contributing to future totals/scans, but
      -- leave the key itself in place for diagnostics.
      malformedEntries = malformedEntries + 1
      redis.call('SREM', productIndexKey, cartId)
      redis.call('SREM', cartIndexKeyForCart, productId)
    elseif entry.version ~= expectedVersion then
      versionMismatches = versionMismatches + 1
      redis.call('SREM', productIndexKey, cartId)
      redis.call('SREM', cartIndexKeyForCart, productId)
    elseif type(entry.quantity) ~= 'number' or entry.quantity <= 0 then
      malformedEntries = malformedEntries + 1
      redis.call('SREM', productIndexKey, cartId)
      redis.call('SREM', cartIndexKeyForCart, productId)
    elseif entry.expiresAt <= now then
      -- Valid but expired: safe to delete outright, same as a normal
      -- release.
      redis.call('DEL', reservationKey)
      redis.call('SREM', productIndexKey, cartId)
      redis.call('SREM', cartIndexKeyForCart, productId)
      staleMembersRemoved = staleMembersRemoved + 1
    else
      activeReservations = activeReservations + 1
      calculatedTotal = calculatedTotal + entry.quantity
    end
  end
end

local storedTotal = tonumber(redis.call('GET', totalKey) or '0')
local difference = calculatedTotal - storedTotal
local driftDirection
if difference == 0 then
  driftDirection = 'NO_DRIFT'
elseif difference < 0 then
  driftDirection = 'OVERCOUNT'
else
  driftDirection = 'UNDERCOUNT'
end

if driftDirection == 'UNDERCOUNT' then
  redis.call('SET', suspectKey, '1')
end

redis.call('SET', totalKey, calculatedTotal)

-- Under this script's own atomicity the verification below always
-- succeeds (no other command can run between the SET and this GET) - it
-- is kept as a defensive, structural safeguard rather than removed,
-- matching this design's general preference for redundant checks over
-- trusting a single mechanism.
local verify = tonumber(redis.call('GET', totalKey) or '0')
local admissionSuspended = false
if verify == calculatedTotal then
  redis.call('DEL', suspectKey)
else
  admissionSuspended = true
end

return cjson.encode({
  productId = productId,
  membersChecked = membersChecked,
  activeReservations = activeReservations,
  staleMembersRemoved = staleMembersRemoved,
  malformedEntries = malformedEntries,
  versionMismatches = versionMismatches,
  storedTotal = storedTotal,
  calculatedTotal = calculatedTotal,
  difference = difference,
  driftDirection = driftDirection,
  repairedValue = calculatedTotal,
  admissionSuspended = admissionSuspended,
})
`;

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
