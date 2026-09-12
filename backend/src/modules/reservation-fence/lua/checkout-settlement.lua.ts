import { MUTATION_COMMON_LUA } from './reservation-mutation-common.lua';

export const settlementGrantKey = (id: string) => `reservation:fence:settlement-grant:${id}`;
export const settlementReceiptKey = (id: string) => `reservation:fence:settlement-receipt:${id}`;
export const checkoutPinKey = (id: string) => `reservation:fence:checkout-pin:${id}`;

// Inactive compiler primitive, not an inventory writer. Only trusted static
// effect bodies may be compiled. They must validate domain inputs/types before
// writing: Redis Lua errors do not roll back earlier commands. No runtime body.
// validateBody must not write; mutateBody must not return (receipt follows it).
export function settlementProtocol(action: 'ACQUIRE' | 'CHECKOUT_FINALIZE' | 'CHECKOUT_REVERT_DELETE_ONLY' |
  'CHECKOUT_REVERT_RESTORE_ACTIVE', validateBody: string, mutateBody: string): string {
  return MUTATION_COMMON_LUA + `
local grant,err=read(KEYS[2])
if err then return rejected('MISSING_PERMIT') end
local current,controlError=control(grant.tuple)
if controlError then return rejected(controlError) end
if grant.action~='${action}' or grant.expiresAt<=nowMs() then return rejected('EXPIRED_PERMIT') end
if current.phase~='OPEN' and (current.phase~='DRAINING' or
  (grant.action~='CHECKOUT_FINALIZE' and grant.action~='CHECKOUT_REVERT_DELETE_ONLY')) then return rejected('PHASE_DENIED') end
local identity=grant.identity
local s=decode(identity)
if not s or not uuid(s.manifestId) or not uuid(s.acquisitionReplayId) or not uuid(grant.replayId) or not executionValid(s.execution) or
  type(s.resources)~='table' or #s.resources<1 or #s.resources>100 then return rejected('PERMIT_SCOPE_MISMATCH') end
local receiptKey='reservation:fence:settlement-receipt:'..s.manifestId
if s.incarnation~=current.incarnation or s.epoch~=current.epoch then return rejected('EPOCH_MISMATCH') end
if (grant.action=='ACQUIRE' and grant.replayId~=s.acquisitionReplayId) or
  (grant.action~='ACQUIRE' and grant.replayId==s.acquisitionReplayId) then return rejected('REPLAY_MISMATCH') end
local receipt,receiptError=read(receiptKey)
if receiptError~='MISSING' and receiptError then return rejected('MALFORMED_PERMIT') end
if receipt then
  if not fields(receipt,4) or receipt.identity~=identity or receipt.action~=grant.action or
    receipt.replayId~=grant.replayId or receipt.complete~=true then return rejected('REPLAY_MISMATCH') end
  return accepted({completed=true,replayed=true})
end
local acquisitionKey='reservation:fence:settlement-acquisition:'..s.manifestId
local acquisition,acquisitionError=read(acquisitionKey)
if acquisitionError and acquisitionError~='MISSING' then return rejected('MALFORMED_PERMIT') end
if acquisition and (acquisition.identity~=identity or acquisition.replayId~=s.acquisitionReplayId) then return rejected('REPLAY_MISMATCH') end
local p={tuple=grant.tuple,execution=s.execution,family='CHECKOUT_EXECUTION_OR_SETTLEMENT',
  purpose=grant.action=='ACQUIRE' and 'CHECKOUT_EXECUTION' or 'CHECKOUT_SETTLEMENT'}
local gateError=checkGate(p)
if gateError then return rejected(gateError) end
local seen={}
for _,r in ipairs(s.resources) do
  if not resourceValid(r) or seen[r.markerId] then return rejected('PERMIT_SCOPE_MISMATCH') end
  seen[r.markerId]=true
  local guard,guardError=read('reservation:fence:resource:'..r.markerId)
  if guardError or not guard or guard.incarnation~=current.incarnation or guard.epoch~=current.epoch or
    not sameResource(guard.resource,r) then return rejected('RESOURCE_GENERATION_MISMATCH') end
  local pinKey='reservation:fence:checkout-pin:'..r.markerId
  local pinType=redis.call('TYPE',pinKey).ok
  if pinType~='none' and pinType~='string' then return rejected('RESOURCE_GENERATION_MISMATCH') end
  local pin=redis.call('GET',pinKey)
  if grant.action=='ACQUIRE' then
    if acquisition and pin~=identity then return rejected('RESOURCE_GENERATION_MISMATCH') end
    if pin and pin~=identity then return rejected('RESOURCE_GENERATION_MISMATCH') end
  elseif pin~=identity then return rejected('RESOURCE_GENERATION_MISMATCH') end
end
if grant.action=='ACQUIRE' and acquisition then return accepted({acquired=true,replayed=true}) end
${validateBody}
${mutateBody}
if grant.action=='ACQUIRE' then
  for _,r in ipairs(s.resources) do redis.call('SET','reservation:fence:checkout-pin:'..r.markerId,identity) end
  redis.call('SET',acquisitionKey,cjson.encode({identity=identity,replayId=s.acquisitionReplayId}))
  return accepted({acquired=true})
end
redis.call('SET',receiptKey,cjson.encode({identity=identity,action=grant.action,replayId=grant.replayId,complete=true}))
for _,r in ipairs(s.resources) do redis.call('DEL','reservation:fence:checkout-pin:'..r.markerId) end
return accepted({completed=true,replayed=false})
`;
}

// ACL/trusted service boundary, as with existing permit registration. No public
// method accepts caller-asserted manifests or Redis-derived hold identities.
export const REGISTER_SETTLEMENT_GRANT_LUA = MUTATION_COMMON_LUA + `
local g=decode(ARGV[1])
if not g or not tupleValid(g.tuple) then return rejected('MALFORMED_PERMIT') end
local current,err=control(g.tuple)
if err then return rejected(err) end
if current.phase~='OPEN' and (current.phase~='DRAINING' or
  (g.action~='CHECKOUT_FINALIZE' and g.action~='CHECKOUT_REVERT_DELETE_ONLY')) then return rejected('PHASE_DENIED') end
g.expiresAt=nowMs()+5000
if redis.call('EXISTS',KEYS[2])~=0 then return rejected('REPLAY_MISMATCH') end
redis.call('SET',KEYS[2],cjson.encode(g),'PX',5000,'NX')
return accepted()
`;
