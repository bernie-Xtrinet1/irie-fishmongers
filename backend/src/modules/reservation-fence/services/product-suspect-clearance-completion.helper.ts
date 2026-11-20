import { Prisma, ProductReservationRestriction, ProductSuspectRecovery } from '@prisma/client';

import { ReservationFenceRepository } from '../repositories/reservation-fence.repository';
import { legalPair } from '../types/reservation-fence.types';
import { ClearanceExecuteResult, ClearanceTargetManifestEntry } from '../types/product-suspect-clearance.types';
import { CrashEvidenceEvaluationResult } from '../types/product-suspect-recovery.types';

function capturedTargetMetaMap(recovery: ProductSuspectRecovery): Map<string, ClearanceTargetManifestEntry> {
  const map = new Map<string, ClearanceTargetManifestEntry>();
  const snap = recovery.reconciliationSnapshot;
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return map;
  const targets = (snap as { unblockedTargets?: unknown }).unblockedTargets;
  if (!Array.isArray(targets)) return map;
  for (const item of targets) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Partial<ClearanceTargetManifestEntry>;
    if ((entry.targetKind === 'SYNC_STATE' || entry.targetKind === 'COMPENSATION') && typeof entry.id === 'string') {
      map.set(`${entry.targetKind}:${entry.id}`, entry as ClearanceTargetManifestEntry);
    }
  }
  return map;
}

export async function isActiveAdminUser(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
  if (!userId) return false;
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { status: true, roles: { select: { role: { select: { name: true } } } } },
  });
  return !!user && user.status === 'ACTIVE' && user.roles.some((r) => r.role.name === 'ADMINISTRATOR');
}

export async function loadActiveFenceAuthority(fences: ReservationFenceRepository, tx: Prisma.TransactionClient) {
  const [fence, mode] = await Promise.all([fences.latest(tx), fences.mode(tx)]);
  if (
    !fence ||
    fence.status !== 'ACKNOWLEDGED' ||
    fence.protocol !== 1 ||
    mode.modeRevision === null ||
    fence.mode !== mode.mode ||
    fence.modeRevision !== mode.modeRevision ||
    !legalPair(mode.mode, fence.phase, true) ||
    (fence.phase !== 'OPEN' && fence.phase !== 'DRAINING')
  ) {
    return null;
  }
  return { fence, mode: { mode: mode.mode, modeRevision: mode.modeRevision } };
}

export async function persistClearanceOutcomeTx(params: {
  tx: Prisma.TransactionClient;
  recovery: ProductSuspectRecovery;
  restriction: ProductReservationRestriction | null;
  evaluation: CrashEvidenceEvaluationResult;
  rawReceipt: string | null;
  now: Date;
}): Promise<ClearanceExecuteResult> {
  const { tx, recovery, restriction, evaluation, rawReceipt, now } = params;
  const effectiveTime = now < recovery.executingAt! ? recovery.executingAt! : now;
  const evidenceDetail = { reasonCode: evaluation.reasonCode, detail: evaluation.detail };

  if (evaluation.canComplete && evaluation.classification === 'APPLIED' && rawReceipt && evaluation.receiptHash) {
    if (!recovery.restrictionId || !restriction || (restriction.state !== 'PREPARED' && restriction.state !== 'ENFORCED')) {
      return {
        ok: false,
        code: 'INVALID_RESTRICTION_FOR_COMPLETION',
        message: 'Active PREPARED or ENFORCED restriction required to complete clearance',
      };
    }

    const newerRestriction = await tx.productReservationRestriction.findFirst({
      where: { productId: recovery.productId, restrictionRevision: { gt: recovery.targetRestrictionRevision } },
      select: { id: true },
    });
    if (newerRestriction) {
      throw new Error('Newer restriction incident detected before completion');
    }

    await tx.productSuspectRecovery.update({
      where: { id: recovery.id },
      data: {
        status: 'COMPLETED',
        executionEvidence: 'APPLIED',
        evidenceEvaluatedAt: effectiveTime,
        evidenceDetail,
        redisReceipt: rawReceipt,
        redisReceiptHash: evaluation.receiptHash,
        completedAt: effectiveTime,
      },
    });

    const cleared = await tx.productReservationRestriction.updateMany({
      where: {
        id: restriction.id,
        productId: recovery.productId,
        restrictionRevision: recovery.targetRestrictionRevision,
        state: { in: ['PREPARED', 'ENFORCED'] },
      },
      data: { state: 'CLEARED', clearedByRecoveryId: recovery.id, clearedAt: effectiveTime },
    });
    if (cleared.count !== 1) {
      throw new Error(`Expected single restriction clearance update, got ${cleared.count}`);
    }

    const targets = await tx.productSuspectRecoveryTarget.findMany({
      where: { recoveryId: recovery.id, productId: recovery.productId, unblockedAt: null },
      orderBy: { id: 'asc' },
    });
    const metaByKey = capturedTargetMetaMap(recovery);

    let unblockedSyncCount = 0;
    let unblockedCompCount = 0;
    let skippedTargetCount = 0;

    for (const target of targets) {
      if (target.targetKind === 'SYNC_STATE' && target.syncStateId) {
        const meta = metaByKey.get(`SYNC_STATE:${target.syncStateId}`);
        const res = await tx.cartReservationSyncState.updateMany({
          where: {
            id: target.syncStateId,
            productId: recovery.productId,
            status: 'BLOCKED',
            blockReason: 'PRODUCT_SUSPECT',
            resolvedAt: null,
            processingStartedAt: null,
            generation: { gte: target.expectedGeneration },
            ...(meta && Number.isInteger(meta.priorAttemptCount) ? { attemptCount: meta.priorAttemptCount } : {}),
          },
          data: { status: 'PENDING', blockReason: null, nextAttemptAt: null },
        });
        if (res.count === 1) unblockedSyncCount += 1;
        else skippedTargetCount += 1;
      } else if (target.targetKind === 'COMPENSATION' && target.compensationId) {
        const meta = metaByKey.get(`COMPENSATION:${target.compensationId}`);
        const res = await tx.cartReservationCompensation.updateMany({
          where: {
            id: target.compensationId,
            productId: recovery.productId,
            status: 'BLOCKED',
            blockReason: 'PRODUCT_SUSPECT',
            resolvedAt: null,
            permanentFailureAt: null,
            generation: { gte: target.expectedGeneration },
            ...(meta && Number.isInteger(meta.priorAttemptCount) ? { attemptCount: meta.priorAttemptCount } : {}),
          },
          data: { status: 'PENDING', blockReason: null, nextAttemptAt: effectiveTime },
        });
        if (res.count === 1) unblockedCompCount += 1;
        else skippedTargetCount += 1;
      }
      await tx.productSuspectRecoveryTarget.update({
        where: { id: target.id },
        data: { unblockedAt: effectiveTime },
      });
    }

    return {
      ok: true,
      recoveryId: recovery.id,
      status: 'COMPLETED',
      replayed: false,
      clearedControlRevision: recovery.clearedControlRevision,
      targetReconciledTotal: recovery.targetReconciledTotal,
      receiptHash: evaluation.receiptHash,
      unblockedSyncCount,
      unblockedCompCount,
      skippedTargetCount,
    };
  }

  if (evaluation.nextStatus === 'ABORTED' && evaluation.classification === 'NOT_APPLIED') {
    await tx.productSuspectRecovery.update({
      where: { id: recovery.id },
      data: {
        status: 'ABORTED',
        executionEvidence: 'NOT_APPLIED',
        evidenceEvaluatedAt: effectiveTime,
        evidenceDetail,
        failureCode: evaluation.reasonCode.slice(0, 64),
        failureDetail: evaluation.detail.slice(0, 500),
      },
    });
    return {
      ok: false, code: evaluation.reasonCode, message: evaluation.detail,
      status: 'ABORTED', recoveryId: recovery.id,
    };
  }

  await tx.productSuspectRecovery.update({
    where: { id: recovery.id },
    data: {
      status: 'AMBIGUOUS_QUARANTINED',
      executionEvidence: evaluation.classification === 'APPLIED' ? 'AMBIGUOUS' : evaluation.classification,
      evidenceEvaluatedAt: effectiveTime,
      evidenceDetail,
      quarantinedAt: effectiveTime,
      quarantineReason: evaluation.reasonCode.slice(0, 128),
      failureCode: evaluation.reasonCode.slice(0, 64),
      failureDetail: evaluation.detail.slice(0, 500),
    },
  });
  return {
    ok: false, code: evaluation.reasonCode, message: evaluation.detail,
    status: 'AMBIGUOUS_QUARANTINED', recoveryId: recovery.id,
  };
}
