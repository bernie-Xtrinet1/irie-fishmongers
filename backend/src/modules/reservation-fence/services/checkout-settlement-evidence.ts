import { createHash } from 'crypto';
import { CheckoutSettlementEffect } from '@prisma/client';
import { RedisService } from '../../../common/redis/redis.service';
import { MUTATION_COMMON_LUA } from '../lua/reservation-mutation-common.lua';
import { settlementReceiptKey } from '../lua/checkout-settlement.lua';
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
const READ_COMPLETION = MUTATION_COMMON_LUA + `
local function oldOwnerRemains(entry,s,checkoutKey)
  -- Any old ownership component is contradictory, including partially relabelled
  -- entries. A different hold ID alone cannot erase the old checkout owner.
  return entry.checkoutOperationId==s.execution.operationId or
    entry.checkoutAttemptId==s.execution.attemptId or entry.checkoutIdempotencyKey==checkoutKey
end
local function replacementProven(entry,resource)
  if entry.version~=1 or entry.cartId~=resource.cartId or entry.customerId~=resource.customerId or
    not integer(entry.quantity) or entry.quantity<1 or
    (entry.status~='ACTIVE' and entry.status~='CHECKOUT_PENDING') then return false end
  if entry.holdInstanceId~=resource.holdInstanceId then return true end
  -- ACTIVE canonical recreation is not established by W1 yet. A later pin and
  -- acquisition record also omit checkoutIdempotencyKey: neither proves that
  -- the live key belongs to the claimed new operation. Keep both classifications
  -- unresolved until that ownership can be positively established. Never infer
  -- authority from merely different operation/attempt IDs or rewrite evidence.
  return false
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
    if entry and (oldOwnerRemains(entry,s,ARGV[4]) or not replacementProven(entry,resource)) then
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
