// This is control/authorization infrastructure, not a reservation writer.
export const MUTATION_HISTORY_KEY = 'reservation:fence:initialization-history';
export const mutationPermitKey = (id: string) => `reservation:fence:permit:${id}`;
export const executionGateKey = (id: string) => `reservation:fence:gate:${id}`;
export const resourceGuardKey = (id: string) => `reservation:fence:resource:${id}`;

export const MUTATION_COMMON_LUA = `
local function rejected(reason)
  return cjson.encode({code='FENCE_REJECTED', reason=reason})
end
local function accepted(value)
  return cjson.encode({code='ACCEPTED', value=value or true})
end
local function uuid(v)
  return type(v)=='string' and #v==36 and
    string.match(v,'^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$')~=nil
end
local function integer(v)
  return type(v)=='number' and v>=0 and v<=2147483647 and v==math.floor(v)
end
local function fields(v,n)
  if type(v)~='table' then return false end
  local count=0 for _ in pairs(v) do count=count+1 end
  return count==n
end
local function decode(raw)
  if type(raw)~='string' then return nil end
  local ok,v=pcall(cjson.decode,raw)
  if not ok or type(v)~='table' then return nil end
  return v
end
local function read(key)
  local kind=redis.call('TYPE',key).ok
  if kind=='none' then return nil,'MISSING' end
  if kind~='string' then return nil,'MALFORMED' end
  local v=decode(redis.call('GET',key))
  if not v then return nil,'MALFORMED' end
  return v,nil
end
local function tupleValid(t)
  if type(t)~='table' then return false end
  local count=0 for _ in pairs(t) do count=count+1 end
  return count==6 and uuid(t.incarnation) and uuid(t.transitionId) and
    integer(t.epoch) and t.epoch>0 and integer(t.revision) and t.revision>0 and
    integer(t.protocol) and t.protocol>0 and
    (t.phase=='OPEN' or t.phase=='DRAINING' or t.phase=='FROZEN' or t.phase=='RETIRED')
end
local function compareTuple(a,b)
  if not tupleValid(a) or not tupleValid(b) then return 'MALFORMED_CONTROL' end
  if a.protocol~=1 or b.protocol~=1 then return 'PROTOCOL_MISMATCH' end
  if a.incarnation~=b.incarnation then return 'WRONG_INCARNATION' end
  if a.epoch~=b.epoch then return 'EPOCH_MISMATCH' end
  if a.revision~=b.revision then return 'STALE_REVISION' end
  if a.transitionId~=b.transitionId or a.phase~=b.phase then return 'DURABLE_REDIS_DISAGREEMENT' end
end
local function control(expected)
  local current,err=read(KEYS[1])
  if err then return nil,err..'_CONTROL' end
  err=compareTuple(current,expected)
  if err then return nil,err end
  return current,nil
end
local function nowMs()
  local t=redis.call('TIME') return tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
end
local function resourceValid(r)
  return fields(r,6) and uuid(r.customerId) and uuid(r.cartId) and uuid(r.productId) and
    uuid(r.markerId) and integer(r.generation) and uuid(r.holdInstanceId)
end
local function sameResource(a,b)
  return resourceValid(a) and resourceValid(b) and a.customerId==b.customerId and
    a.cartId==b.cartId and a.productId==b.productId and a.markerId==b.markerId and
    a.generation==b.generation and a.holdInstanceId==b.holdInstanceId
end
local function executionValid(e)
  return fields(e,3) and uuid(e.operationId) and uuid(e.attemptId) and uuid(e.gateId)
end
local function gateValid(g)
  return fields(g,5) and uuid(g.incarnation) and integer(g.epoch) and g.epoch>0 and
    uuid(g.operationId) and uuid(g.gateId) and
    (g.state=='ENABLED' or g.state=='CLOSED' or g.state=='REVOKED')
end
local function checkResources(p)
  if type(p.resources)~='table' or #p.resources<1 or #p.resources>100 then return 'PERMIT_SCOPE_MISMATCH' end
  local seen={}
  for _,r in ipairs(p.resources) do
    if not resourceValid(r) or seen[r.markerId] then return 'PERMIT_SCOPE_MISMATCH' end
    seen[r.markerId]=true
    local guard,err=read('reservation:fence:resource:'..r.markerId)
    if err then return err..'_RESOURCE_GUARD' end
    if not fields(guard,3) or not resourceValid(guard.resource) or not uuid(guard.incarnation) or not integer(guard.epoch) then
      return 'MALFORMED_RESOURCE_GUARD'
    end
    if guard.incarnation~=p.tuple.incarnation then return 'WRONG_INCARNATION' end
    if guard.epoch~=p.tuple.epoch then return 'EPOCH_MISMATCH' end
    if not sameResource(guard.resource,r) then return 'RESOURCE_GENERATION_MISMATCH' end
  end
end
local function checkGate(p)
  if p.family~='CHECKOUT_EXECUTION_OR_SETTLEMENT' then
    if p.execution~=cjson.null then return 'PERMIT_SCOPE_MISMATCH' end
    return nil
  end
  if not executionValid(p.execution) then return 'UNKNOWN_CAPABILITY' end
  local g,err=read('reservation:fence:gate:'..p.execution.gateId)
  if err then return err..'_EXECUTION_GATE' end
  if not gateValid(g) then return 'MALFORMED_EXECUTION_GATE' end
  if g.incarnation~=p.tuple.incarnation then return 'WRONG_INCARNATION' end
  if g.epoch~=p.tuple.epoch then return 'EPOCH_MISMATCH' end
  if g.operationId~=p.execution.operationId or g.gateId~=p.execution.gateId then return 'UNKNOWN_CAPABILITY' end
  if p.purpose=='CHECKOUT_EXECUTION' then
    if g.state=='REVOKED' then return 'CAPABILITY_REVOKED' end
    if g.state~='ENABLED' then return 'EXECUTION_GATE_CLOSED' end
  elseif p.purpose~='CHECKOUT_SETTLEMENT' then return 'UNKNOWN_CAPABILITY' end
end
`;
