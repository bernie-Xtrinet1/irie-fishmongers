import { createHash } from 'crypto';
import { CheckoutSettlementEffect } from '@prisma/client';
import { RedisService } from '../../../common/redis/redis.service';
import { MUTATION_COMMON_LUA } from '../lua/reservation-mutation-common.lua';
import { ACQUISITION_EVIDENCE_LUA, settlementReceiptKey } from '../lua/checkout-settlement.lua';
import type { SettlementManifest } from '../repositories/checkout-settlement.repository';

export function settlementOwnershipIdentity(m: SettlementManifest): string {
  return JSON.stringify({ manifestId: m.id, acquisitionReplayId: m.acquisitionReplayId,
    incarnation: m.incarnation, epoch: m.reservationExecutionEpoch,
    execution: { operationId: m.operationId, attemptId: m.attemptId, gateId: m.operationId },
    quantities: m.resources.map(r => ({ markerId: r.markerId, quantity: r.quantity })),
    resources: m.resources.map(r => ({ markerId: r.markerId, generation: r.generation,
      holdInstanceId: r.holdInstanceId, customerId: m.operation.customerId,
      cartId: m.operation.cartId, productId: r.productId })) });
}

declare const completionBrand: unique symbol;
export interface SettlementCompletionEvidence { readonly [completionBrand]: true }
interface VerifiedReceipt { identity: string; action: CheckoutSettlementEffect; replayId: string; hash: string }
const verified = new WeakMap<SettlementCompletionEvidence, VerifiedReceipt>();
const READ_COMPLETION = MUTATION_COMMON_LUA + ACQUISITION_EVIDENCE_LUA + `
local function oldOwnerRemains(entry,s,checkoutKey)
  -- Any old ownership component is contradictory, including partially relabelled
  -- entries. A different hold ID alone cannot erase the old checkout owner.
  return entry.checkoutOperationId==s.execution.operationId or
    entry.checkoutAttemptId==s.execution.attemptId or entry.checkoutIdempotencyKey==checkoutKey
end
local function timestampValid(value)
  return type(value)=='number' and value>=0 and value<=9007199254740991 and value==math.floor(value)
end
local function replacementProven(entry,resource,old)
  if entry.version~=1 or entry.cartId~=resource.cartId or entry.customerId~=resource.customerId or
    not integer(entry.quantity) or entry.quantity<1 or
    (entry.status~='ACTIVE' and entry.status~='CHECKOUT_PENDING') then return false end
  if entry.holdInstanceId~=resource.holdInstanceId then return true end
  -- W1 does not yet establish canonical ACTIVE recreation. Only a complete
  -- distinct checkout owner can explain same-ID presence observationally.
  if entry.status~='CHECKOUT_PENDING' or not uuid(entry.checkoutIdempotencyKey) or
    entry.markerId~=resource.markerId or entry.generation~=resource.generation or
    not timestampValid(entry.checkoutPendingAt) or not timestampValid(entry.checkoutPendingExpiresAt) or
    not timestampValid(entry.expiresAt) or not timestampValid(entry.absoluteExpiresAt) or
    entry.checkoutPendingExpiresAt<=entry.checkoutPendingAt then return false end
  local pinKey='reservation:fence:checkout-pin:'..resource.markerId
  if redis.call('TYPE',pinKey).ok~='string' then return false end
  local identity=redis.call('GET',pinKey)
  local owner=decode(identity)
  if not owner or not fields(owner,7) or not uuid(owner.manifestId) or owner.manifestId==old.manifestId or
    not uuid(owner.acquisitionReplayId) or owner.acquisitionReplayId==old.acquisitionReplayId or
    not uuid(owner.incarnation) or not integer(owner.epoch) or owner.epoch<1 or
    not executionValid(owner.execution) or owner.execution.gateId~=owner.execution.operationId or
    owner.execution.operationId~=entry.checkoutOperationId or owner.execution.attemptId~=entry.checkoutAttemptId or
    owner.epoch~=entry.reservationExecutionEpoch or type(owner.resources)~='table' or
    #owner.resources<1 or #owner.resources>100 or not fields(owner.resources,#owner.resources) or
    type(owner.quantities)~='table' or #owner.quantities~=#owner.resources or
    not fields(owner.quantities,#owner.resources) then return false end
  local quantities={} local markers={} local products={} local found=false
  for _,q in ipairs(owner.quantities) do
    if not fields(q,2) or not uuid(q.markerId) or not integer(q.quantity) or q.quantity<1 or quantities[q.markerId] then return false end
    quantities[q.markerId]=q.quantity
  end
  for _,r in ipairs(owner.resources) do
    if not resourceValid(r) or markers[r.markerId] or products[r.productId] or not quantities[r.markerId] or
      r.cartId~=resource.cartId or r.customerId~=resource.customerId then return false end
    markers[r.markerId]=true products[r.productId]=true
    if r.markerId==resource.markerId then
      if not sameResource(r,resource) or quantities[r.markerId]~=entry.quantity then return false end
      found=true
    end
  end
  -- Canonical resource identity excludes quantity; the later pin must match its own live entry.
  if not found then return false end
  local guard,guardError=read('reservation:fence:resource:'..resource.markerId)
  if guardError or not fields(guard,3) or guard.incarnation~=owner.incarnation or guard.epoch~=owner.epoch or
    not sameResource(guard.resource,resource) then return false end
  local acquisition,acquisitionError=read('reservation:fence:settlement-acquisition:'..owner.manifestId)
  return not acquisitionError and acquisition.version==2 and
    acquisitionValid(acquisition,identity,owner.acquisitionReplayId,entry.checkoutIdempotencyKey)
end
local r,err=read(KEYS[1])
if err or not fields(r,4) or r.identity~=ARGV[1] or r.action~=ARGV[2] or
  r.replayId~=ARGV[3] or r.complete~=true then return rejected('REPLAY_MISMATCH') end
local s=decode(ARGV[1])
if not s or type(s.resources)~='table' then return rejected('REPLAY_MISMATCH') end
for _,resource in ipairs(s.resources) do
  local pinKey='reservation:fence:checkout-pin:'..resource.markerId
  local pinType=redis.call('TYPE',pinKey).ok
  if pinType~='none' and pinType~='string' then return rejected('REPLAY_MISMATCH') end
  if redis.call('GET',pinKey)==ARGV[1] then return rejected('REPLAY_MISMATCH') end
  if ARGV[2]=='CHECKOUT_REVERT_DELETE_ONLY' or ARGV[2]=='CHECKOUT_FINALIZE' then
    local entry,entryError=read('inv:reserved:{'..resource.cartId..'}:'..resource.productId)
    if entryError and entryError~='MISSING' then return rejected('REPLAY_MISMATCH') end
    if entry and (oldOwnerRemains(entry,s,ARGV[4]) or not replacementProven(entry,resource,s)) then
      return rejected('REPLAY_MISMATCH') end
  end
end
return accepted()
`;

// Evidence only: the repository independently matches this observation against
// its durable manifest/action. There is no public constructor or assertion cast
// that can pass the runtime WeakMap check, and no caller-provided receipt body.
export async function readSettlementCompletion(redis: RedisService, m: SettlementManifest): Promise<SettlementCompletionEvidence> {
  if (!m.effect || !m.settlementReplayId) throw new Error('SETTLEMENT_ACTION_REQUIRED');
  const identity = settlementOwnershipIdentity(m);
  const response: unknown = JSON.parse(await redis.eval(READ_COMPLETION, [settlementReceiptKey(m.id)],
    [identity, m.effect, m.settlementReplayId, m.operation.operationKey]) as string);
  if (!response || typeof response !== 'object' || !('code' in response) || response.code !== 'ACCEPTED' ||
    !('value' in response) || response.value !== true) throw new Error('SETTLEMENT_COMPLETION_UNRESOLVED');
  const evidence = Object.freeze({}) as SettlementCompletionEvidence;
  verified.set(evidence, { identity, action: m.effect, replayId: m.settlementReplayId,
    hash: createHash('sha256').update(JSON.stringify([identity, m.effect, m.settlementReplayId])).digest('hex') });
  return evidence;
}

export function completionReceiptHash(evidence: SettlementCompletionEvidence, m: SettlementManifest): string {
  const receipt = verified.get(evidence);
  if (!receipt || receipt.identity !== settlementOwnershipIdentity(m) || receipt.action !== m.effect ||
    receipt.replayId !== m.settlementReplayId) throw new Error('SETTLEMENT_COMPLETION_EVIDENCE_REQUIRED');
  return receipt.hash;
}
