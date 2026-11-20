import { MUTATION_COMMON_LUA } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { PRODUCT_CONTROL_FUNCTIONS } from '../../reservation-fence/lua/product-reservation-restriction.lua';
import { MAX_RESERVATION_LIFETIME_SECONDS, RESERVATION_TTL_SECONDS } from '../constants/inventory.constants';

const COMMON = MUTATION_COMMON_LUA + PRODUCT_CONTROL_FUNCTIONS + `
local a=decode(ARGV[1])
if not fields(a,8) or a.version~=1 or not resourceValid(a.target) or not uuid(a.requestId) or
  not integer(a.quantity) or a.quantity<1 or type(a.expiresAt)~='number' or
  not integer(a.controlRevision) or a.controlRevision<0 or (a.controlRevision%2)~=0 then
  return rejected('MALFORMED_PERMIT') end
local current,err=control(a.tuple)
if err then return rejected(err) end
if current.phase~='OPEN' then return rejected('PHASE_DENIED') end
local r=a.target
if a.from~=cjson.null then
  if not resourceValid(a.from) or a.from.markerId~=r.markerId or a.from.cartId~=r.cartId or
    a.from.customerId~=r.customerId or a.from.productId~=r.productId or
    (a.from.generation~=r.generation and a.from.generation+1~=r.generation) then return rejected('PERMIT_SCOPE_MISMATCH') end
  if a.from.generation==r.generation and not sameResource(a.from,r) then return rejected('PERMIT_SCOPE_MISMATCH') end
end
local guardKey='reservation:fence:resource:'..r.markerId
local entryKey='inv:reserved:{'..r.cartId..'}:'..r.productId
local cartIndex='inv:reserved:cart-index:{'..r.cartId..'}'
local productIndex='inv:reserved:product-index:{'..r.productId..'}'
local totalKey='inv:reserved:product-total:{'..r.productId..'}'
local suspectKey='inv:reserved:product-total-suspect:{'..r.productId..'}'
local history='reservation:fence:initialization-history'
local function ownershipAbsent(e)
  return (e.checkoutOperationId==nil or e.checkoutOperationId==cjson.null) and
    (e.checkoutAttemptId==nil or e.checkoutAttemptId==cjson.null) and
    (e.checkoutIdempotencyKey==nil or e.checkoutIdempotencyKey==cjson.null)
end
local function matches(e,g,resource)
  return fields(g,3) and g.incarnation==a.tuple.incarnation and g.epoch==a.tuple.epoch and sameResource(g.resource,resource) and
    type(e)=='table' and e.version==1 and e.status=='ACTIVE' and ownershipAbsent(e) and
    e.cartId==resource.cartId and e.customerId==resource.customerId and e.markerId==resource.markerId and
    e.generation==resource.generation and e.holdInstanceId==resource.holdInstanceId and e.reservationExecutionEpoch==a.tuple.epoch
end
if redis.call('EXISTS','reservation:fence:checkout-pin:'..r.markerId)~=0 then return rejected('CHECKOUT_IN_PROGRESS') end
if redis.call('TYPE',history).ok~='hash' or redis.call('HGET',history,'incarnation')~=a.tuple.incarnation then
  return rejected('MISSING_INITIALIZATION_HISTORY') end
`;

// W1 issuer only; same trusted Redis ACL boundary as existing permit registration.
export const REGISTER_ORDINARY_RESERVATION = COMMON + `
if not productAllowed(r.productId,a.tuple,a.controlRevision) then return rejected('CAPABILITY_REVOKED') end
if KEYS[2]~='reservation:fence:w1:'..a.requestId or redis.call('EXISTS',KEYS[2])~=0 then return rejected('REPLAY_MISMATCH') end
a.expiresAt=nowMs()+5000
redis.call('SET',KEYS[2],cjson.encode(a),'PX',5000,'NX')
return accepted(a)
`;

const OBSERVATION = `
local e,ee=read(entryKey)
local g,ge=read(guardKey)
local now=nowMs()
local function guardShapeValid(guard)
  return fields(guard,3) and resourceValid(guard.resource) and uuid(guard.incarnation) and integer(guard.epoch)
end
local function entryShapeValid(entry)
  if type(entry)~='table' or entry.version~=1 or (entry.status~='ACTIVE' and entry.status~='CHECKOUT_PENDING') then return false end
  if not integer(entry.quantity) or entry.quantity<1 or type(entry.cartId)~='string' or #entry.cartId==0 or
    type(entry.customerId)~='string' or #entry.customerId==0 then return false end
  if type(entry.createdAt)~='number' or type(entry.absoluteExpiresAt)~='number' or
    entry.createdAt<0 or entry.absoluteExpiresAt<entry.createdAt then return false end
  if entry.expiresAt~=nil and type(entry.expiresAt)~='number' then return false end
  if entry.lastRenewedAt~=nil and type(entry.lastRenewedAt)~='number' then return false end
  if entry.markerId~=nil and entry.markerId~=cjson.null and type(entry.markerId)~='string' then return false end
  return true
end
local function checkoutOwned(entry,guard,expectedFrom)
  if not entryShapeValid(entry) or entry.cartId~=r.cartId or entry.customerId~=r.customerId then return false end
  if entry.markerId~=nil and entry.markerId~=cjson.null and entry.markerId~=r.markerId then return false end
  if entry.status~='CHECKOUT_PENDING' and ownershipAbsent(entry) then return false end
  if guard and (guard.incarnation~=a.tuple.incarnation or guard.epoch~=a.tuple.epoch or
    (expectedFrom~=cjson.null and not sameResource(guard.resource,expectedFrom))) then return false end
  if entry.generation~=nil and entry.generation~=cjson.null and expectedFrom~=cjson.null and entry.generation~=expectedFrom.generation then return false end
  return true
end
local function completeReason()
  if ge=='MALFORMED' or (g~=nil and not guardShapeValid(g)) then return 'MALFORMED_RESOURCE_GUARD' end
  if ee=='MALFORMED' or (e~=nil and not entryShapeValid(e)) then return 'MALFORMED_RESOURCE' end
  if e and checkoutOwned(e,g,cjson.null) then return 'CHECKOUT_IN_PROGRESS' end
  if ee or ge or not matches(e,g,r) or redis.call('HEXISTS',history,guardKey)~=1 or
    e.quantity~=a.quantity or e.reservationMutationId~=a.requestId or
    type(e.expiresAt)~='number' or e.expiresAt<=now or e.absoluteExpiresAt<=now then return 'RESOURCE_GENERATION_MISMATCH' end
  if redis.call('TYPE',cartIndex).ok~='set' or redis.call('TYPE',productIndex).ok~='set' or
    redis.call('SISMEMBER',cartIndex,r.productId)~=1 or redis.call('SISMEMBER',productIndex,r.cartId)~=1 then
    return 'ACCOUNTING_CORRUPTION' end
  if redis.call('TYPE',totalKey).ok~='string' then return 'ACCOUNTING_CORRUPTION' end
  local rawTotal=redis.call('GET',totalKey)
  if type(rawTotal)~='string' or not string.match(rawTotal,'^%d+$') then return 'ACCOUNTING_CORRUPTION' end
  local total=tonumber(rawTotal)
  if not total or total<0 or total>9007199254740991 or total~=math.floor(total) then return 'ACCOUNTING_CORRUPTION' end
  if total<a.quantity then return 'ACCOUNTING_UNDERFLOW' end
  return nil
end
`;

export const OBSERVE_ORDINARY_RESERVATION = COMMON + OBSERVATION + `
local fail=completeReason()
if fail then return rejected(fail) end
return accepted(e)
`;

export const WRITE_ORDINARY_RESERVATION = COMMON + `
if not productAllowed(r.productId,a.tuple,a.controlRevision) then return rejected('CAPABILITY_REVOKED') end
if KEYS[2]~='reservation:fence:w1:'..a.requestId then return rejected('MISSING_PERMIT') end
local stored,se=read(KEYS[2])
if se or not fields(stored,8) or stored.version~=a.version or compareTuple(stored.tuple,a.tuple) or
  stored.controlRevision~=a.controlRevision or stored.requestId~=a.requestId or stored.expiresAt~=a.expiresAt or stored.quantity~=a.quantity or
  not sameResource(stored.target,a.target) or
  ((stored.from==cjson.null)~=(a.from==cjson.null)) or
  (a.from~=cjson.null and not sameResource(stored.from,a.from)) then return rejected('MISSING_PERMIT') end
if a.expiresAt<=nowMs() then return rejected('EXPIRED_PERMIT') end
` + OBSERVATION + `
if ge=='MALFORMED' or (g~=nil and not guardShapeValid(g)) then return rejected('MALFORMED_RESOURCE_GUARD') end
if ee=='MALFORMED' then return rejected('MALFORMED_RESOURCE') end
if e and type(e)=='table' and e.reservationMutationId==a.requestId then
  local fail=completeReason()
  if fail then return rejected(fail) end
  return accepted(e)
end
if e~=nil and not entryShapeValid(e) then return rejected('MALFORMED_RESOURCE') end
if e and checkoutOwned(e,g,a.from) then return rejected('CHECKOUT_IN_PROGRESS') end
if a.from==cjson.null then
  if e or g or redis.call('HEXISTS',history,guardKey)==1 then return rejected('RESOURCE_GENERATION_MISMATCH') end
else
  if ee or ge or not matches(e,g,a.from) or redis.call('HEXISTS',history,guardKey)~=1 then
    return rejected('RESOURCE_GENERATION_MISMATCH') end
end
for _,key in ipairs({cartIndex,productIndex}) do
  local kind=redis.call('TYPE',key).ok
  if kind~='none' and kind~='set' then return rejected('ACCOUNTING_CORRUPTION') end
end
local kind=redis.call('TYPE',totalKey).ok
if kind~='none' and kind~='string' then return rejected('ACCOUNTING_CORRUPTION') end
local rawTotal=redis.call('GET',totalKey)
if rawTotal~=false and not string.match(rawTotal,'^%d+$') then return rejected('ACCOUNTING_CORRUPTION') end
local total=tonumber(rawTotal or '0')
if not total or total<0 or total>9007199254740991 or total~=math.floor(total) then return rejected('ACCOUNTING_CORRUPTION') end
local old=0
if e then
  if e.createdAt>now then return rejected('MALFORMED_RESOURCE') end
  if e.absoluteExpiresAt<=now then return rejected('RESOURCE_GENERATION_MISMATCH') end
  old=e.quantity
  if redis.call('SISMEMBER',cartIndex,r.productId)~=1 or redis.call('SISMEMBER',productIndex,r.cartId)~=1 then
    return rejected('ACCOUNTING_CORRUPTION') end
elseif redis.call('SISMEMBER',cartIndex,r.productId)~=0 or redis.call('SISMEMBER',productIndex,r.cartId)~=0 then
  return rejected('ACCOUNTING_CORRUPTION')
end
if total<old then return rejected('ACCOUNTING_UNDERFLOW') end
if total-old+a.quantity>9007199254740991 then return rejected('ACCOUNTING_CORRUPTION') end
if redis.call('EXISTS',suspectKey)~=0 and a.quantity>old then return cjson.encode({code='DOMAIN_FAILURE',reason='RESERVATION_PRODUCT_SUSPENDED'}) end
e=e or {version=1,cartId=r.cartId,customerId=r.customerId,status='ACTIVE',createdAt=now,
  absoluteExpiresAt=now+${MAX_RESERVATION_LIFETIME_SECONDS * 1000},checkoutIdempotencyKey=cjson.null,
  checkoutPendingAt=cjson.null,checkoutPendingExpiresAt=cjson.null}
e.quantity=a.quantity e.lastRenewedAt=now
e.expiresAt=math.min(now+${RESERVATION_TTL_SECONDS * 1000},e.absoluteExpiresAt)
e.markerId=r.markerId e.generation=r.generation e.holdInstanceId=r.holdInstanceId
e.reservationExecutionEpoch=a.tuple.epoch e.reservationMutationId=a.requestId
redis.call('SET',entryKey,cjson.encode(e),'PXAT',e.absoluteExpiresAt)
redis.call('SET',guardKey,cjson.encode({incarnation=a.tuple.incarnation,epoch=a.tuple.epoch,resource=r}))
redis.call('HSET',history,guardKey,'1')
redis.call('SET',totalKey,string.format('%.0f',total-old+a.quantity))
redis.call('SADD',cartIndex,r.productId) redis.call('SADD',productIndex,r.cartId)
return accepted(e)
`;
