import { MUTATION_COMMON_LUA } from './reservation-mutation-common.lua';

// Standalone Redis. A restored coherent old image requires external quarantine.
export const PRODUCT_CONTROL_FUNCTIONS = `
local function productControlValid(p)
 return fields(p,7) and p.version==1 and uuid(p.productId) and uuid(p.incarnation) and
  integer(p.epoch) and p.epoch>0 and
  ((p.state=='ALLOW' and p.restrictionId==cjson.null and p.restrictionRevision==0) or
   (p.state=='RESTRICTED' and uuid(p.restrictionId) and p.restrictionRevision==1))
end
local function productAllowed(productId,tuple)
 local key='reservation:fence:product-control:{'..productId..'}'
 local p,err=read(key)
 return not err and productControlValid(p) and redis.call('PTTL',key)==-1 and
  p.productId==productId and p.incarnation==tuple.incarnation and p.epoch==tuple.epoch and p.state=='ALLOW'
end
`;

// ALLOW is invoked only while the trusted W1 issuer holds the durable fence lock
// and has proved absence of a permanent restriction. It never overwrites a key.
export const PRODUCT_CONTROL_INSTALL = MUTATION_COMMON_LUA + PRODUCT_CONTROL_FUNCTIONS + `
local expected=decode(ARGV[1])
local current,err=control(expected)
if err then return rejected(err) end
local p=decode(ARGV[2])
if not productControlValid(p) or p.incarnation~=current.incarnation or p.epoch~=current.epoch or
 KEYS[2]~='reservation:fence:product-control:{'..p.productId..'}' then return rejected('PERMIT_SCOPE_MISMATCH') end
local history='reservation:fence:initialization-history'
if redis.call('TYPE',history).ok~='hash' or redis.call('HGET',history,'incarnation')~=current.incarnation then
 return rejected('MISSING_INITIALIZATION_HISTORY') end
if p.state=='ALLOW' and current.phase~='OPEN' then return rejected('PHASE_DENIED') end
local old,e=read(KEYS[2])
if e and e~='MISSING' then return rejected('MALFORMED_CONTROL') end
if old then
 if not productControlValid(old) or redis.call('PTTL',KEYS[2])~=-1 or old.productId~=p.productId or
  old.incarnation~=p.incarnation or old.epoch~=p.epoch then return rejected('DURABLE_REDIS_DISAGREEMENT') end
 if old.state=='RESTRICTED' or p.state=='ALLOW' then
  if old.state~=p.state or old.restrictionId~=p.restrictionId or old.restrictionRevision~=p.restrictionRevision then
   return rejected('CAPABILITY_REVOKED') end
  return accepted(ARGV[2])
 end
end
redis.call('SET',KEYS[2],ARGV[2])
return accepted(ARGV[2])
`;
