// Whole-cart checkout revert (Unit 2.4.3 - see
// docs/architecture/reservation-lifecycle.md §10 and the Unit 2.4.3
// planning decisions). finalizeCheckoutConsumption's script lives in its
// own file, checkout-finalize-lua-scripts.ts - kept separate so neither
// file grows toward the repository's 400-line cap.
//
// KEYS[1] = cartIndexKey(cartId)
//
// ARGV[1] cartId                  - member keys (reservation/product-index/
//                                    product-total/suspect) are built by
//                                    string concatenation once SMEMBERS
//                                    reveals the product set - the same
//                                    dynamically-addressed-key pattern
//                                    already established by
//                                    RECONCILE_PRODUCT_RESERVED_TOTAL_SCRIPT
//                                    (see reservation-lifecycle.md §12).
// ARGV[2] checkoutIdempotencyKey
// ARGV[3] now (ms)
//
// Genuine two-pass structure: Pass 1 classifies every cart-index member
// into exactly one bucket with zero writes; Pass 2 mutates each bucket
// independently, so one corrupted/unresolvable entry never blocks another
// product's independently-resolvable outcome in the same call.
//
// Missing reservations (a stale cart-index member with no backing key) are
// pure internal cleanup - the membership is removed but the product is
// never reported in any result array (see the Unit 2.4.3 decisions).
//
// Underflow rule is identical to reserveOrRenew/releaseReservation (Unit
// 2.3, reservation-lua-scripts.ts): before decrementing the product total,
// the stored total must already be >= the quantity being subtracted; if
// not, the arithmetic is skipped entirely (never clamped), the suspect
// flag is set, and the underflow is reported - the entry's own deletion
// still proceeds regardless, since the reservation still ends and must
// stop counting toward the customer's own future admission checks.
export const CHECKOUT_REVERT_SCRIPT = `
local CHECKOUT_REVERT_SCRIPT_VERSION = 1
local SUPPORTED_VERSION = 1

local cartIndexKey = KEYS[1]
local cartId = ARGV[1]
local idemKey = ARGV[2]
local now = tonumber(ARGV[3])

local memberIds = redis.call('SMEMBERS', cartIndexKey)
table.sort(memberIds)

-- Pass 1: classify every member. Zero writes occur in this pass.
local missingIds = {}
local malformedIds = {}
local versionMismatchedIds = {}
local skippedIds = {}
local restoreIds = {}
local restoreEntries = {}
local deleteIds = {}
local deleteEntries = {}

for _, productId in ipairs(memberIds) do
  local reservationKey = 'inv:reserved:{' .. cartId .. '}:' .. productId
  local raw = redis.call('GET', reservationKey)

  if not raw then
    table.insert(missingIds, productId)
  else
    local ok, entry = pcall(cjson.decode, raw)
    if not ok or type(entry) ~= 'table' then
      table.insert(malformedIds, productId)
    elseif entry.version ~= SUPPORTED_VERSION then
      table.insert(versionMismatchedIds, productId)
    elseif entry.status == 'ACTIVE' then
      table.insert(skippedIds, productId)
    elseif entry.status == 'CHECKOUT_PENDING' then
      if entry.checkoutIdempotencyKey ~= idemKey then
        table.insert(skippedIds, productId)
      elseif entry.expiresAt > now then
        table.insert(restoreIds, productId)
        restoreEntries[productId] = entry
      else
        table.insert(deleteIds, productId)
        deleteEntries[productId] = entry
      end
    else
      -- Unexpected status value on an otherwise version-valid entry -
      -- treated as malformed, the same conservative handling as a
      -- JSON-decode failure, rather than guessed at.
      table.insert(malformedIds, productId)
    end
  end
end

-- Pass 2: mutate each classified bucket independently.
for _, productId in ipairs(missingIds) do
  redis.call('SREM', cartIndexKey, productId)
end

for _, productId in ipairs(malformedIds) do
  local suspectKey = 'inv:reserved:product-total-suspect:{' .. productId .. '}'
  redis.call('SET', suspectKey, '1')
end

for _, productId in ipairs(versionMismatchedIds) do
  local suspectKey = 'inv:reserved:product-total-suspect:{' .. productId .. '}'
  redis.call('SET', suspectKey, '1')
end

for _, productId in ipairs(restoreIds) do
  local entry = restoreEntries[productId]
  entry.status = 'ACTIVE'
  entry.checkoutIdempotencyKey = cjson.null
  entry.checkoutPendingAt = cjson.null
  entry.checkoutPendingExpiresAt = cjson.null
  local reservationKey = 'inv:reserved:{' .. cartId .. '}:' .. productId
  redis.call('SET', reservationKey, cjson.encode(entry), 'KEEPTTL')
end

local underflow = {}
for _, productId in ipairs(deleteIds) do
  local entry = deleteEntries[productId]
  local reservationKey = 'inv:reserved:{' .. cartId .. '}:' .. productId
  local productIndexKey = 'inv:reserved:product-index:{' .. productId .. '}'
  local totalKey = 'inv:reserved:product-total:{' .. productId .. '}'
  local suspectKey = 'inv:reserved:product-total-suspect:{' .. productId .. '}'

  redis.call('DEL', reservationKey)
  redis.call('SREM', cartIndexKey, productId)
  redis.call('SREM', productIndexKey, cartId)

  local storedTotal = tonumber(redis.call('GET', totalKey) or '0')
  if storedTotal >= entry.quantity then
    redis.call('SET', totalKey, storedTotal - entry.quantity)
  else
    redis.call('SET', suspectKey, '1')
    table.insert(underflow, {
      productId = productId,
      reservationQuantity = entry.quantity,
      storedTotal = storedTotal,
    })
  end
end

local admissionSuspended = (#malformedIds > 0) or (#versionMismatchedIds > 0) or (#underflow > 0)

return cjson.encode({
  scriptVersion = CHECKOUT_REVERT_SCRIPT_VERSION,
  ok = true,
  restoredProductIds = restoreIds,
  deletedProductIds = deleteIds,
  skippedProductIds = skippedIds,
  malformedProductIds = malformedIds,
  versionMismatchedProductIds = versionMismatchedIds,
  underflow = underflow,
  admissionSuspended = admissionSuspended,
})
`;
