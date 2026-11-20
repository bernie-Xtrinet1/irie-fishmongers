import { CutoverFreshnessResetAudit, Prisma } from '@prisma/client';

import { RedisService } from '../../../common/redis/redis.service';
import { PRODUCT_CONTROL_INSTALL } from '../../reservation-fence/lua/product-reservation-restriction.lua';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { ordinaryHoldInstanceId } from '../../reservation-fence/ordinary-hold-instance-id';
import {
  currentAllowedControlRevision,
  requireUnrestrictedProduct,
} from '../../reservation-fence/repositories/product-reservation-restriction.repository';
import { ReservationFenceRepository, transitionTuple } from '../../reservation-fence/repositories/reservation-fence.repository';
import { decodeMutationResult } from '../../reservation-fence/services/reservation-fenced-executor.service';
import { controlBytes, productControlKey } from '../../reservation-fence/types/product-reservation-restriction.types';
import { FenceTuple, legalPair } from '../../reservation-fence/types/reservation-fence.types';
import {
  CutoverFreshnessResetAuditRepository,
  deriveFreshnessRequestId,
} from '../repositories/cutover-freshness-reset-audit.repository';
import { AuthorizedFreshnessResetInput, FreshnessFailureCategory } from '../types/cart-scoped-backfill.types';
import { classifyFreshnessFailureCode } from './cutover-freshness-reset-validation.helper';

export type PrepareTxResult =
  | { action: 'EXECUTE'; row: CutoverFreshnessResetAudit; tuple: FenceTuple; controlRevision: number }
  | { action: 'RECOVER_PREPARED'; row: CutoverFreshnessResetAudit; tuple: FenceTuple }
  | { action: 'REPLAY_COMPLETED'; row: CutoverFreshnessResetAudit }
  | { action: 'REPLAY_ABORTED'; row: CutoverFreshnessResetAudit }
  | {
      action: 'REJECTED';
      category: FreshnessFailureCategory;
      code: string;
      detail: string;
      auditId?: string | null;
      requestId?: string | null;
    };

function matchesIdentity(
  row: CutoverFreshnessResetAudit,
  input: AuthorizedFreshnessResetInput,
  markerId: string,
  generation: number,
  holdInstanceId: string,
): boolean {
  return (
    row.cutoverRunId === input.cutoverRunId &&
    row.barrierRevision === input.barrierRevision &&
    row.markerId === markerId &&
    row.generation === generation &&
    row.holdInstanceId === holdInstanceId &&
    row.cartId === input.cartId &&
    row.productId === input.productId &&
    row.customerId === input.customerId &&
    row.quantity === input.quantity &&
    row.operatorId === input.operatorId
  );
}

export async function prepareAuthorizedFreshnessResetInTx(
  tx: Prisma.TransactionClient,
  deps: { fences: ReservationFenceRepository; redis: RedisService; auditRepo: CutoverFreshnessResetAuditRepository },
  input: AuthorizedFreshnessResetInput,
): Promise<PrepareTxResult> {
  const operator = await tx.user.findUnique({ where: { id: input.operatorId }, select: { id: true } });
  if (!operator) {
    return { action: 'REJECTED', category: 'UNAUTHORIZED', code: 'UNAUTHORIZED_OPERATOR', detail: 'Unknown cutover operatorId' };
  }

  const barrier = await tx.cartMutationBarrierConfig.findFirst({ orderBy: { revision: 'desc' } });
  if (!barrier?.active || barrier.revision !== input.barrierRevision) {
    return { action: 'REJECTED', category: 'UNAUTHORIZED', code: 'STALE_BARRIER_REVISION', detail: 'Active latest mutation barrier revision is required' };
  }

  const [fence, mode] = await Promise.all([deps.fences.latest(tx), deps.fences.mode(tx)]);
  if (
    !fence ||
    fence.status !== 'ACKNOWLEDGED' ||
    mode.modeRevision === null ||
    fence.mode !== mode.mode ||
    fence.modeRevision !== mode.modeRevision ||
    !legalPair(mode.mode, fence.phase, true)
  ) {
    return { action: 'REJECTED', category: 'FENCE_REJECTED', code: 'DURABLE_REDIS_DISAGREEMENT', detail: 'Fence and mode config disagree' };
  }
  if (mode.mode !== 'MIRROR' || fence.phase !== 'OPEN') {
    return { action: 'REJECTED', category: 'FENCE_REJECTED', code: 'PHASE_DENIED', detail: `Requires MIRROR/OPEN; got ${mode.mode}/${fence.phase}` };
  }

  const cart = await tx.cart.findFirst({ where: { id: input.cartId, customerId: input.customerId }, select: { id: true } });
  if (!cart) {
    return { action: 'REJECTED', category: 'UNAUTHORIZED', code: 'PERMIT_SCOPE_MISMATCH', detail: 'Cart does not belong to specified customer' };
  }

  const cartItem = await tx.cartItem.findUnique({
    where: { cartId_productId: { cartId: input.cartId, productId: input.productId } },
    select: { quantity: true },
  });
  if (!cartItem || cartItem.quantity !== input.quantity || cartItem.quantity <= 0) {
    return { action: 'REJECTED', category: 'UNAUTHORIZED', code: 'PERMIT_SCOPE_MISMATCH', detail: 'Positive CartItem quantity does not match request' };
  }

  const markers = await tx.$queryRaw<{ id: string; generation: number; expectedQuantity: number | null; resolvedAt: Date | null }[]>`
    SELECT id, generation, "expectedQuantity", "resolvedAt"
    FROM cart_reservation_sync_states
    WHERE "cartId" = ${input.cartId} AND "productId" = ${input.productId}
    FOR UPDATE`;
  const marker = markers[0];
  if (!marker || marker.resolvedAt === null || marker.expectedQuantity !== input.quantity) {
    return { action: 'REJECTED', category: 'UNAUTHORIZED', code: 'UNRESOLVED_SYNC_MARKER', detail: 'Resolved CartReservationSyncState matching quantity is required' };
  }
  if (input.expectedGeneration !== undefined && marker.generation !== input.expectedGeneration) {
    return { action: 'REJECTED', category: 'UNAUTHORIZED', code: 'STALE_GENERATION', detail: `Expected generation ${input.expectedGeneration}, found ${marker.generation}` };
  }

  try {
    await requireUnrestrictedProduct(tx, input.productId);
  } catch (error) {
    if (error instanceof Error && error.message === 'PRODUCT_RESERVATION_RESTRICTED') {
      return { action: 'REJECTED', category: 'SUSPECT', code: 'PRODUCT_RESTRICTED', detail: 'Product has active durable reservation restriction' };
    }
    throw error;
  }

  const holdInstanceId = ordinaryHoldInstanceId(marker.id, marker.generation);
  const tuple = transitionTuple(fence);
  const byReq = input.requestId ? await deps.auditRepo.findByRequestId(input.requestId, tx) : null;
  const byTuple = await deps.auditRepo.findByIdempotencyTuple(input.cutoverRunId, input.barrierRevision, marker.id, marker.generation, tx);

  if (byReq && (!byTuple || byReq.id !== byTuple.id || !matchesIdentity(byReq, input, marker.id, marker.generation, holdInstanceId))) {
    return { action: 'REJECTED', category: 'UNAUTHORIZED', code: 'REQUEST_ID_CONFLICT', detail: 'requestId already bound to a different freshness target/run', requestId: input.requestId };
  }
  if (byTuple) {
    if (!matchesIdentity(byTuple, input, marker.id, marker.generation, holdInstanceId)) {
      return { action: 'REJECTED', category: 'UNAUTHORIZED', code: 'REQUEST_ID_CONFLICT', detail: 'Idempotency tuple already bound to a different target/operator/quantity', auditId: byTuple.id, requestId: byTuple.requestId };
    }
    if (byTuple.status === 'COMPLETED') return { action: 'REPLAY_COMPLETED', row: byTuple };
    if (byTuple.status === 'ABORTED') return { action: 'REPLAY_ABORTED', row: byTuple };
    return { action: 'RECOVER_PREPARED', row: byTuple, tuple };
  }

  const otherInFlight = await deps.auditRepo.findInFlightForMarker(marker.id, marker.generation, tx);
  if (otherInFlight) {
    return {
      action: 'REJECTED',
      category: 'ESCALATED',
      code: 'CONCURRENT_FRESHNESS_IN_FLIGHT',
      detail: `Unresolved PREPARED audit row ${otherInFlight.id} exists from run ${otherInFlight.cutoverRunId}`,
      auditId: otherInFlight.id,
      requestId: otherInFlight.requestId,
    };
  }

  const controlRevision = await currentAllowedControlRevision(tx, input.productId);
  const control = controlBytes({
    version: 1,
    productId: input.productId,
    state: 'ALLOW',
    restrictionId: null,
    restrictionRevision: controlRevision,
    incarnation: fence.incarnation,
    epoch: fence.epoch,
  });
  const init = decodeMutationResult(
    await deps.redis.eval(PRODUCT_CONTROL_INSTALL, [RESERVATION_FENCE_KEY, productControlKey(input.productId)], [JSON.stringify(tuple), control]),
    (value): value is string => value === control,
  );
  if (init.code !== 'ACCEPTED') {
    const code = init.code === 'FENCE_REJECTED' ? init.reason : 'PRODUCT_CONTROL_FAILED';
    return { action: 'REJECTED', category: classifyFreshnessFailureCode(code), code, detail: 'Redis product control denied FRESHNESS_SWEEP' };
  }

  const requestId = input.requestId ?? deriveFreshnessRequestId(input.cutoverRunId, input.barrierRevision, marker.id, marker.generation);
  const row = await deps.auditRepo.createPrepared({
    requestId,
    cutoverRunId: input.cutoverRunId,
    barrierRevision: input.barrierRevision,
    fenceTransitionId: fence.id,
    incarnation: fence.incarnation,
    fenceEpoch: fence.epoch,
    fenceRevision: fence.revision,
    modeRevision: mode.modeRevision,
    markerId: marker.id,
    generation: marker.generation,
    holdInstanceId,
    customerId: input.customerId,
    cartId: input.cartId,
    productId: input.productId,
    quantity: input.quantity,
    operatorId: input.operatorId,
    reason: (input.reason ?? 'CUTOVER_FRESHNESS_SWEEP').trim(),
    anchorNowMs: BigInt(input.nowMs ?? Date.now()),
  }, tx);

  return { action: 'EXECUTE', row, tuple, controlRevision };
}
