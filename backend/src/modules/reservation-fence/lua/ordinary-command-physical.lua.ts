import { MUTATION_COMMON_LUA } from './reservation-mutation-common.lua';
import { PRODUCT_CONTROL_FUNCTIONS } from './product-reservation-restriction.lua';
import { ORDINARY_INVALIDATION_PHYSICAL_GUARD } from './ordinary-invalidation.lua';
import { MAX_RESERVATION_LIFETIME_SECONDS, RESERVATION_TTL_SECONDS } from '../../inventory/constants/inventory.constants';

// Standalone Redis only: existing cart/product hash tags and global control
// keys span slots. Scripts are inactive; no existing writer imports this file.
const COMMON = MUTATION_COMMON_LUA + PRODUCT_CONTROL_FUNCTIONS + ORDINARY_INVALIDATION_PHYSICAL_GUARD + `
local function deny() return cjson.encode({code='REJECTED'}) end
local function identityValid(i)
  if not fields(i,16) or i.version~=1 or not uuid(i.commandId) or not uuid(i.replayId) or
    not integer(i.sequence) or not integer(i.expectedSequence) or i.sequence<=i.expectedSequence or
    not integer(i.mutationVersion) or not uuid(i.incarnation) or not integer(i.epoch) or i.epoch<1 or
    not uuid(i.ownerId) or not resourceValid(i.target) then return false end
  if i.source~=cjson.null then
    if not resourceValid(i.source) or not uuid(i.sourceOwnerId) or i.source.markerId~=i.target.markerId or
      i.source.cartId~=i.target.cartId or i.source.customerId~=i.target.customerId or
      i.source.productId~=i.target.productId then return false end
  elseif i.sourceOwnerId~=cjson.null then return false end
  if i.action=='RELEASE' then return i.source==cjson.null and i.sourceOwnerId==cjson.null and i.transition==cjson.null and i.quantity==cjson.null and type(i.parent)=='string' end
  if i.action=='CANCEL_W1' then return i.transition==cjson.null and i.quantity==cjson.null and type(i.parent)=='string' end
  if i.action~='W1' or i.parent~=cjson.null or not integer(i.quantity) or i.quantity<1 then return false end
  if i.transition=='INITIAL' then return i.source==cjson.null end
  if i.transition=='SAME_GENERATION' then return i.sourceOwnerId==i.ownerId and sameResource(i.source,i.target) end
  return i.transition=='IMMEDIATE_PREDECESSOR' and i.source~=cjson.null and i.sourceOwnerId~=i.ownerId and
    i.source.generation+1==i.target.generation
end
local function cleanOwner(e)
  return (e.checkoutOperationId==nil or e.checkoutOperationId==cjson.null) and
    (e.checkoutAttemptId==nil or e.checkoutAttemptId==cjson.null) and
    (e.checkoutIdempotencyKey==nil or e.checkoutIdempotencyKey==cjson.null)
end
local function entryMatches(e,r,i)
  return type(e)=='table' and e.version==1 and e.status=='ACTIVE' and cleanOwner(e) and
    e.cartId==r.cartId and e.customerId==r.customerId and e.markerId==r.markerId and
    e.generation==r.generation and e.holdInstanceId==r.holdInstanceId and e.reservationExecutionEpoch==i.epoch
end
local function receiptValid(v,expected)
  if not fields(v,5) or v.version~=1 or v.complete~=true or type(v.identity)~='string' or
    (expected and v.identity~=expected) then return false end
  local i=decode(v.identity)
  if not identityValid(i) or v.action~=i.action then return false end
  if i.action=='CANCEL_W1' then return v.result=='CANCELLED' end
  if i.action=='RELEASE' then return v.result=='RELEASED' end
  local e=v.result
  return entryMatches(e,i.target,i) and e.quantity==i.quantity and e.reservationMutationId==i.replayId and
    type(e.createdAt)=='number' and type(e.lastRenewedAt)=='number' and type(e.expiresAt)=='number' and
    type(e.absoluteExpiresAt)=='number' and e.createdAt<=e.lastRenewedAt and e.lastRenewedAt<e.expiresAt and
    e.expiresAt<=e.absoluteExpiresAt
end
local function scope(i)
  return KEYS[2]=='reservation:fence:initialization-history' and
    KEYS[3]=='reservation:fence:ordinary-command:'..i.target.markerId and
    redis.call('TYPE',KEYS[2]).ok=='hash' and redis.call('HGET',KEYS[2],'incarnation')==i.incarnation
end
local function receipt(id,expected)
  local raw=redis.call('HGET',KEYS[3],'receipt:'..id)
  if not raw then return nil,nil end
  local v=decode(raw)
  if not receiptValid(v,expected) then return nil,'BAD' end
  local i=decode(v.identity)
  if i.commandId~=id then return nil,'BAD' end
  return {raw=raw,value=v,identity=i},nil
end
local function cursor(i)
  if not scope(i) or redis.call('TYPE',KEYS[3]).ok~='hash' or redis.call('HGET',KEYS[2],KEYS[3])~='1' then return nil end
  local c=decode(redis.call('HGET',KEYS[3],'cursor'))
  local root=decode(redis.call('HGET',KEYS[3],'genesis'))
  if not fields(c,7) or c.version~=1 or c.markerId~=i.target.markerId or c.incarnation~=i.incarnation or c.epoch~=i.epoch or
    not integer(c.sequence) or not identityValid(root) or root.action~='W1' or root.transition~='INITIAL' or
    root.expectedSequence~=0 or root.incarnation~=i.incarnation or root.epoch~=i.epoch or root.target.markerId~=c.markerId then return nil end
  if c.sequence==0 then
    if c.commandId~=cjson.null or c.replayId~=cjson.null then return nil end
  else
    if not uuid(c.commandId) or not uuid(c.replayId) then return nil end
    local v,err=receipt(c.commandId,nil)
    if err or not v or v.identity.sequence~=c.sequence or v.identity.replayId~=c.replayId or
      v.identity.incarnation~=c.incarnation or v.identity.epoch~=c.epoch or v.identity.target.markerId~=c.markerId then return nil end
  end
  return c
end
local function completed(code,v)
  return cjson.encode({code=code,identity=v.value.identity,receipt=v.raw})
end
local function outcome(i,identity,c)
  local v,err=receipt(i.commandId,identity)
  if err then return deny() end
  local tomb=redis.call('HGET',KEYS[3],'cancelled:'..i.commandId)
  if v then
    if tomb or c.sequence<i.sequence then return deny() end
    if i.action=='CANCEL_W1' then
      local p=decode(i.parent)
      if not identityValid(p) or redis.call('HGET',KEYS[3],'cancelled:'..p.commandId)~=identity or
        redis.call('HEXISTS',KEYS[3],'receipt:'..p.commandId)==1 then return deny() end
    end
    return completed('COMPLETED',v)
  end
  if tomb then
    local cancel=decode(tomb)
    if not identityValid(cancel) or cancel.action~='CANCEL_W1' or cancel.parent~=identity then return deny() end
    local cr,ce=receipt(cancel.commandId,tomb)
    if ce or not cr or c.sequence<cancel.sequence then return deny() end
    return completed('CANCELLED',cr)
  end
  return nil
end
`;

export const ORDINARY_PHYSICAL_REGISTER = COMMON + `
local g=decode(ARGV[1])
if not fields(g,(g and g.releasePublication) and 8 or ((g and g.barrierBinding) and 7 or 6)) or g.version~=1 or not uuid(g.grantId) or type(g.identity)~='string' or g.expiresAt~=0 or
  (g.purpose~='GENESIS' and g.purpose~='EXECUTE') or KEYS[4]~='reservation:fence:ordinary-command-grant:'..g.grantId then return deny() end
local i=decode(g.identity)
if not identityValid(i) or not scope(i) or not (i.action=='RELEASE' and releaseBarrierAllowed(i,g.barrierBinding,g.releasePublication) or i.action~='RELEASE' and ordinaryBarrierAllowed(i,g.barrierBinding)) then return deny() end
if i.action=='RELEASE' and (g.purpose~='EXECUTE' or not g.releasePublication) then return deny() end
local current,err=control(g.tuple)
if err or (current.phase~='OPEN' and not (i.action=='RELEASE' and current.phase=='DRAINING')) or current.incarnation~=i.incarnation or current.epoch~=i.epoch or
  redis.call('EXISTS',KEYS[4])~=0 then return deny() end
g.expiresAt=nowMs()+5000
redis.call('SET',KEYS[4],cjson.encode(g),'PX',5000,'NX')
return cjson.encode({code='REGISTERED'})
`;

const GRANT = COMMON + `
local request=decode(ARGV[1])
if not fields(request,(request and request.releasePublication) and 8 or ((request and request.barrierBinding) and 7 or 6)) or not uuid(request.grantId) or KEYS[4]~='reservation:fence:ordinary-command-grant:'..request.grantId then return deny() end
local g,ge=read(KEYS[4])
if ge or not fields(g,(g and g.releasePublication) and 8 or ((g and g.barrierBinding) and 7 or 6)) or g.version~=1 or g.grantId~=request.grantId or g.identity~=request.identity or
  g.purpose~=request.purpose or compareTuple(g.tuple,request.tuple) or type(g.expiresAt)~='number' or
  g.expiresAt<=nowMs() or g.expiresAt>nowMs()+5000 then return deny() end
local i=decode(g.identity)
if not identityValid(i) or not scope(i) or not (i.action=='RELEASE' and releaseBarrierAllowed(i,g.barrierBinding,g.releasePublication) or i.action~='RELEASE' and ordinaryBarrierAllowed(i,g.barrierBinding)) or
 (g.barrierBinding~=nil)~=(request.barrierBinding~=nil) then return deny() end
if (g.releasePublication~=nil)~=(request.releasePublication~=nil) then return deny() end
if g.releasePublication and (not fields(request.releasePublication,3) or g.releasePublication.global~=request.releasePublication.global
 or g.releasePublication.marker~=request.releasePublication.marker or g.releasePublication.ownershipReceipt~=request.releasePublication.ownershipReceipt) then return deny() end
if g.barrierBinding then
 if not fields(request.barrierBinding,8) then return deny() end
 for key,value in pairs(g.barrierBinding) do if request.barrierBinding[key]~=value then return deny() end end
end
local current,err=control(g.tuple)
if err or (current.phase~='OPEN' and not (i.action=='RELEASE' and current.phase=='DRAINING')) or current.incarnation~=i.incarnation or current.epoch~=i.epoch then return deny() end
local r=i.target
local entryKey='inv:reserved:{'..r.cartId..'}:'..r.productId
local guardKey='reservation:fence:resource:'..r.markerId
local pinKey='reservation:fence:checkout-pin:'..r.markerId
local cartIndex='inv:reserved:cart-index:{'..r.cartId..'}'
local productIndex='inv:reserved:product-index:{'..r.productId..'}'
local totalKey='inv:reserved:product-total:{'..r.productId..'}'
local suspectKey='inv:reserved:product-total-suspect:{'..r.productId..'}'
`;

export const ORDINARY_PHYSICAL_GENESIS = GRANT + `
if i.action=='W1' and not productAllowed(i.target.productId,g.tuple) then return deny() end
if g.purpose~='GENESIS' then return deny() end
local root=i.action=='W1' and i or decode(i.parent)
if not identityValid(root) or root.action~='W1' or root.transition~='INITIAL' or root.expectedSequence~=0 or
  root.incarnation~=i.incarnation or root.epoch~=i.epoch or not sameResource(root.target,r) or root.ownerId~=i.ownerId then return deny() end
local rootIdentity=i.action=='W1' and g.identity or i.parent
if redis.call('EXISTS',KEYS[3])~=0 or redis.call('HEXISTS',KEYS[2],KEYS[3])~=0 then
  local c=cursor(i)
  if not c or redis.call('HGET',KEYS[3],'genesis')~=rootIdentity then return deny() end
  return cjson.encode({code='INITIALIZED'})
end
if redis.call('EXISTS',entryKey)~=0 or redis.call('EXISTS',guardKey)~=0 or redis.call('EXISTS',pinKey)~=0 or
  redis.call('HEXISTS',KEYS[2],guardKey)~=0 then return deny() end
for _,key in ipairs({cartIndex,productIndex}) do
  local t=redis.call('TYPE',key).ok if t~='none' and t~='set' then return deny() end
end
if redis.call('SISMEMBER',cartIndex,r.productId)~=0 or redis.call('SISMEMBER',productIndex,r.cartId)~=0 then return deny() end
local c={version=1,markerId=r.markerId,incarnation=i.incarnation,epoch=i.epoch,sequence=0,commandId=cjson.null,replayId=cjson.null}
redis.call('HSET',KEYS[3],'cursor',cjson.encode(c),'genesis',rootIdentity)
redis.call('HSET',KEYS[2],KEYS[3],'1')
return cjson.encode({code='INITIALIZED'})
`;

export const ORDINARY_PHYSICAL_OBSERVE = COMMON + `
local identity=ARGV[1]
local i=decode(identity)
if not identityValid(i) then return deny() end
local c=cursor(i)
if not c then return deny() end
local found=outcome(i,identity,c)
if found then return found end
if i.action=='CANCEL_W1' then
  local p=decode(i.parent)
  if not identityValid(p) then return deny() end
  local v,err=receipt(p.commandId,i.parent)
  if err then return deny() end
  if v and c.sequence>=p.sequence and redis.call('HEXISTS',KEYS[3],'cancelled:'..p.commandId)==0 then return completed('EXECUTION_WON',v) end
end
return deny()
`;

export const ORDINARY_PHYSICAL_EXECUTE = GRANT + `
if i.action=='W1' and not productAllowed(i.target.productId,g.tuple) then return deny() end
if g.purpose~='EXECUTE' then return deny() end
local c=cursor(i)
if not c then return deny() end
local found=outcome(i,g.identity,c)
if found then return found end
if i.action=='CANCEL_W1' then
  local p=decode(i.parent)
  if not identityValid(p) or p.action~='W1' or p.ownerId~=i.ownerId or not sameResource(p.target,r) or
    p.incarnation~=i.incarnation or p.epoch~=i.epoch or p.expectedSequence~=i.expectedSequence or p.sequence>=i.sequence then return deny() end
  local prior,pe=receipt(p.commandId,i.parent)
  if pe then return deny() end
  if prior then
    if c.sequence<p.sequence or redis.call('HEXISTS',KEYS[3],'cancelled:'..p.commandId)~=0 then return deny() end
    return completed('EXECUTION_WON',prior)
  end
  if c.sequence~=i.expectedSequence or redis.call('HEXISTS',KEYS[3],'cancelled:'..p.commandId)~=0 then return deny() end
  local raw=cjson.encode({version=1,identity=g.identity,action=i.action,complete=true,result='CANCELLED'})
  c.sequence=i.sequence c.commandId=i.commandId c.replayId=i.replayId
  redis.call('HSET',KEYS[3],'cursor',cjson.encode(c),'receipt:'..i.commandId,raw,'cancelled:'..p.commandId,g.identity)
  return cjson.encode({code='COMPLETED',identity=g.identity,receipt=raw})
end
if c.sequence~=i.expectedSequence or redis.call('EXISTS',pinKey)~=0 then return deny() end
local e,ee=read(entryKey)
local guard,ge=read(guardKey)
if ee=='MALFORMED' or ge=='MALFORMED' then return deny() end
if i.action=='RELEASE' then
 local p=decode(i.parent)
 if not identityValid(p) or p.action~='W1' or p.ownerId~=i.ownerId or not sameResource(p.target,r)
  or p.incarnation~=i.incarnation or p.epoch~=i.epoch or p.sequence>i.expectedSequence then return deny() end
 local prior,pe=receipt(p.commandId,i.parent)
 if pe or not prior or prior.raw~=g.releasePublication.ownershipReceipt or ee or ge or not fields(guard,3) or guard.incarnation~=i.incarnation or guard.epoch~=i.epoch
  or not sameResource(guard.resource,r) or not entryMatches(e,r,i) or e.quantity~=p.quantity
  or e.reservationMutationId~=p.replayId or redis.call('HEXISTS',KEYS[2],guardKey)~=1 then return deny() end
 for _,key in ipairs({cartIndex,productIndex}) do if redis.call('TYPE',key).ok~='set' then return deny() end end
 if redis.call('SISMEMBER',cartIndex,r.productId)~=1 or redis.call('SISMEMBER',productIndex,r.cartId)~=1
  or redis.call('TYPE',totalKey).ok~='string' then return deny() end
 local total=tonumber(redis.call('GET',totalKey))
 if not total or total~=math.floor(total) or total>9007199254740991 or total<e.quantity then return deny() end
 local raw=cjson.encode({version=1,identity=g.identity,action=i.action,complete=true,result='RELEASED'})
 c.sequence=i.sequence c.commandId=i.commandId c.replayId=i.replayId
 local cursorRaw=cjson.encode(c)
 redis.call('DEL',entryKey)
 redis.call('SREM',cartIndex,r.productId) redis.call('SREM',productIndex,r.cartId)
 redis.call('SET',totalKey,string.format('%.0f',total-e.quantity))
 redis.call('HSET',KEYS[3],'cursor',cursorRaw,'receipt:'..i.commandId,raw)
 return cjson.encode({code='COMPLETED',identity=g.identity,receipt=raw})
end
if i.transition=='INITIAL' then
  if e or guard or redis.call('HEXISTS',KEYS[2],guardKey)==1 then return deny() end
else
  if ee or ge or not fields(guard,3) or guard.incarnation~=i.incarnation or guard.epoch~=i.epoch or
    not sameResource(guard.resource,i.source) or not entryMatches(e,i.source,i) or
    redis.call('HEXISTS',KEYS[2],guardKey)~=1 then return deny() end
end
for _,key in ipairs({cartIndex,productIndex}) do
  local kind=redis.call('TYPE',key).ok if kind~='none' and kind~='set' then return deny() end
end
local kind=redis.call('TYPE',totalKey).ok
if kind~='none' and kind~='string' then return deny() end
local total=tonumber(redis.call('GET',totalKey) or '0')
if not total or total<0 or total>9007199254740991 or total~=math.floor(total) then return deny() end
local now=nowMs()
local old=0
if e then
  if not integer(e.quantity) or e.quantity<1 or type(e.absoluteExpiresAt)~='number' or
    type(e.createdAt)~='number' or e.absoluteExpiresAt<=now or e.createdAt>now then return deny() end
  old=e.quantity
  if redis.call('SISMEMBER',cartIndex,r.productId)~=1 or redis.call('SISMEMBER',productIndex,r.cartId)~=1 then return deny() end
elseif redis.call('SISMEMBER',cartIndex,r.productId)~=0 or redis.call('SISMEMBER',productIndex,r.cartId)~=0 then return deny() end
if total<old or total-old+i.quantity>9007199254740991 or
  (redis.call('EXISTS',suspectKey)~=0 and i.quantity>old) then return deny() end
e=e or {version=1,cartId=r.cartId,customerId=r.customerId,status='ACTIVE',createdAt=now,
  absoluteExpiresAt=now+${MAX_RESERVATION_LIFETIME_SECONDS * 1000},checkoutIdempotencyKey=cjson.null,
  checkoutPendingAt=cjson.null,checkoutPendingExpiresAt=cjson.null}
e.quantity=i.quantity e.lastRenewedAt=now e.expiresAt=math.min(now+${RESERVATION_TTL_SECONDS * 1000},e.absoluteExpiresAt)
e.markerId=r.markerId e.generation=r.generation e.holdInstanceId=r.holdInstanceId
e.reservationExecutionEpoch=i.epoch e.reservationMutationId=i.replayId
local entryRaw=cjson.encode(e)
local guardRaw=cjson.encode({incarnation=i.incarnation,epoch=i.epoch,resource=r})
local receiptRaw=cjson.encode({version=1,identity=g.identity,action=i.action,complete=true,result=e})
c.sequence=i.sequence c.commandId=i.commandId c.replayId=i.replayId
local cursorRaw=cjson.encode(c)
-- All predictable validation and encoding precedes this write boundary.
redis.call('SET',entryKey,entryRaw,'PXAT',e.absoluteExpiresAt)
redis.call('SET',guardKey,guardRaw)
redis.call('HSET',KEYS[2],guardKey,'1')
redis.call('SET',totalKey,string.format('%.0f',total-old+i.quantity))
redis.call('SADD',cartIndex,r.productId) redis.call('SADD',productIndex,r.cartId)
redis.call('HSET',KEYS[3],'cursor',cursorRaw,'receipt:'..i.commandId,receiptRaw)
return cjson.encode({code='COMPLETED',identity=g.identity,receipt=receiptRaw})
`;
