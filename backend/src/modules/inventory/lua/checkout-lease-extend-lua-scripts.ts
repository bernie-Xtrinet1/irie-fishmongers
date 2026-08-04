// Whole-cart checkout-pending lease extension (Unit 2.4.2 - see
// docs/architecture/reservation-lifecycle.md and the Unit 2.4.2 planning
// decisions). Validate-all-then-mutate-all: any failure returns before any
// write happens. checkout-lease-state-lua-scripts.ts holds the sibling
// read-only inspection script - kept separate so neither file grows toward
// the repository's 400-line cap.
//
// KEYS[1] = cartIndexKey(cartId)
//
// ARGV[1] cartId          - see checkout-lease-state-lua-scripts.ts for why
//                            member keys are built by string concatenation
//                            rather than passed via KEYS.
// ARGV[2] checkoutIdempotencyKey
// ARGV[3] now (ms)
// ARGV[4] additionalMs    (additionalSeconds * 1000)
// ARGV[5] maxPendingMs    (MAX_CHECKOUT_PENDING_SECONDS * 1000)
//
// Deterministic failure priority (see the Unit 2.4.2 decisions for exact
// definitions):
//   1. RESERVATION_MISSING
//   2. RESERVATION_MALFORMED
//   3. RESERVATION_VERSION_MISMATCH
//   4. RESERVATION_NOT_PENDING       (empty index, or zero members pending at all)
//   5. CHECKOUT_STATE_INCOMPLETE     (some pending, some still ACTIVE)
//   6. RESERVATION_CHECKOUT_KEY_MISMATCH (all pending, some under another key)
//   7. CHECKOUT_PENDING_HARD_LIMIT_REACHED (all pending+owned, one at/past
//      the ceiling - triggered by either now >= checkoutPendingAt +
//      maxPendingMs, or a stored checkoutPendingExpiresAt that already
//      exceeds that ceiling, e.g. via corrupted or unsupported data)
//
// Only entries that clear every check above are mutated, and only
// `checkoutPendingExpiresAt` ever changes - quantity, expiresAt,
// absoluteExpiresAt, checkoutPendingAt, status, and checkoutIdempotencyKey
// are all preserved verbatim.
export const CHECKOUT_EXTEND_LEASE_SCRIPT = `
local CHECKOUT_EXTEND_LEASE_SCRIPT_VERSION = 1
local SUPPORTED_VERSION = 1

local cartIndexKey = KEYS[1]
local cartId = ARGV[1]
local idemKey = ARGV[2]
local now = tonumber(ARGV[3])
local additionalMs = tonumber(ARGV[4])
local maxPendingMs = tonumber(ARGV[5])

local memberIds = redis.call('SMEMBERS', cartIndexKey)
table.sort(memberIds)

local missingProductIds = {}
local malformedProductIds = {}
local versionMismatchedProductIds = {}
local activeProductIds = {}
local conflictingKeyProductIds = {}
local atHardLimitProductIds = {}
local pendingProductIds = {}          -- every pending member, owned or not
local pendingOwnedIds = {}            -- owned-pending members, in sorted order
local pendingOwnedEntries = {}        -- productId -> decoded entry, owned-pending only

-- Phase A: classify every member. Zero writes occur in this phase.
for _, productId in ipairs(memberIds) do
  local reservationKey = 'inv:reserved:{' .. cartId .. '}:' .. productId
  local raw = redis.call('GET', reservationKey)

  if not raw then
    table.insert(missingProductIds, productId)
  else
    local ok, entry = pcall(cjson.decode, raw)
    if not ok or type(entry) ~= 'table' then
      table.insert(malformedProductIds, productId)
    elseif entry.version ~= SUPPORTED_VERSION then
      table.insert(versionMismatchedProductIds, productId)
    elseif entry.status == 'ACTIVE' then
      table.insert(activeProductIds, productId)
    elseif entry.status == 'CHECKOUT_PENDING' then
      table.insert(pendingProductIds, productId)
      if entry.checkoutIdempotencyKey ~= idemKey then
        table.insert(conflictingKeyProductIds, productId)
      else
        table.insert(pendingOwnedIds, productId)
        pendingOwnedEntries[productId] = entry
        local hardCeiling = entry.checkoutPendingAt + maxPendingMs
        if now >= hardCeiling or entry.checkoutPendingExpiresAt > hardCeiling then
          table.insert(atHardLimitProductIds, productId)
        end
      end
    else
      table.insert(malformedProductIds, productId)
    end
  end
end

-- Phase B: decide, in strict priority order.
if #missingProductIds > 0 then
  return cjson.encode({
    scriptVersion = CHECKOUT_EXTEND_LEASE_SCRIPT_VERSION,
    err = 'RESERVATION_MISSING',
    productIds = missingProductIds,
  })
end
if #malformedProductIds > 0 then
  return cjson.encode({
    scriptVersion = CHECKOUT_EXTEND_LEASE_SCRIPT_VERSION,
    err = 'RESERVATION_MALFORMED',
    productIds = malformedProductIds,
  })
end
if #versionMismatchedProductIds > 0 then
  return cjson.encode({
    scriptVersion = CHECKOUT_EXTEND_LEASE_SCRIPT_VERSION,
    err = 'RESERVATION_VERSION_MISMATCH',
    productIds = versionMismatchedProductIds,
  })
end
if (#pendingOwnedIds + #conflictingKeyProductIds) == 0 then
  return cjson.encode({
    scriptVersion = CHECKOUT_EXTEND_LEASE_SCRIPT_VERSION,
    err = 'RESERVATION_NOT_PENDING',
  })
end
if #activeProductIds > 0 then
  return cjson.encode({
    scriptVersion = CHECKOUT_EXTEND_LEASE_SCRIPT_VERSION,
    err = 'CHECKOUT_STATE_INCOMPLETE',
    pendingProductIds = pendingProductIds,
    activeProductIds = activeProductIds,
  })
end
if #conflictingKeyProductIds > 0 then
  return cjson.encode({
    scriptVersion = CHECKOUT_EXTEND_LEASE_SCRIPT_VERSION,
    err = 'RESERVATION_CHECKOUT_KEY_MISMATCH',
    productIds = conflictingKeyProductIds,
  })
end
if #atHardLimitProductIds > 0 then
  return cjson.encode({
    scriptVersion = CHECKOUT_EXTEND_LEASE_SCRIPT_VERSION,
    err = 'CHECKOUT_PENDING_HARD_LIMIT_REACHED',
    productIds = atHardLimitProductIds,
  })
end

-- Phase C: every member is pending, owned by idemKey, and below the hard
-- ceiling - mutate. Only checkoutPendingExpiresAt changes, and only when
-- the new candidate is strictly greater than what is already stored.
local extendedProductIds = {}
local finalExpiresAtValues = {}
for _, productId in ipairs(pendingOwnedIds) do
  local entry = pendingOwnedEntries[productId]
  local candidate = math.min(now + additionalMs, entry.checkoutPendingAt + maxPendingMs)
  if candidate > entry.checkoutPendingExpiresAt then
    entry.checkoutPendingExpiresAt = candidate
    local reservationKey = 'inv:reserved:{' .. cartId .. '}:' .. productId
    redis.call('SET', reservationKey, cjson.encode(entry), 'KEEPTTL')
    table.insert(extendedProductIds, productId)
    table.insert(finalExpiresAtValues, candidate)
  else
    table.insert(finalExpiresAtValues, entry.checkoutPendingExpiresAt)
  end
end

local newCheckoutPendingExpiresAt = finalExpiresAtValues[1]
for _, value in ipairs(finalExpiresAtValues) do
  if value < newCheckoutPendingExpiresAt then
    newCheckoutPendingExpiresAt = value
  end
end

return cjson.encode({
  scriptVersion = CHECKOUT_EXTEND_LEASE_SCRIPT_VERSION,
  ok = true,
  alreadyExtended = (#extendedProductIds == 0),
  newCheckoutPendingExpiresAt = newCheckoutPendingExpiresAt,
  extendedProductIds = extendedProductIds,
})
`;
