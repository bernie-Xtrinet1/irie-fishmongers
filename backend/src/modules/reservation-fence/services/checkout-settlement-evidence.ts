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
local r,err=read(KEYS[1])
if err or not fields(r,4) or r.identity~=ARGV[1] or r.action~=ARGV[2] or
  r.replayId~=ARGV[3] or r.complete~=true then return rejected('REPLAY_MISMATCH') end
return accepted()
`;

// Evidence only: the repository independently matches this observation against
// its durable manifest/action. There is no public constructor or assertion cast
// that can pass the runtime WeakMap check, and no caller-provided receipt body.
export async function readSettlementCompletion(redis: RedisService, m: SettlementManifest): Promise<SettlementCompletionEvidence> {
  if (!m.effect || !m.settlementReplayId) throw new Error('SETTLEMENT_ACTION_REQUIRED');
  const identity = settlementOwnershipIdentity(m);
  const response: unknown = JSON.parse(await redis.eval(READ_COMPLETION, [settlementReceiptKey(m.id)],
    [identity, m.effect, m.settlementReplayId]) as string);
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
