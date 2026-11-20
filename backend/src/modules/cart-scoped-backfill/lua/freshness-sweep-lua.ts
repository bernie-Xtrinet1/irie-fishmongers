import { MAX_RESERVATION_LIFETIME_SECONDS, RESERVATION_TTL_SECONDS } from '../../inventory/constants/inventory.constants';
import { PRODUCT_CONTROL_FUNCTIONS } from '../../reservation-fence/lua/product-reservation-restriction.lua';
import { MUTATION_COMMON_LUA } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { MAX_LEASE_CEILING_MS, MAX_PERMIT_TTL_MS } from '../../reservation-fence/types/reservation-mutation.types';

export const MAX_FRESHNESS_CLOCK_SKEW_MS = 5000;

export const freshnessPermitKey = (requestId: string): string => `reservation:fence:w1-freshness:${requestId}`;
export const freshnessReceiptKey = (requestId: string): string => `reservation:fence:w1-freshness:receipt:${requestId}`;

const FRESHNESS_COMMON_LUA =
  MUTATION_COMMON_LUA +
  PRODUCT_CONTROL_FUNCTIONS +
  `
local function domainFail(reason)
  return cjson.encode({code='DOMAIN_FAILURE', reason=reason})
end
local function timestampValid(value)
  return type(value)=='number' and value>0 and value<=${MAX_LEASE_CEILING_MS} and value==math.floor(value)
end
local function ownershipAbsent(e)
  return (e.checkoutOperationId==nil or e.checkoutOperationId==cjson.null) and
    (e.checkoutAttemptId==nil or e.checkoutAttemptId==cjson.null) and
    (e.checkoutIdempotencyKey==nil or e.checkoutIdempotencyKey==cjson.null) and
    (e.checkoutPendingAt==nil or e.checkoutPendingAt==cjson.null) and
    (e.checkoutPendingExpiresAt==nil or e.checkoutPendingExpiresAt==cjson.null)
end
local function guardShapeValid(guard)
  return fields(guard,3) and resourceValid(guard.resource) and uuid(guard.incarnation) and integer(guard.epoch)
end
local function entryShapeValid(entry)
  if type(entry)~='table' or entry.version~=1 or (entry.status~='ACTIVE' and entry.status~='CHECKOUT_PENDING') then return false end
  if not integer(entry.quantity) or entry.quantity<1 or type(entry.cartId)~='string' or #entry.cartId==0 or
    type(entry.customerId)~='string' or #entry.customerId==0 then return false end
  if not timestampValid(entry.createdAt) or not timestampValid(entry.absoluteExpiresAt) or
    entry.absoluteExpiresAt<entry.createdAt then return false end
  if entry.expiresAt~=nil and entry.expiresAt~=cjson.null and
    (not timestampValid(entry.expiresAt) or entry.expiresAt>entry.absoluteExpiresAt) then return false end
  if entry.lastRenewedAt~=nil and entry.lastRenewedAt~=cjson.null and
    (not timestampValid(entry.lastRenewedAt) or entry.lastRenewedAt<entry.createdAt or
     entry.lastRenewedAt>entry.absoluteExpiresAt) then return false end
  if entry.markerId~=nil and entry.markerId~=cjson.null and type(entry.markerId)~='string' then return false end
  return true
end
local function matchesActive(e,g,resource,tuple)
  return guardShapeValid(g) and g.incarnation==tuple.incarnation and g.epoch==tuple.epoch and
    sameResource(g.resource,resource) and entryShapeValid(e) and e.status=='ACTIVE' and ownershipAbsent(e) and
    e.cartId==resource.cartId and e.customerId==resource.customerId and e.markerId==resource.markerId and
    e.generation==resource.generation and e.holdInstanceId==resource.holdInstanceId and
    e.reservationExecutionEpoch==tuple.epoch
end
local function permitValid(a)
  return fields(a,12) and a.version==1 and a.effect=='FRESHNESS_SWEEP' and a.authorizationPhase=='OPEN' and
    tupleValid(a.tuple) and uuid(a.requestId) and uuid(a.cutoverRunId) and integer(a.barrierRevision) and
    a.barrierRevision>0 and resourceValid(a.target) and integer(a.quantity) and a.quantity>=1 and
    timestampValid(a.anchorNowMs) and type(a.expiresAt)=='number' and
    integer(a.controlRevision) and a.controlRevision>=0 and (a.controlRevision%2)==0
end
local function receiptMatchesPermit(rec,a,r)
  return type(rec)=='table' and rec.version==1 and rec.effect=='FRESHNESS_SWEEP' and rec.status=='APPLIED' and
    rec.requestId==a.requestId and rec.cutoverRunId==a.cutoverRunId and rec.barrierRevision==a.barrierRevision and
    not compareTuple(rec.tuple,a.tuple) and sameResource(rec.target,r) and rec.quantity==a.quantity and
    rec.anchorNowMs==a.anchorNowMs and rec.newCreatedAtMs==a.anchorNowMs and
    rec.newLastRenewedAtMs==a.anchorNowMs and timestampValid(rec.priorCreatedAtMs) and
    timestampValid(rec.priorAbsoluteExpiresAtMs) and timestampValid(rec.newExpiresAtMs) and
    timestampValid(rec.newAbsoluteExpiresAtMs) and rec.newExpiresAtMs>a.anchorNowMs and
    rec.newExpiresAtMs<=a.anchorNowMs+${RESERVATION_TTL_SECONDS * 1000} and
    rec.newAbsoluteExpiresAtMs>a.anchorNowMs and
    rec.newAbsoluteExpiresAtMs<=a.anchorNowMs+${MAX_RESERVATION_LIFETIME_SECONDS * 1000} and
    rec.newExpiresAtMs<=rec.newAbsoluteExpiresAtMs
end
`;

export const REGISTER_FRESHNESS_RESET_LUA =
  FRESHNESS_COMMON_LUA +
  `
local a=decode(ARGV[1])
if not permitValid(a) then return rejected('MALFORMED_PERMIT') end
local current,err=control(a.tuple)
if err then return rejected(err) end
if current.phase~='OPEN' then return rejected('PHASE_DENIED') end
local r=a.target
local history='reservation:fence:initialization-history'
if redis.call('TYPE',history).ok~='hash' or redis.call('HGET',history,'incarnation')~=a.tuple.incarnation then
  return rejected('MISSING_INITIALIZATION_HISTORY') end
if not productAllowed(r.productId,a.tuple,a.controlRevision) then return rejected('CAPABILITY_REVOKED') end
if KEYS[2]~='reservation:fence:w1-freshness:'..a.requestId or redis.call('EXISTS',KEYS[2])~=0 then
  return rejected('REPLAY_MISMATCH') end
a.expiresAt=nowMs()+${MAX_PERMIT_TTL_MS}
redis.call('SET',KEYS[2],cjson.encode(a),'PX',${MAX_PERMIT_TTL_MS},'NX')
return accepted(a)
`;

export const EXECUTE_FRESHNESS_RESET_LUA =
  FRESHNESS_COMMON_LUA +
  `
local a=decode(ARGV[1])
if not permitValid(a) then return rejected('MALFORMED_PERMIT') end
local current,err=control(a.tuple)
if err then return rejected(err) end
if current.phase~='OPEN' then return rejected('PHASE_DENIED') end
local r=a.target
local history='reservation:fence:initialization-history'
if redis.call('TYPE',history).ok~='hash' or redis.call('HGET',history,'incarnation')~=a.tuple.incarnation then
  return rejected('MISSING_INITIALIZATION_HISTORY') end
if not productAllowed(r.productId,a.tuple,a.controlRevision) then return rejected('CAPABILITY_REVOKED') end
if KEYS[2]~='reservation:fence:w1-freshness:'..a.requestId then return rejected('MISSING_PERMIT') end
local stored,se=read(KEYS[2])
if se or not permitValid(stored) or compareTuple(stored.tuple,a.tuple) or stored.requestId~=a.requestId or
  stored.cutoverRunId~=a.cutoverRunId or stored.barrierRevision~=a.barrierRevision or
  stored.expiresAt~=a.expiresAt or stored.quantity~=a.quantity or stored.anchorNowMs~=a.anchorNowMs or
  (stored.controlRevision~=nil)~=(a.controlRevision~=nil) or stored.controlRevision~=a.controlRevision or
  not sameResource(stored.target,r) then return rejected('MISSING_PERMIT') end
local now=nowMs()
if a.expiresAt<=now then return rejected('EXPIRED_PERMIT') end
if KEYS[3]~='reservation:fence:w1-freshness:receipt:'..a.requestId then return rejected('PERMIT_SCOPE_MISMATCH') end

local guardKey='reservation:fence:resource:'..r.markerId
local entryKey='inv:reserved:{'..r.cartId..'}:'..r.productId
local cartIndex='inv:reserved:cart-index:{'..r.cartId..'}'
local productIndex='inv:reserved:product-index:{'..r.productId..'}'
local totalKey='inv:reserved:product-total:{'..r.productId..'}'
local suspectKey='inv:reserved:product-total-suspect:{'..r.productId..'}'

local recKind=redis.call('TYPE',KEYS[3]).ok
if recKind~='none' and recKind~='string' then return domainFail('AMBIGUOUS_EXECUTION_EVIDENCE') end
local existingRaw=redis.call('GET',KEYS[3])
local e,ee=read(entryKey)
local g,ge=read(guardKey)

if existingRaw then
  local rec=decode(existingRaw)
  if not receiptMatchesPermit(rec,a,r) then return rejected('REPLAY_MISMATCH') end
  if ee or ge or not matchesActive(e,g,r,a.tuple) or e.quantity~=a.quantity or
    e.reservationMutationId~=a.requestId or e.createdAt~=a.anchorNowMs or
    e.absoluteExpiresAt~=rec.newAbsoluteExpiresAtMs then
    return domainFail('AMBIGUOUS_EXECUTION_EVIDENCE') end
  return accepted({rawReceipt=existingRaw,replayed=true})
end

if math.abs(now-a.anchorNowMs)>${MAX_FRESHNESS_CLOCK_SKEW_MS} then
  return domainFail('CLOCK_SKEW_EXCEEDED') end
if redis.call('EXISTS',suspectKey)~=0 then
  return domainFail('RESERVATION_PRODUCT_SUSPENDED') end
if redis.call('EXISTS','reservation:fence:checkout-pin:'..r.markerId)~=0 then
  return rejected('CHECKOUT_IN_PROGRESS') end
if ge=='MALFORMED' or (g~=nil and not guardShapeValid(g)) then return rejected('MALFORMED_RESOURCE_GUARD') end
if ee=='MALFORMED' or (e~=nil and not entryShapeValid(e)) then return rejected('MALFORMED_RESOURCE') end
if e and (e.status=='CHECKOUT_PENDING' or not ownershipAbsent(e)) then
  return rejected('CHECKOUT_IN_PROGRESS') end
if ee or ge or not matchesActive(e,g,r,a.tuple) or redis.call('HEXISTS',history,guardKey)~=1 or
  e.quantity~=a.quantity then
  return rejected('RESOURCE_GENERATION_MISMATCH') end
if e.createdAt>now+${MAX_FRESHNESS_CLOCK_SKEW_MS} or e.absoluteExpiresAt<=now then
  return rejected('RESOURCE_GENERATION_MISMATCH') end

if redis.call('TYPE',cartIndex).ok~='set' or redis.call('TYPE',productIndex).ok~='set' or
  redis.call('SISMEMBER',cartIndex,r.productId)~=1 or redis.call('SISMEMBER',productIndex,r.cartId)~=1 then
  return rejected('ACCOUNTING_CORRUPTION') end
if redis.call('TYPE',totalKey).ok~='string' then return rejected('ACCOUNTING_CORRUPTION') end
local rawTotal=redis.call('GET',totalKey)
if type(rawTotal)~='string' or not string.match(rawTotal,'^%d+$') then return rejected('ACCOUNTING_CORRUPTION') end
local total=tonumber(rawTotal)
if not total or total<0 or total>9007199254740991 or total~=math.floor(total) then return rejected('ACCOUNTING_CORRUPTION') end
if total<e.quantity then return rejected('ACCOUNTING_UNDERFLOW') end

local newCreatedAt=a.anchorNowMs
local newLastRenewedAt=a.anchorNowMs
local newAbsoluteExpiresAt=a.anchorNowMs+${MAX_RESERVATION_LIFETIME_SECONDS * 1000}
local newExpiresAt=math.min(a.anchorNowMs+${RESERVATION_TTL_SECONDS * 1000},newAbsoluteExpiresAt)
if newAbsoluteExpiresAt>${MAX_LEASE_CEILING_MS} then return rejected('PERMIT_SCOPE_MISMATCH') end

local receipt={
  version=1,
  effect='FRESHNESS_SWEEP',
  status='APPLIED',
  requestId=a.requestId,
  cutoverRunId=a.cutoverRunId,
  barrierRevision=a.barrierRevision,
  tuple=a.tuple,
  target=r,
  quantity=e.quantity,
  anchorNowMs=a.anchorNowMs,
  priorCreatedAtMs=e.createdAt,
  priorLastRenewedAtMs=(e.lastRenewedAt~=nil and e.lastRenewedAt~=cjson.null) and e.lastRenewedAt or cjson.null,
  priorExpiresAtMs=(e.expiresAt~=nil and e.expiresAt~=cjson.null) and e.expiresAt or cjson.null,
  priorAbsoluteExpiresAtMs=e.absoluteExpiresAt,
  newCreatedAtMs=newCreatedAt,
  newLastRenewedAtMs=newLastRenewedAt,
  newExpiresAtMs=newExpiresAt,
  newAbsoluteExpiresAtMs=newAbsoluteExpiresAt
}
e.createdAt=newCreatedAt
e.lastRenewedAt=newLastRenewedAt
e.expiresAt=newExpiresAt
e.absoluteExpiresAt=newAbsoluteExpiresAt
e.reservationMutationId=a.requestId

local rawReceipt=cjson.encode(receipt)
redis.call('SET',entryKey,cjson.encode(e),'PXAT',newAbsoluteExpiresAt)
redis.call('SET',KEYS[3],rawReceipt,'PXAT',newAbsoluteExpiresAt,'NX')
return accepted({rawReceipt=rawReceipt,replayed=false})
`;

export const OBSERVE_FRESHNESS_RESET_LUA =
  FRESHNESS_COMMON_LUA +
  `
local a=decode(ARGV[1])
if type(a)~='table' or a.version~=1 or not uuid(a.requestId) or not uuid(a.cutoverRunId) or
  not integer(a.barrierRevision) or a.barrierRevision<=0 or not tupleValid(a.tuple) or
  not resourceValid(a.target) or not integer(a.quantity) or a.quantity<1 or
  not timestampValid(a.anchorNowMs) then return rejected('MALFORMED_PERMIT') end
if KEYS[2]~='reservation:fence:w1-freshness:receipt:'..a.requestId then return rejected('PERMIT_SCOPE_MISMATCH') end
local r=a.target
local guardKey='reservation:fence:resource:'..r.markerId
local entryKey='inv:reserved:{'..r.cartId..'}:'..r.productId
local recKind=redis.call('TYPE',KEYS[2]).ok
if recKind~='none' and recKind~='string' then return domainFail('AMBIGUOUS_EXECUTION_EVIDENCE') end
local rawReceipt=redis.call('GET',KEYS[2])
local e,ee=read(entryKey)
local g,ge=read(guardKey)

if not rawReceipt then
  if ee=='MALFORMED' or ge=='MALFORMED' then return domainFail('AMBIGUOUS_EXECUTION_EVIDENCE') end
  if type(e)=='table' and (e.reservationMutationId==a.requestId or
    (e.markerId==r.markerId and e.generation==r.generation and e.createdAt==a.anchorNowMs and
     e.reservationExecutionEpoch==a.tuple.epoch)) then
    return domainFail('AMBIGUOUS_EXECUTION_EVIDENCE') end
  return accepted({state='NOT_APPLIED'})
end

local rec=decode(rawReceipt)
if not receiptMatchesPermit(rec,a,r) then return domainFail('AMBIGUOUS_EXECUTION_EVIDENCE') end
if ee or ge or not matchesActive(e,g,r,a.tuple) or e.quantity~=a.quantity or
  e.reservationMutationId~=a.requestId or e.createdAt~=a.anchorNowMs or
  e.absoluteExpiresAt~=rec.newAbsoluteExpiresAtMs then
  return domainFail('AMBIGUOUS_EXECUTION_EVIDENCE') end
return accepted({state='APPLIED',rawReceipt=rawReceipt})
`;
