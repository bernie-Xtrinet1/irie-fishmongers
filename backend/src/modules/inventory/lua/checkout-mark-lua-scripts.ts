// Whole-cart checkout marking (see docs/architecture/reservation-lifecycle.md
// §7-9, refined across the Unit 2.4 planning rounds). Only checkoutMark
// exists here - lease inspection/extension are a later, separate sub-unit
// added to this same file.
//
// KEYS[1]         = cartIndexKey(cartId)
// KEYS[2..N+1]    = reservationKey(cartId, productId_i)      i=1..N, plan order
// KEYS[N+2..2N+1] = productSuspectKey(productId_i)           i=1..N, plan order (read-only)
//
// ARGV[1] cartId                  ARGV[5] initialLeaseMs
// ARGV[2] customerId              ARGV[6] maxPendingMs
// ARGV[3] checkoutIdempotencyKey  ARGV[7] N (item count)
// ARGV[4] now (ms)
// ARGV[8..7+N]     = productId_i         (plan order)
// ARGV[8+N..7+2N]  = expectedQuantity_i  (plan order)
//
// Supported reservation entry versions are declared here, in Lua, not
// passed in by TypeScript - this script alone decides which entry shapes
// it understands. Every returned result carries a scriptVersion so the
// caller can protocol-check the response before treating it as a normal
// reservation-state result.
export const CHECKOUT_MARK_SCRIPT = `
local CHECKOUT_MARK_SCRIPT_VERSION = 1
local SUPPORTED_VERSION = 1

-- NOTE: Redis's embedded cjson has no reliable way to distinguish an
-- empty array from an empty object when encoding a bare empty Lua table -
-- it encodes {} as a JSON object, not []. Every array-typed result field
-- below (duplicateProductIds, missingFromPlan, missingFromIndex,
-- suspectProductIds, etc.) can legitimately be empty. Rather than depend
-- on a cjson version/build-specific workaround (cjson.array_mt is not
-- present in this Redis's Lua environment; encode_empty_table_as_object
-- is not a callable field either - both confirmed by direct probing), the
-- TypeScript caller normalizes any non-array JSON value for these fields
-- to an empty array - see CheckoutReservationStateService.toStringArray.

local cartIndexKey = KEYS[1]
local cartId, customerId, idemKey = ARGV[1], ARGV[2], ARGV[3]
local now = tonumber(ARGV[4])
local initialLeaseMs = tonumber(ARGV[5])
local maxPendingMs = tonumber(ARGV[6])
local n = tonumber(ARGV[7])

-- Plan sanity: non-empty, no duplicate product IDs.
local planProductIds = {}
local seen = {}
local duplicates = {}
for i = 1, n do
  local pid = ARGV[7 + i]
  planProductIds[i] = pid
  if seen[pid] then
    table.insert(duplicates, pid)
  end
  seen[pid] = true
end

if n == 0 then
  return cjson.encode({ scriptVersion = CHECKOUT_MARK_SCRIPT_VERSION, err = 'CHECKOUT_PLAN_EMPTY' })
end

if #duplicates > 0 then
  table.sort(duplicates)
  return cjson.encode({
    scriptVersion = CHECKOUT_MARK_SCRIPT_VERSION,
    err = 'CHECKOUT_PLAN_DUPLICATE_PRODUCT',
    duplicateProductIds = duplicates,
  })
end

-- Completeness: the submitted plan's product set must exactly equal the
-- cart index's product set. SMEMBERS order is undefined, so the result is
-- sorted before any comparison or reporting.
local indexedProductIds = redis.call('SMEMBERS', cartIndexKey)
table.sort(indexedProductIds)
local indexedSet = {}
for _, pid in ipairs(indexedProductIds) do
  indexedSet[pid] = true
end

local missingFromIndex = {}
for i = 1, n do
  if not indexedSet[planProductIds[i]] then
    table.insert(missingFromIndex, planProductIds[i])
  end
end

local missingFromPlan = {}
for _, pid in ipairs(indexedProductIds) do
  if not seen[pid] then
    table.insert(missingFromPlan, pid)
  end
end

if #missingFromIndex > 0 or #missingFromPlan > 0 then
  local sortedSubmitted = {}
  for i = 1, n do sortedSubmitted[i] = planProductIds[i] end
  table.sort(sortedSubmitted)
  table.sort(missingFromIndex)
  table.sort(missingFromPlan)
  return cjson.encode({
    scriptVersion = CHECKOUT_MARK_SCRIPT_VERSION,
    err = 'CHECKOUT_PLAN_MISMATCH',
    submittedProductIds = sortedSubmitted,
    indexedProductIds = indexedProductIds,
    missingFromPlan = missingFromPlan,
    missingFromIndex = missingFromIndex,
    duplicateProductIds = {},
  })
end

-- Pass 1: validate every reservation entry. Zero writes occur in this
-- pass - any failure returns immediately, before Pass 2 ever runs.
for i = 1, n do
  local reservationKey = KEYS[1 + i]
  local raw = redis.call('GET', reservationKey)
  if not raw then
    return cjson.encode({
      scriptVersion = CHECKOUT_MARK_SCRIPT_VERSION,
      err = 'RESERVATION_MISSING',
      failedProductId = planProductIds[i],
    })
  end

  local ok, entry = pcall(cjson.decode, raw)
  if not ok or type(entry) ~= 'table' then
    return cjson.encode({
      scriptVersion = CHECKOUT_MARK_SCRIPT_VERSION,
      err = 'RESERVATION_MALFORMED',
      failedProductId = planProductIds[i],
    })
  end

  if entry.version ~= SUPPORTED_VERSION then
    return cjson.encode({
      scriptVersion = CHECKOUT_MARK_SCRIPT_VERSION,
      err = 'RESERVATION_VERSION_MISMATCH',
      failedProductId = planProductIds[i],
    })
  end

  if entry.cartId ~= cartId or entry.customerId ~= customerId then
    return cjson.encode({
      scriptVersion = CHECKOUT_MARK_SCRIPT_VERSION,
      err = 'RESERVATION_OWNER_MISMATCH',
      failedProductId = planProductIds[i],
    })
  end

  local expectedQty = tonumber(ARGV[7 + n + i])
  if entry.quantity ~= expectedQty then
    return cjson.encode({
      scriptVersion = CHECKOUT_MARK_SCRIPT_VERSION,
      err = 'RESERVATION_QUANTITY_MISMATCH',
      failedProductId = planProductIds[i],
    })
  end

  if entry.expiresAt <= now then
    return cjson.encode({
      scriptVersion = CHECKOUT_MARK_SCRIPT_VERSION,
      err = 'RESERVATION_EXPIRED',
      failedProductId = planProductIds[i],
    })
  end

  if entry.absoluteExpiresAt <= now then
    return cjson.encode({
      scriptVersion = CHECKOUT_MARK_SCRIPT_VERSION,
      err = 'RESERVATION_ABSOLUTE_EXPIRED',
      failedProductId = planProductIds[i],
    })
  end

  if entry.status == 'CHECKOUT_PENDING' and entry.checkoutIdempotencyKey ~= idemKey then
    return cjson.encode({
      scriptVersion = CHECKOUT_MARK_SCRIPT_VERSION,
      err = 'RESERVATION_CHECKOUT_KEY_CONFLICT',
      failedProductId = planProductIds[i],
    })
  end
  -- status == 'ACTIVE', or CHECKOUT_PENDING under this exact key: both
  -- legal, handled distinctly in Pass 2.
end

-- Pass 2: every check passed - mutate ACTIVE entries only. Entries already
-- CHECKOUT_PENDING under this exact key (same-key replay) receive no SET
-- at all, so checkoutPendingAt/checkoutPendingExpiresAt are provably
-- untouched and this can never act as a heartbeat.
local suspectFlags = {}
for i = 1, n do
  local reservationKey = KEYS[1 + i]
  local suspectKey = KEYS[1 + n + i]
  local raw = redis.call('GET', reservationKey)
  local entry = cjson.decode(raw)
  if entry.status ~= 'CHECKOUT_PENDING' then
    entry.status = 'CHECKOUT_PENDING'
    entry.checkoutIdempotencyKey = idemKey
    entry.checkoutPendingAt = now
    entry.checkoutPendingExpiresAt = math.min(now + initialLeaseMs, now + maxPendingMs)
    redis.call('SET', reservationKey, cjson.encode(entry), 'KEEPTTL')
  end
  suspectFlags[i] = redis.call('EXISTS', suspectKey) == 1
end

local suspectProductIds = {}
for i = 1, n do
  if suspectFlags[i] then
    table.insert(suspectProductIds, planProductIds[i])
  end
end
table.sort(suspectProductIds)

return cjson.encode({
  scriptVersion = CHECKOUT_MARK_SCRIPT_VERSION,
  ok = true,
  suspectProductIds = suspectProductIds,
})
`;
