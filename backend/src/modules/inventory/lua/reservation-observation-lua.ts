// Single-instance Redis only. No discovery scan and no mutation, including error paths.
// Cardinality is checked BEFORE enumeration. Equality covers examined resources only.
export const RESERVATION_OBSERVATION_SCRIPT = `
local findings = {}
local function flag(value) findings[value] = true end
local function kind(key) return redis.call('TYPE', key).ok end
local function text(key)
  local t = kind(key)
  if t == 'none' then return false end
  if t ~= 'string' then flag('MEMBERSHIP_UNCERTAIN'); return false end
  return redis.call('GET', key)
end
local function decode(raw)
  if not raw then return nil end
  local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= 'table' then flag('MEMBERSHIP_UNCERTAIN'); return nil end
  return value
end
local function integer(n) return type(n) == 'number' and n >= 0 and n <= 9007199254740991 and n == math.floor(n) end
local function segment(s) return type(s) == 'string' and #s > 0 and #s <= 128 and string.match(s, '^[%w_-]+$') end
local productId, now, limit = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3])
local expected = decode(ARGV[4])
local stored, sum = cjson.null, cjson.null
local control, fence = text(KEYS[4]), text(KEYS[5])
local suspect = text(KEYS[3])
if suspect then flag('MEMBERSHIP_UNCERTAIN') end
local total = text(KEYS[2])
if total and string.match(total, '^%d+$') and integer(tonumber(total)) then stored = tonumber(total)
else flag('MEMBERSHIP_UNCERTAIN') end
local members = {}
local indexType = kind(KEYS[1])
local bounded = segment(productId) and integer(now) and integer(limit) and limit > 0 and limit <= 100
  and expected and #expected <= limit
if indexType ~= 'none' and indexType ~= 'set' then bounded = false end
if indexType == 'set' and redis.call('SCARD', KEYS[1]) > (limit or 0) then bounded = false end
if bounded then
  if indexType == 'set' then members = redis.call('SMEMBERS', KEYS[1]) end
  local targets, indexed, count = {}, {}, 0
  for _, cart in ipairs(members) do
    if not segment(cart) then bounded = false else targets[cart] = true; indexed[cart] = true; count = count + 1 end
  end
  for _, cart in ipairs(expected) do
    if not segment(cart) then bounded = false
    elseif not targets[cart] then targets[cart] = true; count = count + 1 end
  end
  if count > limit then bounded = false end
  if bounded then
    sum = 0
    for cart, _ in pairs(targets) do
      local holdKey = 'inv:reserved:{' .. cart .. '}:' .. productId
      local holdType = kind(holdKey)
      local raw = text(holdKey)
      local entry = decode(raw)
      local cartKey = 'inv:reserved:cart-index:{' .. cart .. '}'
      local ct = kind(cartKey)
      local reciprocal = false
      if ct == 'set' then reciprocal = redis.call('SISMEMBER', cartKey, productId) == 1
      elseif ct ~= 'none' then flag('MEMBERSHIP_UNCERTAIN') end
      if holdType == 'none' then flag('MISSING'); flag('MEMBERSHIP_UNCERTAIN')
      elseif not indexed[cart] then flag('EXTRA'); flag('MEMBERSHIP_UNCERTAIN') end
      if not reciprocal then flag('MEMBERSHIP_UNCERTAIN') end
      if not entry or entry.version ~= 1 or entry.cartId ~= cart or not segment(entry.customerId)
        or (entry.productId ~= nil and entry.productId ~= productId)
        or (entry.status ~= 'ACTIVE' and entry.status ~= 'CHECKOUT_PENDING')
        or not integer(entry.quantity) or entry.quantity == 0 or not integer(entry.expiresAt) then
        flag('MEMBERSHIP_UNCERTAIN'); sum = cjson.null
      elseif entry.expiresAt <= now then flag('EXTRA'); flag('MEMBERSHIP_UNCERTAIN')
      elseif sum ~= cjson.null then
        if not integer(sum + entry.quantity) then sum = cjson.null; flag('MEMBERSHIP_UNCERTAIN')
        else sum = sum + entry.quantity end
      end
    end
  end
end
if not bounded then flag('MEMBERSHIP_UNCERTAIN') end
local difference = cjson.null
if stored ~= cjson.null and sum ~= cjson.null then
  difference = sum - stored
  if difference ~= 0 then flag('QUANTITY_MISMATCH') end
end
local result = {}
for value, _ in pairs(findings) do table.insert(result, value) end
if #result == 0 then table.insert(result, 'CONSISTENT') end
return cjson.encode({ findings = result, accounting = { storedTotal = stored, observedQuantityTotal = sum,
  difference = difference }, control = control or cjson.null, fence = fence or cjson.null })
`;
