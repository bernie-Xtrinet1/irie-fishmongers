import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';

import { RedisService } from '../../../common/redis/redis.service';
import { ReservationFenceRepository, transitionTuple } from '../repositories/reservation-fence.repository';
import { ACTIVE_RESTRICTION_STATES, BLOCKING_RECOVERY_STATES } from '../types/product-reservation-restriction.types';
import {
  ClearanceApproveInput,
  ClearanceApproveResult,
  ClearanceExecuteInput,
  ClearanceExecuteResult,
  ClearanceLuaPermit,
  ClearanceRejectInput,
  ClearanceRejectResult,
  ClearanceRequestInput,
  ClearanceRequestResult,
  computeClearanceApprovalDigest,
} from '../types/product-suspect-clearance.types';
import { FenceTuple } from '../types/reservation-fence.types';
import { isActiveAdminUser, loadActiveFenceAuthority } from './product-suspect-clearance-completion.helper';
import { reconcileProductForClearance } from './product-suspect-reconciliation.helper';

export async function requestClearanceTx(params: {
  tx: Prisma.TransactionClient;
  fences: ReservationFenceRepository;
  redis: RedisService;
  input: ClearanceRequestInput;
  requestId: string;
  permitTtlMs: number;
}): Promise<ClearanceRequestResult> {
  const { tx, fences, redis, input, requestId, permitTtlMs } = params;
  if (!(await isActiveAdminUser(tx, input.requestedById))) {
    return { ok: false, code: 'UNAUTHORIZED_ACTOR', message: 'Active ADMINISTRATOR requester required' };
  }

  const conflict = await tx.productSuspectRecovery.findUnique({ where: { requestId }, select: { id: true } });
  if (conflict) return { ok: false, code: 'REQUEST_ID_CONFLICT', message: 'requestId already used', recoveryId: conflict.id };

  const activeRecovery = await tx.productSuspectRecovery.findFirst({
    where: { productId: input.productId, status: { in: [...BLOCKING_RECOVERY_STATES] } },
    select: { id: true, status: true },
  });
  if (activeRecovery) {
    return {
      ok: false, code: 'ACTIVE_RECOVERY_EXISTS', message: `Active recovery ${activeRecovery.id} already exists`,
      recoveryId: activeRecovery.id, status: activeRecovery.status,
    };
  }

  const authority = await loadActiveFenceAuthority(fences, tx);
  if (!authority) return { ok: false, code: 'FENCE_NOT_READY', message: 'Valid ACKNOWLEDGED OPEN/DRAINING fence required' };

  const restriction = await tx.productReservationRestriction.findFirst({
    where: { productId: input.productId, state: { in: [...ACTIVE_RESTRICTION_STATES] } },
    orderBy: { restrictionRevision: 'desc' },
  });
  if (!restriction) return { ok: false, code: 'NO_ACTIVE_RESTRICTION', message: 'Null-restriction clearance is not permitted' };
  if (restriction.state !== 'PREPARED' && restriction.state !== 'ENFORCED') {
    return { ok: false, code: 'INVALID_RESTRICTION_STATE', message: `Unsupported restriction state ${restriction.state}` };
  }

  const latestCompleted = await tx.productSuspectRecovery.findFirst({
    where: { productId: input.productId, status: 'COMPLETED' },
    orderBy: { clearedControlRevision: 'desc' },
    select: { clearedControlRevision: true },
  });
  const floor = Math.max(restriction.restrictionRevision, latestCompleted?.clearedControlRevision ?? 0);
  const clearedControlRevision = floor % 2 === 0 ? floor + 2 : floor + 1;

  const rec = await reconcileProductForClearance({
    tx, redis, productId: input.productId, restriction, clearedControlRevision, fence: transitionTuple(authority.fence),
  });
  if (!rec.ok) return { ok: false, code: rec.code, message: rec.message };

  const markerTargets = rec.snapshot.unblockedTargets.filter((t) => t.targetKind === 'SYNC_STATE');
  const compTargets = rec.snapshot.unblockedTargets.filter((t) => t.targetKind === 'COMPENSATION');
  const recoveryId = randomUUID();

  await tx.productSuspectRecovery.create({
    data: {
      id: recoveryId, requestId, productId: input.productId, restrictionId: restriction.id,
      targetRestrictionRevision: restriction.restrictionRevision, clearedControlRevision, status: 'REQUESTED',
      modeRevision: authority.mode.modeRevision, fenceTransitionId: authority.fence.id,
      incarnation: authority.fence.incarnation, fenceEpoch: authority.fence.epoch,
      fenceRevision: authority.fence.revision, authorizationPhase: authority.fence.phase,
      requestedById: input.requestedById, requestReason: input.requestReason.trim(),
      observationDigest: restriction.observationDigest,
      reconciliationSnapshot: rec.snapshot as unknown as Prisma.InputJsonValue,
      reconciliationDigest: rec.reconciliationDigest, priorStoredTotal: rec.snapshot.priorStoredTotal,
      targetReconciledTotal: rec.snapshot.targetReconciledTotal, priorSuspectPresent: rec.snapshot.priorSuspectPresent,
      affectedMarkerCount: markerTargets.length, affectedCompensationCount: compTargets.length, permitTtlMs,
    },
  });

  for (const target of rec.snapshot.unblockedTargets) {
    await tx.productSuspectRecoveryTarget.create({
      data: {
        id: randomUUID(), recoveryId, productId: input.productId, targetKind: target.targetKind,
        compensationId: target.targetKind === 'COMPENSATION' ? target.id : null,
        syncStateId: target.targetKind === 'SYNC_STATE' ? target.id : null,
        expectedGeneration: target.expectedGeneration, priorStatus: 'BLOCKED', priorBlockReason: 'PRODUCT_SUSPECT',
      },
    });
  }

  return {
    ok: true, recoveryId, requestId, status: 'REQUESTED',
    targetRestrictionRevision: restriction.restrictionRevision, clearedControlRevision,
    reconciliationDigest: rec.reconciliationDigest, targetReconciledTotal: rec.snapshot.targetReconciledTotal,
    affectedMarkerCount: markerTargets.length, affectedCompensationCount: compTargets.length,
  };
}

export async function approveClearanceTx(params: {
  tx: Prisma.TransactionClient;
  fences: ReservationFenceRepository;
  redis: RedisService;
  input: ClearanceApproveInput;
  approvalTtlMs: number;
}): Promise<ClearanceApproveResult> {
  const { tx, fences, redis, input, approvalTtlMs } = params;
  if (!(await isActiveAdminUser(tx, input.approvedById))) {
    return { ok: false, code: 'UNAUTHORIZED_ACTOR', message: 'Active ADMINISTRATOR approver required' };
  }
  const recovery = await tx.productSuspectRecovery.findUnique({ where: { id: input.recoveryId } });
  if (!recovery) return { ok: false, code: 'RECOVERY_NOT_FOUND', message: 'Recovery record not found' };
  if (recovery.status !== 'REQUESTED') {
    return { ok: false, code: 'INVALID_STATE', message: `Cannot approve recovery in ${recovery.status}`, status: recovery.status, recoveryId: recovery.id };
  }
  if (input.approvedById === recovery.requestedById) {
    return { ok: false, code: 'DUAL_CONTROL_VIOLATION', message: 'Approver must differ from requester', recoveryId: recovery.id };
  }
  if (!recovery.restrictionId) {
    return { ok: false, code: 'INVALID_RESTRICTION_REFERENCE', message: 'restrictionId required', recoveryId: recovery.id };
  }

  const authority = await loadActiveFenceAuthority(fences, tx);
  if (
    !authority || authority.fence.id !== recovery.fenceTransitionId || authority.fence.incarnation !== recovery.incarnation ||
    authority.fence.epoch !== recovery.fenceEpoch || authority.fence.revision !== recovery.fenceRevision ||
    authority.fence.phase !== recovery.authorizationPhase || authority.mode.modeRevision !== recovery.modeRevision
  ) {
    return { ok: false, code: 'STALE_FENCE_OR_MODE', message: 'Fence or mode changed since request', recoveryId: recovery.id };
  }

  const restriction = await tx.productReservationRestriction.findUnique({ where: { id: recovery.restrictionId } });
  if (!restriction || restriction.productId !== recovery.productId || restriction.restrictionRevision !== recovery.targetRestrictionRevision || (restriction.state !== 'PREPARED' && restriction.state !== 'ENFORCED')) {
    return { ok: false, code: 'RESTRICTION_NOT_ACTIVE', message: 'Target restriction is no longer active', recoveryId: recovery.id };
  }

  const rec = await reconcileProductForClearance({
    tx, redis, productId: recovery.productId, restriction,
    clearedControlRevision: recovery.clearedControlRevision, fence: transitionTuple(authority.fence),
  });
  if (!rec.ok) return { ok: false, code: rec.code, message: rec.message, recoveryId: recovery.id };
  if (rec.reconciliationDigest !== recovery.reconciliationDigest) {
    return { ok: false, code: 'RECONCILIATION_STALE', message: 'Product inventory or targets drifted since request', recoveryId: recovery.id };
  }

  const approvedAt = new Date();
  const approvalExpiresAt = new Date(approvedAt.getTime() + approvalTtlMs);
  const approvalDigest = computeClearanceApprovalDigest({
    version: 1, requestId: recovery.requestId, productId: recovery.productId, restrictionId: restriction.id,
    targetRestrictionRevision: recovery.targetRestrictionRevision, clearedControlRevision: recovery.clearedControlRevision,
    fenceTransitionId: recovery.fenceTransitionId, incarnation: recovery.incarnation, fenceEpoch: recovery.fenceEpoch,
    fenceRevision: recovery.fenceRevision, authorizationPhase: recovery.authorizationPhase as 'OPEN' | 'DRAINING',
    modeRevision: recovery.modeRevision, observationDigest: recovery.observationDigest,
    reconciliationDigest: recovery.reconciliationDigest, targetReconciledTotal: recovery.targetReconciledTotal,
    affectedMarkerCount: recovery.affectedMarkerCount, affectedCompensationCount: recovery.affectedCompensationCount,
  });

  await tx.productSuspectRecovery.update({
    where: { id: recovery.id },
    data: { status: 'APPROVED', approvedById: input.approvedById, approvedAt, approvalExpiresAt, approvalDigest },
  });
  return { ok: true, recoveryId: recovery.id, status: 'APPROVED', approvedAt, approvalExpiresAt, approvalDigest };
}

export async function rejectClearanceTx(tx: Prisma.TransactionClient, input: ClearanceRejectInput): Promise<ClearanceRejectResult> {
  if (!(await isActiveAdminUser(tx, input.rejectedById))) {
    return { ok: false, code: 'UNAUTHORIZED_ACTOR', message: 'Active ADMINISTRATOR rejector required' };
  }
  const recovery = await tx.productSuspectRecovery.findUnique({ where: { id: input.recoveryId } });
  if (!recovery) return { ok: false, code: 'RECOVERY_NOT_FOUND', message: 'Recovery record not found' };
  if (recovery.status !== 'REQUESTED') {
    return { ok: false, code: 'INVALID_STATE', message: `Cannot reject recovery in ${recovery.status}`, status: recovery.status, recoveryId: recovery.id };
  }
  const rejectedAt = new Date();
  await tx.productSuspectRecovery.update({
    where: { id: recovery.id },
    data: { status: 'REJECTED', rejectedById: input.rejectedById, rejectedAt, rejectionReason: input.rejectionReason.trim() },
  });
  return { ok: true, recoveryId: recovery.id, status: 'REJECTED', rejectedAt };
}

export type ExecutionPrepOutcome =
  | { kind: 'RETURN'; result: ClearanceExecuteResult }
  | { kind: 'RECOVER'; recoveryId: string }
  | { kind: 'EXECUTE'; recoveryId: string; permit: ClearanceLuaPermit; tuple: FenceTuple };

export async function prepareClearanceExecutionTx(params: {
  tx: Prisma.TransactionClient;
  fences: ReservationFenceRepository;
  redis: RedisService;
  input: ClearanceExecuteInput;
}): Promise<ExecutionPrepOutcome> {
  const { tx, fences, redis, input } = params;
  if (input.executorAdminId && !(await isActiveAdminUser(tx, input.executorAdminId))) {
    return { kind: 'RETURN', result: { ok: false, code: 'UNAUTHORIZED_ACTOR', message: 'Active ADMINISTRATOR executor required' } };
  }
  const recovery = await tx.productSuspectRecovery.findUnique({ where: { id: input.recoveryId } });
  if (!recovery) return { kind: 'RETURN', result: { ok: false, code: 'RECOVERY_NOT_FOUND', message: 'Recovery not found' } };
  if (recovery.status === 'COMPLETED') {
    return {
      kind: 'RETURN',
      result: {
        ok: true, recoveryId: recovery.id, status: 'COMPLETED', replayed: true,
        clearedControlRevision: recovery.clearedControlRevision, targetReconciledTotal: recovery.targetReconciledTotal,
        receiptHash: recovery.redisReceiptHash ?? '', unblockedSyncCount: 0, unblockedCompCount: 0, skippedTargetCount: 0,
      },
    };
  }
  if (recovery.status === 'EXECUTING') return { kind: 'RECOVER', recoveryId: recovery.id };
  if (recovery.status !== 'APPROVED' || !recovery.approvedById || !recovery.approvedAt || !recovery.approvalExpiresAt || !recovery.approvalDigest) {
    return { kind: 'RETURN', result: { ok: false, code: 'INVALID_STATE', message: `Cannot execute recovery in ${recovery.status}`, status: recovery.status, recoveryId: recovery.id } };
  }

  const now = input.nowMs ? new Date(input.nowMs) : new Date();
  if (now < recovery.approvedAt) {
    return { kind: 'RETURN', result: { ok: false, code: 'INVALID_EXECUTION_TIME', message: 'Execution clock precedes approval', recoveryId: recovery.id } };
  }
  if (now > recovery.approvalExpiresAt) {
    await tx.productSuspectRecovery.update({ where: { id: recovery.id }, data: { status: 'EXPIRED', failureCode: 'APPROVAL_EXPIRED', failureDetail: 'Approval expired before execution' } });
    return { kind: 'RETURN', result: { ok: false, code: 'APPROVAL_EXPIRED', message: 'Approval expired', status: 'EXPIRED', recoveryId: recovery.id } };
  }
  if (recovery.approvedById === recovery.requestedById || !(await isActiveAdminUser(tx, recovery.requestedById)) || !(await isActiveAdminUser(tx, recovery.approvedById))) {
    await tx.productSuspectRecovery.update({ where: { id: recovery.id }, data: { status: 'ABORTED', failureCode: 'ACTOR_NO_LONGER_ACTIVE_ADMIN', failureDetail: 'Requester/approver no longer active admin' } });
    return { kind: 'RETURN', result: { ok: false, code: 'ACTOR_NO_LONGER_ACTIVE_ADMIN', message: 'Actors invalid', status: 'ABORTED', recoveryId: recovery.id } };
  }

  const restriction = recovery.restrictionId ? await tx.productReservationRestriction.findUnique({ where: { id: recovery.restrictionId } }) : null;
  const authority = await loadActiveFenceAuthority(fences, tx);
  if (
    !restriction || restriction.productId !== recovery.productId || restriction.restrictionRevision !== recovery.targetRestrictionRevision ||
    (restriction.state !== 'PREPARED' && restriction.state !== 'ENFORCED') || !authority ||
    authority.fence.id !== recovery.fenceTransitionId || authority.fence.incarnation !== recovery.incarnation ||
    authority.fence.epoch !== recovery.fenceEpoch || authority.fence.revision !== recovery.fenceRevision ||
    authority.fence.phase !== recovery.authorizationPhase || authority.mode.modeRevision !== recovery.modeRevision
  ) {
    await tx.productSuspectRecovery.update({ where: { id: recovery.id }, data: { status: 'ABORTED', failureCode: 'AUTHORITY_CHANGED_PRE_EXECUTION', failureDetail: 'Fence, mode, or restriction changed before execution' } });
    return { kind: 'RETURN', result: { ok: false, code: 'AUTHORITY_CHANGED_PRE_EXECUTION', message: 'Authority changed before execution', status: 'ABORTED', recoveryId: recovery.id } };
  }

  const expectedApprovalDigest = computeClearanceApprovalDigest({
    version: 1, requestId: recovery.requestId, productId: recovery.productId, restrictionId: restriction.id,
    targetRestrictionRevision: recovery.targetRestrictionRevision, clearedControlRevision: recovery.clearedControlRevision,
    fenceTransitionId: recovery.fenceTransitionId, incarnation: recovery.incarnation, fenceEpoch: recovery.fenceEpoch,
    fenceRevision: recovery.fenceRevision, authorizationPhase: recovery.authorizationPhase as 'OPEN' | 'DRAINING',
    modeRevision: recovery.modeRevision, observationDigest: recovery.observationDigest,
    reconciliationDigest: recovery.reconciliationDigest, targetReconciledTotal: recovery.targetReconciledTotal,
    affectedMarkerCount: recovery.affectedMarkerCount, affectedCompensationCount: recovery.affectedCompensationCount,
  });
  if (expectedApprovalDigest !== recovery.approvalDigest) {
    await tx.productSuspectRecovery.update({ where: { id: recovery.id }, data: { status: 'ABORTED', failureCode: 'APPROVAL_DIGEST_MISMATCH', failureDetail: 'Approval digest mismatch' } });
    return { kind: 'RETURN', result: { ok: false, code: 'APPROVAL_DIGEST_MISMATCH', message: 'Approval digest mismatch', status: 'ABORTED', recoveryId: recovery.id } };
  }

  const tuple = transitionTuple(authority.fence);
  const rec = await reconcileProductForClearance({
    tx, redis, productId: recovery.productId, restriction, clearedControlRevision: recovery.clearedControlRevision, fence: tuple,
  });
  if (!rec.ok || rec.reconciliationDigest !== recovery.reconciliationDigest) {
    const failureCode = rec.ok ? 'RECONCILIATION_STALE' : rec.code.slice(0, 64);
    await tx.productSuspectRecovery.update({ where: { id: recovery.id }, data: { status: 'ABORTED', failureCode, failureDetail: rec.ok ? 'Reconciliation changed before execution' : rec.message.slice(0, 500) } });
    return { kind: 'RETURN', result: { ok: false, code: failureCode, message: 'Reconciliation changed before execution', status: 'ABORTED', recoveryId: recovery.id } };
  }

  // Gap 1A: Keep ProductReservationRestriction in PREPARED/ENFORCED throughout EXECUTING.
  const stagedControlRevision = recovery.targetRestrictionRevision;
  await tx.productSuspectRecovery.update({
    where: { id: recovery.id },
    data: { status: 'EXECUTING', executingAt: now, stagedControlRevision },
  });

  const permit: ClearanceLuaPermit = {
    version: 1, effect: 'PRODUCT_SUSPECT_CLEARANCE', authorizationPhase: recovery.authorizationPhase as 'OPEN' | 'DRAINING',
    tuple, requestId: recovery.requestId, productId: recovery.productId, restrictionId: restriction.id,
    targetRestrictionRevision: recovery.targetRestrictionRevision, stagedControlRevision,
    clearedControlRevision: recovery.clearedControlRevision, reconciliationDigest: recovery.reconciliationDigest,
    approvalDigest: recovery.approvalDigest, priorStoredTotal: recovery.priorStoredTotal,
    targetReconciledTotal: recovery.targetReconciledTotal, priorSuspectPresent: recovery.priorSuspectPresent,
    permitTtlMs: recovery.permitTtlMs,
    activeReservations: rec.snapshot.activeReservations.map((a) => ({ cartId: a.cartId, markerId: a.markerId, quantity: a.quantity })),
    expectedCartIds: rec.snapshot.expectedCartIds, markerIds: rec.snapshot.markerIds, expiresAt: 0,
  };
  return { kind: 'EXECUTE', recoveryId: recovery.id, permit, tuple };
}
