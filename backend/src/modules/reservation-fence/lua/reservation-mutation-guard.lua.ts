import { DRAINING_MUTATION_EFFECTS, MAX_LEASE_CEILING_MS, MUTATION_EFFECTS, MutationEffect } from '../types/reservation-mutation.types';
import { MUTATION_COMMON_LUA } from './reservation-mutation-common.lua';

export interface CompiledFencedMutation { readonly source: string }
const compiled = new WeakSet<object>();
export function compileFencedMutation(effect: MutationEffect, body: string): CompiledFencedMutation {
  const script = Object.freeze({ source: mutationGuard(effect) + '\n' + body });
  compiled.add(script);
  return script;
}
export function isCompiledFencedMutation(script: unknown): script is CompiledFencedMutation {
  return typeof script === 'object' && script !== null && compiled.has(script);
}

const PERMIT_VALIDATION = `
local purposeEffects={
  CART_CONVERGENCE={RESERVE=true,RENEW=true,REDUCTION_RECREATE=true,RELEASE=true},
  CHECKOUT_EXECUTION={CHECKOUT_MARK=true,CHECKOUT_LEASE_EXTEND=true},
  CHECKOUT_SETTLEMENT={CHECKOUT_REVERT_RESTORE_ACTIVE=true,CHECKOUT_REVERT_DELETE_ONLY=true,CHECKOUT_FINALIZE=true},
  RESOURCE_REPAIR={MALFORMED_SUSPECT=true,RECONCILE_NONINCREASING=true,RECONCILE_POSITIVE=true}
}
local drainingEffects={${DRAINING_MUTATION_EFFECTS.map(effect => `${effect}=true`).join(',')}}
local function timestampValid(value)
  return type(value)=='number' and value>0 and value<=${MAX_LEASE_CEILING_MS} and value==math.floor(value)
end
local function constraintValid(p)
  if p.effect=='CHECKOUT_LEASE_EXTEND' then
    return fields(p.constraint,2) and p.constraint.kind=='LEASE_CEILING' and timestampValid(p.constraint.ceilingMs)
  end
  return fields(p.constraint,1) and p.constraint.kind=='NONE'
end
local function permitValid(p)
  return fields(p,11) and type(p.purpose)=='string' and type(p.effect)=='string' and
    (p.authorizationPhase=='OPEN' or p.authorizationPhase=='DRAINING') and constraintValid(p) and
    purposeEffects[p.purpose] and purposeEffects[p.purpose][p.effect] and
    tupleValid(p.tuple) and uuid(p.permitId) and uuid(p.replayId) and
    type(p.expiresAt)=='number' and p.expiresAt>0 and type(p.resources)=='table' and
    #p.resources>0 and #p.resources<=100 and
    ((p.family=='PRE_CHECKOUT_CART' and p.purpose=='CART_CONVERGENCE') or
     (p.family=='ADMIN_OR_RECOVERY' and p.purpose=='RESOURCE_REPAIR') or
     (p.family=='CHECKOUT_EXECUTION_OR_SETTLEMENT' and
       (p.purpose=='CHECKOUT_EXECUTION' or p.purpose=='CHECKOUT_SETTLEMENT')))
end
local function phaseCheck(p)
  if p.authorizationPhase~=p.tuple.phase then return 'PHASE_DENIED' end
  if p.authorizationPhase=='OPEN' then return nil end
  if p.authorizationPhase=='DRAINING' and drainingEffects[p.effect] then return nil end
  return 'PHASE_DENIED'
end
`;

// Compiled effect is a developer-selected enum constant, never an ARGV class.
// KEYS[1]=control, KEYS[2]=permit. ARGV[1]=expected complete permit.
// Lease variant reserves ARGV[2] for an absolute target in epoch milliseconds.
// Its body must use authorizedLeaseTargetMs (and retain per-entry hard ceilings),
// never compute an unchecked sliding target. Other arguments belong to writers.
export function mutationGuard(effect: MutationEffect): string {
  if (!MUTATION_EFFECTS.includes(effect)) throw new Error('Unsupported compiled mutation effect');
  return MUTATION_COMMON_LUA + PERMIT_VALIDATION + `
local expected=decode(ARGV[1])
if not permitValid(expected) then return rejected('MALFORMED_PERMIT') end
local current,err=control(expected.tuple)
if err then return rejected(err) end
if KEYS[2]~='reservation:fence:permit:'..expected.permitId then return rejected('MISSING_PERMIT') end
local p,readError=read(KEYS[2])
if readError then return rejected(readError..'_PERMIT') end
if not permitValid(p) then return rejected('MALFORMED_PERMIT') end
err=compareTuple(current,p.tuple)
if err then return rejected(err) end
if p.permitId~=expected.permitId then return rejected('MISSING_PERMIT') end
if p.effect~='${effect}' or expected.effect~='${effect}' then return rejected('EFFECT_MISMATCH') end
if p.replayId~=expected.replayId then return rejected('REPLAY_MISMATCH') end
if p.expiresAt<=nowMs() then return rejected('EXPIRED_PERMIT') end
if p.authorizationPhase~=expected.authorizationPhase or p.constraint.kind~=expected.constraint.kind or
  p.constraint.ceilingMs~=expected.constraint.ceilingMs then return rejected('PERMIT_SCOPE_MISMATCH') end
if p.family~=expected.family or p.purpose~=expected.purpose or #p.resources~=#expected.resources then
  return rejected('PERMIT_SCOPE_MISMATCH')
end
for i,r in ipairs(p.resources) do
  if not sameResource(r,expected.resources[i]) then return rejected('PERMIT_SCOPE_MISMATCH') end
end
if p.family=='CHECKOUT_EXECUTION_OR_SETTLEMENT' then
  if not executionValid(p.execution) or not executionValid(expected.execution) or
    p.execution.operationId~=expected.execution.operationId or p.execution.attemptId~=expected.execution.attemptId or
    p.execution.gateId~=expected.execution.gateId then return rejected('PERMIT_SCOPE_MISMATCH') end
elseif expected.execution~=cjson.null then return rejected('PERMIT_SCOPE_MISMATCH') end
err=phaseCheck(p) or checkResources(p) or checkGate(p)
if err then return rejected(err) end
${effect === 'CHECKOUT_LEASE_EXTEND' ? `
local authorizedLeaseTargetMs=tonumber(ARGV[2])
if not timestampValid(authorizedLeaseTargetMs) or authorizedLeaseTargetMs>p.constraint.ceilingMs then
  return rejected('PERMIT_SCOPE_MISMATCH')
end
` : ''}
`;
}

// Registration is called only by the durable-authority service. Redis cannot
// itself query PostgreSQL. Redis ACL/network trust must exclude raw callers.
export const REGISTER_MUTATION_PERMIT_LUA = MUTATION_COMMON_LUA + PERMIT_VALIDATION + `
local p=decode(ARGV[1])
local ttl=tonumber(ARGV[2])
if not permitValid(p) or not ttl or ttl<1 or ttl>5000 or ttl~=math.floor(ttl) then return rejected('MALFORMED_PERMIT') end
local current,err=control(p.tuple)
if err then return rejected(err) end
if KEYS[2]~='reservation:fence:permit:'..p.permitId then return rejected('MISSING_PERMIT') end
err=phaseCheck(p) or checkResources(p) or checkGate(p)
if err then return rejected(err) end
if redis.call('EXISTS',KEYS[2])~=0 then return rejected('REPLAY_MISMATCH') end
p.expiresAt=nowMs()+ttl
redis.call('SET',KEYS[2],cjson.encode(p),'PX',ttl,'NX')
return accepted(p)
`;
