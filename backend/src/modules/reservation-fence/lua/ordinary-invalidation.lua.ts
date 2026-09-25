export const invalidationHistoryKey = (headKey: string) => `${headKey}:initialized`;

const INVALIDATION_SHAPE = `
local function invalidationFields(v,n)
 if type(v)~='table' then return false end
 local count=0 for _ in pairs(v) do count=count+1 end return count==n
end
local function invalidationUuid(v)
 return type(v)=='string' and #v==36 and string.match(v,'^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$') and v==string.lower(v)
end
local function invalidationDigest(v) return type(v)=='string' and #v==64 and string.match(v,'^[0-9a-f]+$') end
local function invalidationAck(a)
 if not invalidationFields(a,6) or a.version~=1 or not invalidationUuid(a.intentId) or not invalidationUuid(a.incarnation)
  or not integer(a.epoch) or a.epoch<1 or not invalidationDigest(a.digest) or type(a.scopes)~='table'
  or #a.scopes<1 or #a.scopes>100 or not invalidationFields(a.scopes,#a.scopes) then return false end
 for index,s in ipairs(a.scopes) do
  if not invalidationFields(s,3) or type(s.scope)~='string'
   or (s.scope~='GLOBAL' and (string.sub(s.scope,1,7)~='MARKER:' or not invalidationUuid(string.sub(s.scope,8))))
   or not integer(s.previousRevision) or not integer(s.revision) or s.previousRevision<0
   or s.revision>2147483647 or s.revision~=s.previousRevision+1
   or (index>1 and a.scopes[index-1].scope>=s.scope) then return false end
 end
 return true
end
local function invalidationHead(head)
 if not invalidationFields(head,9) or head.version~=1 or (head.state~='CLOSED' and head.state~='READY')
  or type(head.acknowledgement)~='string' then return false end
 local ack=decode(head.acknowledgement)
 if not invalidationAck(ack) or ack.intentId~=head.intentId or ack.digest~=head.digest
  or ack.incarnation~=head.incarnation or ack.epoch~=head.epoch then return false end
 for _,scope in ipairs(ack.scopes) do if scope.scope==head.scope and scope.revision==head.revision then return true end end
 return false
end
local function invalidationHistory(key,scope,incarnation,epoch)
 if redis.call('TYPE',key).ok~='string' or redis.call('PTTL',key)~=-1 then return false end
 local h=decode(redis.call('GET',key))
 return invalidationFields(h,5) and h.version==1 and h.protocol==1 and h.scope==scope
  and h.incarnation==incarnation and h.epoch==epoch
end
`;

// Standalone Redis only. No Cluster claim: global and marker keys span slots.
export const ORDINARY_INVALIDATION_LUA = `
local function decode(s) local ok,v=pcall(cjson.decode,s or '') if ok and type(v)=='table' then return v end end
local function integer(n) return type(n)=='number' and n==math.floor(n) and n>=0 and n<=2147483647 end
${INVALIDATION_SHAPE}
local function denied() return cjson.encode({code='REJECTED'}) end
local a=decode(ARGV[1]) local command=ARGV[2]
if not invalidationAck(a) or #KEYS~=#a.scopes+1
 or (command~='INSTALL' and command~='READY') then return denied() end
if KEYS[1]~='reservation:fence:control' or redis.call('TYPE',KEYS[1]).ok~='string' then return denied() end
local control=decode(redis.call('GET',KEYS[1]))
if not control or control.protocol~=1 or control.incarnation~=a.incarnation or control.epoch~=a.epoch then return denied() end
if command=='READY' and control.phase~='OPEN' then return denied() end
local writes={} local initialized={}
for index,s in ipairs(a.scopes) do
 if type(s)~='table' or type(s.scope)~='string' or (s.scope~='GLOBAL' and not string.match(s.scope,'^MARKER:[0-9a-f%-]+$'))
  or not integer(s.previousRevision) or not integer(s.revision) or s.revision~=s.previousRevision+1
  or (index>1 and a.scopes[index-1].scope>=s.scope)
  or KEYS[index+1]~='reservation:fence:ordinary-invalidation:'..s.scope then return denied() end
 local key=KEYS[index+1] local kind=redis.call('TYPE',key).ok local old=nil
 local history=key..':initialized'
 if kind~='none' and kind~='string' then return denied() end
 if kind=='none' then
  -- Retained first-initialization evidence is never removed by this protocol.
  -- Loss of an initialized head is quarantine, not permission to bootstrap.
  if redis.call('EXISTS',history)~=0 or command~='INSTALL' or s.previousRevision~=0 then return denied() end
  initialized[index]=cjson.encode({version=1,protocol=1,scope=s.scope,incarnation=a.incarnation,epoch=a.epoch})
 elseif not invalidationHistory(history,s.scope,a.incarnation,a.epoch) then return denied() end
 if kind=='string' then
  old=decode(redis.call('GET',key))
  if not invalidationHead(old) or old.scope~=s.scope or old.incarnation~=a.incarnation or old.epoch~=a.epoch
   or redis.call('PTTL',key)~=-1 then return denied() end
 end
 local exact=old and old.revision==s.revision and old.intentId==a.intentId and old.digest==a.digest and old.acknowledgement==ARGV[1]
 if command=='READY' then
  if not exact then return denied() end
 elseif not exact then
  if (old and old.revision~=s.previousRevision) or (not old and s.previousRevision~=0) then return denied() end
 end
 if not exact or command=='READY' then
  writes[index]=cjson.encode({version=1,scope=s.scope,incarnation=a.incarnation,epoch=a.epoch,revision=s.revision,
   intentId=a.intentId,digest=a.digest,state=command=='READY' and 'READY' or 'CLOSED',acknowledgement=ARGV[1]})
 end
end
-- Validate the complete sorted set before any write. No expiry or deletion.
for index=1,#a.scopes do
 if initialized[index] then redis.call('SET',KEYS[index+1]..':initialized',initialized[index]) end
 if writes[index] then redis.call('SET',KEYS[index+1],writes[index]) end
end
return cjson.encode({code='CONFIRMED',acknowledgement=ARGV[1]})
`;

// Called inside REGISTER and again by the actual GENESIS/EXECUTE script.
// Historical receipt observation intentionally does not require current readiness.
export const ORDINARY_INVALIDATION_PHYSICAL_GUARD = `
${INVALIDATION_SHAPE}
local function ordinaryBarrierAllowed(i,b)
 local global='reservation:fence:ordinary-invalidation:GLOBAL'
 local marker='reservation:fence:ordinary-invalidation:MARKER:'..i.target.markerId
 if b==nil then return redis.call('EXISTS',global,marker,global..':initialized',marker..':initialized')==0 end
 if not fields(b,8) or b.version~=1 or b.commandId~=i.commandId or b.replayId~=i.replayId or b.markerId~=i.target.markerId
  or b.incarnation~=i.incarnation or b.epoch~=i.epoch or not integer(b.globalRevision) or not integer(b.markerRevision) then return false end
 for _,part in ipairs({{key=global,scope='GLOBAL',revision=b.globalRevision},{key=marker,scope='MARKER:'..b.markerId,revision=b.markerRevision}}) do
  if not invalidationHistory(part.key..':initialized',part.scope,b.incarnation,b.epoch) then return false end
  if redis.call('TYPE',part.key).ok~='string' or redis.call('PTTL',part.key)~=-1 then return false end
  local head=decode(redis.call('GET',part.key))
  if not invalidationHead(head) or head.scope~=part.scope or head.incarnation~=b.incarnation or head.epoch~=b.epoch
   or head.revision~=part.revision or head.state~='READY' then return false end
 end
 return true
end
`;
