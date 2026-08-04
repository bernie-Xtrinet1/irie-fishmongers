// Whole-cart, read-only checkout-pending lease inspection (Unit 2.4.2 - see
// docs/architecture/reservation-lifecycle.md and the Unit 2.4.2 planning
// decisions). Performs zero writes. extendCheckoutLease's script lives in
// its own file, checkout-lease-extend-lua-scripts.ts - kept separate so
// neither file grows toward the repository's 400-line cap.
//
// KEYS[1] = cartIndexKey(cartId)
//
// ARGV[1] cartId                  - needed to build each member's
//                                    reservationKey by string
//                                    concatenation, since the set of
//                                    productIds is only known once
//                                    SMEMBERS runs inside the script (the
//                                    same dynamically-addressed-key
//                                    pattern already established by
//                                    RECONCILE_PRODUCT_RESERVED_TOTAL_SCRIPT,
//                                    see reservation-lifecycle.md §12).
// ARGV[2] checkoutIdempotencyKey
// ARGV[3] now (ms)
// ARGV[4] maxPendingMs (MAX_CHECKOUT_PENDING_SECONDS * 1000) - needed to
//         compute hardLimitViolationProductIds against the same hard
//         ceiling formula extendCheckoutLease enforces.
//
// Every cart-index member is classified into exactly one of: missing,
// malformed, version-mismatched, ACTIVE, or CHECKOUT_PENDING. Pending
// members are additionally split by ownership: `pendingProductIds`
// contains every pending member regardless of key; `conflictingKeyProductIds`
// is the subset owned by a different checkout key. `hardLimitViolationProductIds`
// (like `expiredLeaseProductIds`) is computed over every pending member
// regardless of ownership - a pending entry is in violation when
// `now >= checkoutPendingAt + maxPendingMs` or when its stored
// `checkoutPendingExpiresAt` already exceeds that ceiling (a corrupted or
// unsupported stored deadline). `found` and the earliest/latest
// timestamps consider only pending members owned by the supplied key -
// see the Unit 2.4.2 decisions for the exact
// found/complete/allOwnedByCheckoutKey definitions.
export const CHECKOUT_LEASE_STATE_SCRIPT = `
local CHECKOUT_LEASE_STATE_SCRIPT_VERSION = 1
local SUPPORTED_VERSION = 1

local cartIndexKey = KEYS[1]
local cartId = ARGV[1]
local idemKey = ARGV[2]
local now = tonumber(ARGV[3])
local maxPendingMs = tonumber(ARGV[4])

local memberIds = redis.call('SMEMBERS', cartIndexKey)
table.sort(memberIds)

local pendingProductIds = {}
local activeStatusProductIds = {}
local missingProductIds = {}
local malformedProductIds = {}
local versionMismatchedProductIds = {}
local conflictingKeyProductIds = {}
local expiredLeaseProductIds = {}
local hardLimitViolationProductIds = {}

local earliestCheckoutPendingAt = nil
local earliestCheckoutPendingExpiresAt = nil
local latestCheckoutPendingExpiresAt = nil
local ownedPendingCount = 0

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
      table.insert(activeStatusProductIds, productId)
    elseif entry.status == 'CHECKOUT_PENDING' then
      table.insert(pendingProductIds, productId)
      if entry.checkoutPendingExpiresAt ~= nil and entry.checkoutPendingExpiresAt <= now then
        table.insert(expiredLeaseProductIds, productId)
      end
      local hardCeiling = entry.checkoutPendingAt + maxPendingMs
      if now >= hardCeiling or entry.checkoutPendingExpiresAt > hardCeiling then
        table.insert(hardLimitViolationProductIds, productId)
      end
      if entry.checkoutIdempotencyKey ~= idemKey then
        table.insert(conflictingKeyProductIds, productId)
      else
        ownedPendingCount = ownedPendingCount + 1
        if earliestCheckoutPendingAt == nil or entry.checkoutPendingAt < earliestCheckoutPendingAt then
          earliestCheckoutPendingAt = entry.checkoutPendingAt
        end
        if earliestCheckoutPendingExpiresAt == nil or entry.checkoutPendingExpiresAt < earliestCheckoutPendingExpiresAt then
          earliestCheckoutPendingExpiresAt = entry.checkoutPendingExpiresAt
        end
        if latestCheckoutPendingExpiresAt == nil or entry.checkoutPendingExpiresAt > latestCheckoutPendingExpiresAt then
          latestCheckoutPendingExpiresAt = entry.checkoutPendingExpiresAt
        end
      end
    else
      -- Unexpected status value on an otherwise version-valid entry -
      -- treated as malformed, the same conservative handling as a
      -- JSON-decode failure, rather than guessed at.
      table.insert(malformedProductIds, productId)
    end
  end
end

local found = ownedPendingCount > 0
local complete = found
  and #missingProductIds == 0
  and #malformedProductIds == 0
  and #versionMismatchedProductIds == 0
  and #activeStatusProductIds == 0
  and #conflictingKeyProductIds == 0
  and #hardLimitViolationProductIds == 0
local allOwnedByCheckoutKey = found and #conflictingKeyProductIds == 0

-- Lua tables cannot hold an explicit nil value - assigning one below
-- simply omits the key from the encoded JSON object rather than encoding
-- 'null'. The TypeScript caller treats "missing key" and "null" as the
-- same "no timestamp" signal (CheckoutLeaseStateService.toNullableNumber),
-- so this is not a defect, just a documented consequence of cjson's
-- encoding of Lua nil.
return cjson.encode({
  scriptVersion = CHECKOUT_LEASE_STATE_SCRIPT_VERSION,
  ok = true,
  found = found,
  complete = complete,
  allOwnedByCheckoutKey = allOwnedByCheckoutKey,
  earliestCheckoutPendingAt = earliestCheckoutPendingAt,
  earliestCheckoutPendingExpiresAt = earliestCheckoutPendingExpiresAt,
  latestCheckoutPendingExpiresAt = latestCheckoutPendingExpiresAt,
  pendingProductIds = pendingProductIds,
  activeStatusProductIds = activeStatusProductIds,
  missingProductIds = missingProductIds,
  malformedProductIds = malformedProductIds,
  versionMismatchedProductIds = versionMismatchedProductIds,
  conflictingKeyProductIds = conflictingKeyProductIds,
  expiredLeaseProductIds = expiredLeaseProductIds,
  hardLimitViolationProductIds = hardLimitViolationProductIds,
})
`;
