import { MUTATION_COMMON_LUA } from './reservation-mutation-common.lua';

// KEYS: control, initialization history, target. ARGV: tuple, action, record.
// This metadata is non-expiring. A retained history entry makes a missing
// target a denial, NOT permission to initialize again after eviction/loss.
export const RESERVATION_METADATA_LUA = MUTATION_COMMON_LUA + `
local t=decode(ARGV[1])
local current,err=control(t)
if err then return rejected(err) end
if redis.call('TYPE',KEYS[2]).ok~='hash' or
  redis.call('HGET',KEYS[2],'incarnation')~=current.incarnation then
  return rejected('MISSING_INITIALIZATION_HISTORY')
end
local action=ARGV[2]
local target=decode(ARGV[3])
if not target then return rejected('PERMIT_SCOPE_MISMATCH') end
local gate=action=='GATE_INIT' or action=='GATE_CLOSE' or action=='GATE_REVOKE'
if gate then
  if not gateValid(target) or KEYS[3]~='reservation:fence:gate:'..target.gateId then return rejected('UNKNOWN_CAPABILITY') end
elseif action=='RESOURCE_INIT' or action=='RESOURCE_ADVANCE' then
  if not resourceValid(target.resource) or KEYS[3]~='reservation:fence:resource:'..target.resource.markerId then
    return rejected('PERMIT_SCOPE_MISMATCH')
  end
  if redis.call('EXISTS','reservation:fence:checkout-pin:'..target.resource.markerId)~=0 then
    return rejected('RESOURCE_GENERATION_MISMATCH')
  end
else return rejected('EFFECT_MISMATCH') end
if target.incarnation~=current.incarnation then return rejected('WRONG_INCARNATION') end
if target.epoch~=current.epoch then return rejected('EPOCH_MISMATCH') end
local old,readError=read(KEYS[3])
local initialized=redis.call('HEXISTS',KEYS[2],KEYS[3])==1
if readError=='MALFORMED' then return rejected(gate and 'MALFORMED_EXECUTION_GATE' or 'MALFORMED_RESOURCE_GUARD') end
if not old then
  if initialized or (action~='GATE_INIT' and action~='RESOURCE_INIT') then
    return rejected(gate and 'MISSING_EXECUTION_GATE' or 'MISSING_RESOURCE_GUARD')
  end
  if current.phase~='OPEN' then return rejected('PHASE_DENIED') end
  if gate and target.state~='ENABLED' then return rejected('EXECUTION_GATE_CLOSED') end
  redis.call('HSET',KEYS[2],KEYS[3],'1')
  redis.call('SET',KEYS[3],ARGV[3])
  return accepted()
end
if not initialized then return rejected('MISSING_INITIALIZATION_HISTORY') end
if old.incarnation~=current.incarnation then return rejected('WRONG_INCARNATION') end
if old.epoch~=current.epoch then return rejected('EPOCH_MISMATCH') end
if gate then
  if not gateValid(old) then return rejected('MALFORMED_EXECUTION_GATE') end
  if old.gateId~=target.gateId or old.operationId~=target.operationId then return rejected('UNKNOWN_CAPABILITY') end
  if action=='GATE_INIT' then
    if old.state=='REVOKED' then return rejected('CAPABILITY_REVOKED') end
    if old.state~='ENABLED' or target.state~='ENABLED' then return rejected('EXECUTION_GATE_CLOSED') end
    return accepted()
  end
  if action=='GATE_CLOSE' then
    if old.state=='REVOKED' then return accepted() end
    target.state='CLOSED'
  else target.state='REVOKED' end
else
  if not resourceValid(old.resource) then return rejected('MALFORMED_RESOURCE_GUARD') end
  if sameResource(old.resource,target.resource) then return accepted() end
  if action~='RESOURCE_ADVANCE' or current.phase~='OPEN' or
    target.resource.generation<=old.resource.generation or
    target.resource.customerId~=old.resource.customerId or target.resource.cartId~=old.resource.cartId or
    target.resource.productId~=old.resource.productId or target.resource.markerId~=old.resource.markerId then
    return rejected('RESOURCE_GENERATION_MISMATCH')
  end
end
redis.call('SET',KEYS[3],cjson.encode(target))
return accepted()
`;
