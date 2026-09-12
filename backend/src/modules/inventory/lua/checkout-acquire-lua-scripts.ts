import { settlementProtocol } from '../../reservation-fence/lua/checkout-settlement.lua';
import { MUTATION_COMMON_LUA } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { CHECKOUT_PENDING_INITIAL_LEASE_SECONDS, MAX_CHECKOUT_PENDING_SECONDS } from '../constants/inventory.constants';

// No caller-supplied resource list, clock, quantity, or lease target. The
// server-issued grant contains the sealed PostgreSQL manifest identity.
const validateEntries = `
local entries={}
local keys={}
local quantities={}
if not uuid(checkoutKey) or type(s.quantities)~='table' or #s.quantities~=#s.resources then
  return rejected('PERMIT_SCOPE_MISMATCH') end
for _,q in ipairs(s.quantities) do
  if not uuid(q.markerId) or not integer(q.quantity) or q.quantity<1 or quantities[q.markerId] then
    return rejected('PERMIT_SCOPE_MISMATCH') end
  quantities[q.markerId]=q.quantity
end
local cartId=s.resources[1].cartId
local customerId=s.resources[1].customerId
local indexKey='inv:reserved:cart-index:{'..cartId..'}'
if redis.call('TYPE',indexKey).ok~='set' then return rejected('RESOURCE_GENERATION_MISMATCH') end
local members=redis.call('SMEMBERS',indexKey)
if #members~=#s.resources then return rejected('PERMIT_SCOPE_MISMATCH') end
local indexed={}
for _,productId in ipairs(members) do indexed[productId]=true end
local seenProducts={}
local now=nowMs()
for i,r in ipairs(s.resources) do
  if r.cartId~=cartId or r.customerId~=customerId or not indexed[r.productId] or seenProducts[r.productId] then
    return rejected('PERMIT_SCOPE_MISMATCH') end
  seenProducts[r.productId]=true
  local key='inv:reserved:{'..cartId..'}:'..r.productId
  local entry,err=read(key)
  if err or entry.version~=1 or entry.cartId~=cartId or entry.customerId~=customerId or
    entry.quantity~=quantities[r.markerId] or type(entry.expiresAt)~='number' or
    type(entry.absoluteExpiresAt)~='number' or entry.expiresAt<=now or entry.absoluteExpiresAt<=now then
    return rejected('RESOURCE_GENERATION_MISMATCH') end
  if verifying then
    if entry.status~='CHECKOUT_PENDING' or entry.checkoutIdempotencyKey~=checkoutKey or
      entry.holdInstanceId~=r.holdInstanceId or entry.markerId~=r.markerId or entry.generation~=r.generation or
      entry.reservationExecutionEpoch~=s.epoch or entry.checkoutOperationId~=s.execution.operationId or
      entry.checkoutAttemptId~=s.execution.attemptId or type(entry.checkoutPendingExpiresAt)~='number' or
      entry.checkoutPendingExpiresAt<=now then return rejected('RESOURCE_GENERATION_MISMATCH') end
  elseif entry.status~='ACTIVE' or (entry.holdInstanceId and entry.holdInstanceId~=r.holdInstanceId) then
    return rejected('RESOURCE_GENERATION_MISMATCH')
  end
  entries[i]=entry keys[i]=key
end
`;

export const CHECKOUT_ACQUIRE_SCRIPT = settlementProtocol('ACQUIRE', `
local verifying=false
local checkoutKey=grant.checkoutIdempotencyKey
${validateEntries}
`, `
for i,r in ipairs(s.resources) do
  local entry=entries[i]
  entry.status='CHECKOUT_PENDING'
  entry.checkoutIdempotencyKey=checkoutKey
  entry.checkoutPendingAt=now
  entry.checkoutPendingExpiresAt=now+${Math.min(CHECKOUT_PENDING_INITIAL_LEASE_SECONDS, MAX_CHECKOUT_PENDING_SECONDS) * 1000}
  entry.holdInstanceId=r.holdInstanceId
  entry.markerId=r.markerId
  entry.generation=r.generation
  entry.reservationExecutionEpoch=s.epoch
  entry.checkoutOperationId=s.execution.operationId
  entry.checkoutAttemptId=s.execution.attemptId
  redis.call('SET',keys[i],cjson.encode(entry),'KEEPTTL')
end
`);

// Read-only evidence, checked against PostgreSQL context supplied by the
// internal orchestrator. Missing evidence is not proof of non-execution.
export const READ_CHECKOUT_ACQUISITION_SCRIPT = MUTATION_COMMON_LUA + `
local expected=decode(ARGV[1])
if not expected then return rejected('PERMIT_SCOPE_MISMATCH') end
local current,err=control(expected.tuple)
if err then return rejected(err) end
if current.phase~='OPEN' then return rejected('PHASE_DENIED') end
local identity=expected.identity
local s=decode(identity)
if not s or s.incarnation~=current.incarnation or s.epoch~=current.epoch or not executionValid(s.execution) or
  type(s.resources)~='table' or #s.resources<1 or #s.resources>100 then return rejected('PERMIT_SCOPE_MISMATCH') end
local gateError=checkGate({tuple=expected.tuple,execution=s.execution,
  family='CHECKOUT_EXECUTION_OR_SETTLEMENT',purpose='CHECKOUT_EXECUTION'})
if gateError then return rejected(gateError) end
local receipt,receiptError=read('reservation:fence:settlement-acquisition:'..s.manifestId)
if receiptError=='MISSING' then return accepted({acquired=false}) end
if receiptError or receipt.identity~=identity or receipt.replayId~=s.acquisitionReplayId then return rejected('REPLAY_MISMATCH') end
for _,r in ipairs(s.resources) do
  if not resourceValid(r) then return rejected('PERMIT_SCOPE_MISMATCH') end
  local guard,guardError=read('reservation:fence:resource:'..r.markerId)
  if guardError or guard.incarnation~=current.incarnation or guard.epoch~=current.epoch or
    not sameResource(guard.resource,r) then return rejected('RESOURCE_GENERATION_MISMATCH') end
  local pinKey='reservation:fence:checkout-pin:'..r.markerId
  if redis.call('TYPE',pinKey).ok~='string' or redis.call('GET',pinKey)~=identity then return rejected('RESOURCE_GENERATION_MISMATCH') end
end
local verifying=true
local checkoutKey=expected.checkoutIdempotencyKey
${validateEntries}
return accepted({acquired=true})
`;
