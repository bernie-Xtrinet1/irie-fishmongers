import { MUTATION_COMMON_LUA } from './reservation-mutation-common.lua';
import { PRODUCT_CONTROL_FUNCTIONS } from './product-reservation-restriction.lua';

const CLEARANCE_HELPERS_LUA = MUTATION_COMMON_LUA + PRODUCT_CONTROL_FUNCTIONS + `
local function hex64(s)
  return type(s)=='string' and #s==64 and string.match(s,'^[0-9a-f]+$')~=nil
end
local function nonEmptyStr(s)
  return type(s)=='string' and #s>0 and not string.find(s,'[{}%s]')
end
local function encodeControlJson(productId,state,restrictionId,revision,incarnation,epoch)
  local rId = restrictionId and cjson.encode(restrictionId) or 'null'
  return '{"version":1,"productId":'..cjson.encode(productId)..',"state":'..cjson.encode(state)..
    ',"restrictionId":'..rId..',"restrictionRevision":'..tostring(revision)..
    ',"incarnation":'..cjson.encode(incarnation)..',"epoch":'..tostring(epoch)..'}'
end
local function encodeReceiptJson(requestId,productId,incarnation,epoch,clearedRev,recDigest,appDigest,targetTotal)
  return '{"version":1,"effect":"PRODUCT_SUSPECT_CLEARANCE","status":"APPLIED","requestId":'..cjson.encode(requestId)..
    ',"productId":'..cjson.encode(productId)..',"incarnation":'..cjson.encode(incarnation)..
    ',"epoch":'..tostring(epoch)..',"clearedControlRevision":'..tostring(clearedRev)..
    ',"reconciliationDigest":'..cjson.encode(recDigest)..',"approvalDigest":'..cjson.encode(appDigest)..
    ',"targetTotal":'..tostring(targetTotal)..'}'
end
local function tupleValid(t)
  return fields(t,6) and uuid(t.incarnation) and integer(t.epoch) and t.epoch>=1 and
    integer(t.revision) and t.revision>=1 and (t.phase=='OPEN' or t.phase=='DRAINING') and
    t.protocol==1 and uuid(t.transitionId)
end
local function activeItemsValid(list)
  if type(list)~='table' then return false end
  for idx,item in pairs(list) do
    if not integer(idx) or idx<1 or idx>#list or not fields(item,3) or not nonEmptyStr(item.cartId) or
      (item.markerId~=cjson.null and not uuid(item.markerId)) or not integer(item.quantity) or item.quantity<1 then
      return false
    end
  end
  return true
end
local function strListValid(list,requireUuid)
  if type(list)~='table' then return false end
  for idx,val in pairs(list) do
    if not integer(idx) or idx<1 or idx>#list then return false end
    if requireUuid and not uuid(val) then return false end
    if not requireUuid and not nonEmptyStr(val) then return false end
  end
  return true
end
local function strListsEqual(a,b)
  if type(a)~='table' or type(b)~='table' or #a~=#b then return false end
  for i=1,#a do if a[i]~=b[i] then return false end end
  return true
end
local function activeListsEqual(a,b)
  if type(a)~='table' or type(b)~='table' or #a~=#b then return false end
  for i=1,#a do
    if a[i].cartId~=b[i].cartId or a[i].markerId~=b[i].markerId or a[i].quantity~=b[i].quantity then return false end
  end
  return true
end
local function permitValid(p)
  if not fields(p,20) or p.version~=1 or p.effect~='PRODUCT_SUSPECT_CLEARANCE' or
    (p.authorizationPhase~='OPEN' and p.authorizationPhase~='DRAINING') or
    not tupleValid(p.tuple) or not uuid(p.requestId) or not nonEmptyStr(p.productId) or not uuid(p.restrictionId) or
    not integer(p.targetRestrictionRevision) or p.targetRestrictionRevision<1 or (p.targetRestrictionRevision%2)~=1 or
    not integer(p.stagedControlRevision) or p.stagedControlRevision<p.targetRestrictionRevision or
    p.stagedControlRevision>=p.clearedControlRevision or
    not integer(p.clearedControlRevision) or p.clearedControlRevision<2 or (p.clearedControlRevision%2)~=0 or
    not hex64(p.reconciliationDigest) or not hex64(p.approvalDigest) or
    (p.priorStoredTotal~=cjson.null and (not integer(p.priorStoredTotal) or p.priorStoredTotal<0)) or
    not integer(p.targetReconciledTotal) or p.targetReconciledTotal<0 or type(p.priorSuspectPresent)~='boolean' or
    not integer(p.permitTtlMs) or p.permitTtlMs<1 or p.permitTtlMs>5000 or
    not activeItemsValid(p.activeReservations) or not strListValid(p.expectedCartIds,false) or
    not strListValid(p.markerIds,true) or type(p.expiresAt)~='number' then
    return false
  end
  return p.tuple.phase==p.authorizationPhase
end
local function checkKeys(p)
  return KEYS[2]=='reservation:fence:w1-clearance:permit:'..p.requestId and
    KEYS[3]=='reservation:fence:w1-clearance:receipt:'..p.requestId and
    KEYS[4]=='reservation:fence:product-control:{'..p.productId..'}' and
    KEYS[5]=='inv:reserved:product-total-suspect:{'..p.productId..'}' and
    KEYS[6]=='inv:reserved:product-total:{'..p.productId..'}' and
    KEYS[7]=='inv:reserved:product-index:{'..p.productId..'}'
end
local function verifyStoredPermit(req)
  if not permitValid(req) or not checkKeys(req) then return nil,'MALFORMED_PERMIT' end
  if redis.call('EXISTS',KEYS[3])~=0 then return nil,'RECEIPT_ALREADY_EXISTS' end
  local stored,err=read(KEYS[2])
  if err or not permitValid(stored) then return nil,'MISSING_PERMIT' end
  local pttl=redis.call('PTTL',KEYS[2])
  local now=nowMs()
  if pttl<=0 or stored.expiresAt<=now or stored.expiresAt>now+stored.permitTtlMs then
    return nil,'PERMIT_EXPIRED'
  end
  if stored.requestId~=req.requestId or stored.productId~=req.productId or stored.restrictionId~=req.restrictionId or
    stored.targetRestrictionRevision~=req.targetRestrictionRevision or
    stored.stagedControlRevision~=req.stagedControlRevision or
    stored.clearedControlRevision~=req.clearedControlRevision or
    stored.reconciliationDigest~=req.reconciliationDigest or
    stored.approvalDigest~=req.approvalDigest or
    stored.authorizationPhase~=req.authorizationPhase or
    compareTuple(stored.tuple,req.tuple) or
    stored.priorStoredTotal~=req.priorStoredTotal or
    stored.targetReconciledTotal~=req.targetReconciledTotal or
    stored.priorSuspectPresent~=req.priorSuspectPresent or
    stored.permitTtlMs~=req.permitTtlMs or
    stored.expiresAt~=req.expiresAt or
    not activeListsEqual(stored.activeReservations,req.activeReservations) or
    not strListsEqual(stored.expectedCartIds,req.expectedCartIds) or
    not strListsEqual(stored.markerIds,req.markerIds) then
    return nil,'PERMIT_MISMATCH'
  end
  local current,cerr=control(stored.tuple)
  if cerr then return nil,cerr end
  if current.phase~=stored.authorizationPhase then return nil,'PHASE_DENIED' end
  local history='reservation:fence:initialization-history'
  if redis.call('TYPE',history).ok~='hash' or redis.call('HGET',history,'incarnation')~=current.incarnation then
    return nil,'MISSING_INITIALIZATION_HISTORY'
  end
  return stored,current
end
local function verifyInventoryPreState(stored,now)
  local suspectPresent = redis.call('EXISTS',KEYS[5])==1
  if suspectPresent~=stored.priorSuspectPresent then return 'SUSPECT_STATE_CHANGED' end
  local totalType=redis.call('TYPE',KEYS[6]).ok
  if stored.priorStoredTotal==cjson.null then
    if totalType~='none' then return 'TOTAL_STATE_CHANGED' end
  else
    if totalType~='string' or redis.call('GET',KEYS[6])~=tostring(stored.priorStoredTotal) then
      return 'TOTAL_STATE_CHANGED'
    end
  end
  for _,markerId in ipairs(stored.markerIds) do
    if redis.call('EXISTS','reservation:fence:checkout-pin:'..markerId)~=0 then return 'CHECKOUT_IN_PROGRESS' end
  end
  local expectedSet={}
  for _,cartId in ipairs(stored.expectedCartIds) do expectedSet[cartId]=true end
  local idxType=redis.call('TYPE',KEYS[7]).ok
  if idxType~='none' then
    if idxType~='set' then return 'CORRUPT_PRODUCT_INDEX' end
    for _,member in ipairs(redis.call('SMEMBERS',KEYS[7])) do
      if not expectedSet[member] then return 'CONCURRENT_MUTATION_DRIFT' end
    end
  end
  local activeMap={}
  local sumActive=0
  for _,item in ipairs(stored.activeReservations) do
    if item.markerId~=cjson.null and redis.call('EXISTS','reservation:fence:checkout-pin:'..item.markerId)~=0 then
      return 'CHECKOUT_IN_PROGRESS'
    end
    if redis.call('SISMEMBER',KEYS[7],item.cartId)~=1 or
      redis.call('SISMEMBER','inv:reserved:cart-index:{'..item.cartId..'}',stored.productId)~=1 then
      return 'INDEX_MEMBERSHIP_DRIFT'
    end
    local entry,ee=read('inv:reserved:{'..item.cartId..'}:'..stored.productId)
    if ee or type(entry)~='table' or entry.version~=1 or entry.cartId~=item.cartId then
      return 'CORRUPT_RESERVATION_ENTRY'
    end
    if type(entry.markerId)=='string' and redis.call('EXISTS','reservation:fence:checkout-pin:'..entry.markerId)~=0 then
      return 'CHECKOUT_IN_PROGRESS'
    end
    if entry.status=='CHECKOUT_PENDING' then return 'CHECKOUT_IN_PROGRESS' end
    if entry.status~='ACTIVE' or not integer(entry.quantity) or entry.quantity~=item.quantity or
      type(entry.expiresAt)~='number' or entry.expiresAt<=now or
      type(entry.absoluteExpiresAt)~='number' or entry.absoluteExpiresAt<=now then
      return 'RESERVATION_STATE_CHANGED'
    end
    activeMap[item.cartId]=true
    sumActive=sumActive+entry.quantity
  end
  for _,cartId in ipairs(stored.expectedCartIds) do
    if not activeMap[cartId] then
      local entry,ee=read('inv:reserved:{'..cartId..'}:'..stored.productId)
      if ee and ee~='MISSING' then return 'CORRUPT_RESERVATION_ENTRY' end
      if entry then
        if type(entry)~='table' then return 'CORRUPT_RESERVATION_ENTRY' end
        if entry.status=='CHECKOUT_PENDING' and type(entry.expiresAt)=='number' and entry.expiresAt>now then
          return 'CHECKOUT_IN_PROGRESS'
        end
        if entry.status=='ACTIVE' and type(entry.expiresAt)=='number' and entry.expiresAt>now then
          return 'CONCURRENT_MUTATION_DRIFT'
        end
      end
    end
  end
  if sumActive~=stored.targetReconciledTotal then return 'RECONCILIATION_MISMATCH' end
  return nil
end
`;

export const REGISTER_PRODUCT_SUSPECT_CLEARANCE_LUA = CLEARANCE_HELPERS_LUA + `
local a=decode(ARGV[1])
if not permitValid(a) or not checkKeys(a) or a.expiresAt~=0 then return rejected('MALFORMED_PERMIT') end
if redis.call('EXISTS',KEYS[3])~=0 then return rejected('RECEIPT_ALREADY_EXISTS') end
local current,cerr=control(a.tuple)
if cerr then return rejected(cerr) end
if current.phase~=a.authorizationPhase then return rejected('PHASE_DENIED') end
local history='reservation:fence:initialization-history'
if redis.call('TYPE',history).ok~='hash' or redis.call('HGET',history,'incarnation')~=current.incarnation then
  return rejected('MISSING_INITIALIZATION_HISTORY')
end
local ctrl,ce=read(KEYS[4])
if ce or not productControlValid(ctrl) or redis.call('PTTL',KEYS[4])~=-1 or
  ctrl.productId~=a.productId or ctrl.incarnation~=current.incarnation or ctrl.epoch~=current.epoch then
  return rejected('CONTROL_STATE_MISMATCH')
end
if not ((ctrl.state=='RESTRICTED' and ctrl.restrictionId==a.restrictionId and ctrl.restrictionRevision==a.targetRestrictionRevision) or
  (ctrl.state=='CLEARANCE_STAGED' and ctrl.restrictionId==a.restrictionId and ctrl.restrictionRevision==a.stagedControlRevision)) then
  return rejected('CONTROL_STATE_MISMATCH')
end
if redis.call('EXISTS',KEYS[2])~=0 then return rejected('REPLAY_MISMATCH') end
a.expiresAt=nowMs()+a.permitTtlMs
local encoded=cjson.encode(a)
redis.call('SET',KEYS[2],encoded,'PX',a.permitTtlMs,'NX')
return accepted(a)
`;

export const STAGE_PRODUCT_SUSPECT_CLEARANCE_LUA = CLEARANCE_HELPERS_LUA + `
local req=decode(ARGV[1])
local stored,currentOrErr=verifyStoredPermit(req)
if not stored then return rejected(currentOrErr) end
local current=currentOrErr
local ctrl,ce=read(KEYS[4])
if ce or not productControlValid(ctrl) or redis.call('PTTL',KEYS[4])~=-1 or
  ctrl.productId~=stored.productId or ctrl.incarnation~=current.incarnation or ctrl.epoch~=current.epoch then
  return rejected('CONTROL_STATE_MISMATCH')
end
if ctrl.state=='CLEARANCE_STAGED' and ctrl.restrictionId==stored.restrictionId and
  ctrl.restrictionRevision==stored.stagedControlRevision then
  return accepted(encodeControlJson(stored.productId,'CLEARANCE_STAGED',stored.restrictionId,stored.stagedControlRevision,current.incarnation,current.epoch))
end
if ctrl.state~='RESTRICTED' or ctrl.restrictionId~=stored.restrictionId or
  ctrl.restrictionRevision~=stored.targetRestrictionRevision then
  return rejected('CONTROL_STATE_MISMATCH')
end
local invErr=verifyInventoryPreState(stored,nowMs())
if invErr then return rejected(invErr) end
local stagedBytes=encodeControlJson(stored.productId,'CLEARANCE_STAGED',stored.restrictionId,stored.stagedControlRevision,current.incarnation,current.epoch)
redis.call('SET',KEYS[4],stagedBytes)
return accepted(stagedBytes)
`;

export const EXECUTE_PRODUCT_SUSPECT_CLEARANCE_LUA = CLEARANCE_HELPERS_LUA + `
local req=decode(ARGV[1])
local stored,currentOrErr=verifyStoredPermit(req)
if not stored then return rejected(currentOrErr) end
local current=currentOrErr
local ctrl,ce=read(KEYS[4])
if ce or not productControlValid(ctrl) or redis.call('PTTL',KEYS[4])~=-1 or
  ctrl.productId~=stored.productId or ctrl.incarnation~=current.incarnation or ctrl.epoch~=current.epoch then
  return rejected('CONTROL_STATE_MISMATCH')
end
if ctrl.state~='CLEARANCE_STAGED' or ctrl.restrictionId~=stored.restrictionId or
  ctrl.restrictionRevision~=stored.stagedControlRevision then
  return rejected('CLEARANCE_NOT_STAGED')
end
local invErr=verifyInventoryPreState(stored,nowMs())
if invErr then return rejected(invErr) end
local allowBytes=encodeControlJson(stored.productId,'ALLOW',nil,stored.clearedControlRevision,current.incarnation,current.epoch)
local receiptBytes=encodeReceiptJson(stored.requestId,stored.productId,current.incarnation,current.epoch,stored.clearedControlRevision,stored.reconciliationDigest,stored.approvalDigest,stored.targetReconciledTotal)
local setOk=redis.call('SET',KEYS[3],receiptBytes,'NX')
if not setOk then return rejected('RECEIPT_ALREADY_EXISTS') end
redis.call('SET',KEYS[6],tostring(stored.targetReconciledTotal))
redis.call('DEL',KEYS[5])
redis.call('SET',KEYS[4],allowBytes)
redis.call('DEL',KEYS[2])
return accepted(receiptBytes)
`;

export const UNSTAGE_PRODUCT_SUSPECT_CLEARANCE_LUA = CLEARANCE_HELPERS_LUA + `
local expected=decode(ARGV[1])
if not fields(expected,6) or not tupleValid(expected.tuple) or not uuid(expected.requestId) or
  not nonEmptyStr(expected.productId) or not uuid(expected.restrictionId) or
  not integer(expected.targetRestrictionRevision) or not integer(expected.stagedControlRevision) then
  return rejected('MALFORMED_UNSTAGE')
end
if KEYS[2]~='reservation:fence:w1-clearance:receipt:'..expected.requestId or
  KEYS[3]~='reservation:fence:product-control:{'..expected.productId..'}' then
  return rejected('PERMIT_SCOPE_MISMATCH')
end
if redis.call('EXISTS',KEYS[2])~=0 then return rejected('RECEIPT_ALREADY_EXISTS') end
local current,cerr=control(expected.tuple)
if cerr then return rejected(cerr) end
local ctrl,ce=read(KEYS[3])
if ce or not productControlValid(ctrl) or redis.call('PTTL',KEYS[3])~=-1 or
  ctrl.productId~=expected.productId or ctrl.incarnation~=current.incarnation or ctrl.epoch~=current.epoch then
  return rejected('CONTROL_STATE_MISMATCH')
end
if ctrl.state~='CLEARANCE_STAGED' or ctrl.restrictionId~=expected.restrictionId or
  ctrl.restrictionRevision~=expected.stagedControlRevision then
  return rejected('CONTROL_STATE_MISMATCH')
end
local restored=encodeControlJson(expected.productId,'RESTRICTED',expected.restrictionId,expected.targetRestrictionRevision,current.incarnation,current.epoch)
redis.call('SET',KEYS[3],restored)
return accepted(restored)
`;

export const OBSERVE_PRODUCT_SUSPECT_CLEARANCE_LUA = `
local function keyInfo(k)
  local t=redis.call('TYPE',k).ok
  if t=='none' then return t,-2,cjson.null end
  if t~='string' then return t,-2,cjson.null end
  return t,redis.call('PTTL',k),redis.call('GET',k)
end
local fenceRaw=redis.call('GET',KEYS[1])
local histInc=redis.call('HGET','reservation:fence:initialization-history','incarnation')
local permitType,permitPttl,_=keyInfo(KEYS[2])
local receiptType,receiptPttl,receiptRaw=keyInfo(KEYS[3])
local ctrlType,ctrlPttl,ctrlRaw=keyInfo(KEYS[4])
local suspType=redis.call('TYPE',KEYS[5]).ok
local totalType,_,totalRaw=keyInfo(KEYS[6])
return cjson.encode({
  fenceRaw=fenceRaw or cjson.null,
  historyIncarnation=histInc or cjson.null,
  permitPresent=permitType=='string' and permitPttl>0,
  permitPttlMs=permitPttl,
  receiptType=receiptType,
  receiptPttlMs=receiptPttl,
  receiptRaw=receiptRaw,
  controlType=ctrlType,
  controlPttlMs=ctrlPttl,
  controlRaw=ctrlRaw,
  suspectPresent=suspType~='none',
  suspectType=suspType,
  totalType=totalType,
  totalRaw=totalRaw
})
`;
