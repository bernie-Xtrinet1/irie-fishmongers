// Whole-cart checkout finalization (Unit 2.4.3 - see
// docs/architecture/reservation-lifecycle.md §10 and the Unit 2.4.3
// planning decisions). checkoutRevert's script lives in its own file,
// checkout-revert-lua-scripts.ts - kept separate so neither file grows
// toward the repository's 400-line cap.
//
// KEYS[1] = cartIndexKey(cartId)
//
// ARGV[1] cartId                  - see checkout-revert-lua-scripts.ts for
//                                    why member keys are built by string
//                                    concatenation rather than passed via
//                                    KEYS.
// ARGV[2] checkoutIdempotencyKey
//
// Classification is identical to checkoutRevert except there is no
// expiresAt decision for a matching-key CHECKOUT_PENDING entry: the
// checkout has durably COMMITTED, so every reservation it was holding is
// consumed unconditionally, valid or already-expired alike. Genuine
// two-pass structure and the underflow rule are identical to
// checkoutRevert (see that file's header comment). A second finalize call
// against an already-finalized cart is idempotent by construction: Pass 1
// simply finds nothing left in the matching-key-pending bucket, needing no
// explicit duplicate-detection branch.
export const FINALIZE_CHECKOUT_CONSUMPTION_SCRIPT = `
local FINALIZE_CHECKOUT_CONSUMPTION_SCRIPT_VERSION = 1
local SUPPORTED_VERSION = 1

local cartIndexKey = KEYS[1]
local cartId = ARGV[1]
local idemKey = ARGV[2]

local memberIds = redis.call('SMEMBERS', cartIndexKey)
table.sort(memberIds)

-- Pass 1: classify every member. Zero writes occur in this pass.
local missingIds = {}
local malformedIds = {}
local versionMismatchedIds = {}
local skippedIds = {}
local finalizeIds = {}
local finalizeEntries = {}

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
      else
        table.insert(finalizeIds, productId)
        finalizeEntries[productId] = entry
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

local underflow = {}
for _, productId in ipairs(finalizeIds) do
  local entry = finalizeEntries[productId]
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
  scriptVersion = FINALIZE_CHECKOUT_CONSUMPTION_SCRIPT_VERSION,
  ok = true,
  finalizedProductIds = finalizeIds,
  skippedProductIds = skippedIds,
  malformedProductIds = malformedIds,
  versionMismatchedProductIds = versionMismatchedIds,
  underflow = underflow,
  admissionSuspended = admissionSuspended,
})
`;
