// Control plane only. Existing reservation mutation scripts do not use this key.
// Redis cannot distinguish a restored OPEN image plus a stale client from the
// original endpoint. Quarantine/fencing is an infrastructure prerequisite.
export const RESERVATION_FENCE_KEY = 'reservation:fence:control';
export const RESERVATION_FENCE_CONTROL_LUA = `
local function uuid(v)
  return type(v) == 'string' and #v == 36 and
    string.match(v, '^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$') ~= nil
end
local function integer(v)
  return type(v) == 'number' and v > 0 and v <= 2147483647 and v == math.floor(v)
end
local phases = {OPEN=true, DRAINING=true, FROZEN=true, RETIRED=true}
local function decode(raw)
  local ok, t = pcall(cjson.decode, raw)
  if not ok or type(t) ~= 'table' then return nil end
  local n = 0
  for k, _ in pairs(t) do n = n + 1 end
  if n ~= 6 or not uuid(t.incarnation) or not uuid(t.transitionId) or
    not integer(t.epoch) or not integer(t.revision) or not integer(t.protocol) or
    type(t.phase) ~= 'string' or not phases[t.phase] then return nil end
  return t
end
local function equal(a,b)
  return a.incarnation == b.incarnation and a.epoch == b.epoch and
    a.revision == b.revision and a.phase == b.phase and
    a.protocol == b.protocol and a.transitionId == b.transitionId
end
local kind = redis.call('TYPE', KEYS[1]).ok
if kind ~= 'none' and kind ~= 'string' then return {'MALFORMED_CONTROL'} end
local raw = redis.call('GET', KEYS[1])
local current = nil
if raw then
  current = decode(raw)
  if not current then return {'MALFORMED_CONTROL'} end
  if current.protocol ~= 1 then return {'PROTOCOL_MISMATCH'} end
end
if ARGV[1] == 'READ' then
  if not current then return {'MISSING_CONTROL'} end
  return {'ACCEPTED', raw}
end
local target = decode(ARGV[2])
if not target then return {'MALFORMED_CONTROL'} end
if target.protocol ~= 1 then return {'PROTOCOL_MISMATCH'} end
if ARGV[1] == 'BOOTSTRAP' then
  if target.phase ~= 'FROZEN' then return {'ILLEGAL_PHASE_TRANSITION'} end
  if current then
    if equal(current,target) then return {'ACCEPTED'} end
    return {'DURABLE_REDIS_DISAGREEMENT'}
  end
  -- Atomic absence check; never replace an existing/restored image.
  redis.call('SET', KEYS[1], ARGV[2], 'NX')
  return {'ACCEPTED'}
end
if ARGV[1] ~= 'CAS' then return {'MALFORMED_CONTROL'} end
if not current then return {'MISSING_CONTROL'} end
local expected = decode(ARGV[3])
if not expected then return {'PREDECESSOR_MISMATCH'} end
if expected.protocol ~= 1 then return {'PROTOCOL_MISMATCH'} end
if target.incarnation ~= expected.incarnation then return {'WRONG_INCARNATION'} end
if target.epoch ~= expected.epoch then return {'EPOCH_MISMATCH'} end
if target.revision <= expected.revision then return {'STALE_REVISION'} end
if target.transitionId == expected.transitionId then return {'PREDECESSOR_MISMATCH'} end
local allowed = {OPEN={DRAINING=true,FROZEN=true},DRAINING={FROZEN=true},
  FROZEN={OPEN=true,DRAINING=true,RETIRED=true},RETIRED={}}
if not allowed[expected.phase][target.phase] then return {'ILLEGAL_PHASE_TRANSITION'} end
-- Crash after Redis CAS but before durable acknowledgement: exact replay only.
if equal(current,target) then return {'ACCEPTED'} end
if current.incarnation ~= expected.incarnation then return {'WRONG_INCARNATION'} end
if current.epoch ~= expected.epoch then return {'EPOCH_MISMATCH'} end
if current.revision ~= expected.revision then return {'STALE_REVISION'} end
if not equal(current,expected) then return {'PREDECESSOR_MISMATCH'} end
redis.call('SET', KEYS[1], ARGV[2])
return {'ACCEPTED'}
`;
