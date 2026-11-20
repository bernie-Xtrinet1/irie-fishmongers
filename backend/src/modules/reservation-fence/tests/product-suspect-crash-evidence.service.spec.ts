import { createHash, randomUUID } from 'crypto';

import { ProductSuspectCrashEvidenceService } from '../services/product-suspect-crash-evidence.service';
import {
  CrashEvidenceEvaluationInput,
  ProductSuspectClearanceReceipt,
} from '../types/product-suspect-recovery.types';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('ProductSuspectCrashEvidenceService (Phase 5 crash-evidence rules)', () => {
  const service = new ProductSuspectCrashEvidenceService();
  const productId = randomUUID();
  const restrictionId = randomUUID();
  const recoveryId = randomUUID();
  const requestId = randomUUID();
  const incarnation = randomUUID();
  const reconciliationDigest = 'a'.repeat(64);
  const approvalDigest = 'b'.repeat(64);

  function baseReceipt(overrides: Partial<ProductSuspectClearanceReceipt> = {}): string {
    return JSON.stringify({
      version: 1,
      effect: 'PRODUCT_SUSPECT_CLEARANCE',
      status: 'APPLIED',
      requestId,
      productId,
      incarnation,
      epoch: 1,
      clearedControlRevision: 2,
      reconciliationDigest,
      approvalDigest,
      targetTotal: 4,
      ...overrides,
    });
  }

  function baseInput(overrides: Partial<CrashEvidenceEvaluationInput> = {}): CrashEvidenceEvaluationInput {
    return {
      recovery: {
        id: recoveryId,
        requestId,
        productId,
        restrictionId,
        targetRestrictionRevision: 1,
        clearedControlRevision: 2,
        stagedControlRevision: 1,
        incarnation,
        fenceEpoch: 1,
        reconciliationDigest,
        approvalDigest,
        priorStoredTotal: 1,
        targetReconciledTotal: 4,
        priorSuspectPresent: true,
        status: 'EXECUTING',
        redisReceiptHash: null,
        ...overrides.recovery,
      },
      durableRestrictionState: 'CLEARING',
      durableRestrictionId: restrictionId,
      durableRestrictionRevision: 1,
      durableClearedByRecoveryId: recoveryId,
      infrastructureError: false,
      receipt: { keyState: 'ABSENT', raw: null },
      control: {
        keyState: 'PRESENT',
        ttlMs: -1,
        payload: {
          version: 1,
          productId,
          state: 'RESTRICTED',
          restrictionId,
          restrictionRevision: 1,
          incarnation,
          epoch: 1,
        },
      },
      suspectPresent: true,
      storedTotal: 1,
      storedTotalState: 'VALID_INTEGER',
      permitState: 'ABSENT',
      preWriteAbortVerified: false,
      ...overrides,
    };
  }

  it('classifies APPLIED only when durable, cryptographic receipt, and live Redis state all agree', () => {
    const raw = baseReceipt();
    const res = service.evaluate(
      baseInput({
        receipt: { keyState: 'PRESENT', raw },
        control: {
          keyState: 'PRESENT',
          ttlMs: -1,
          payload: {
            version: 1,
            productId,
            state: 'ALLOW',
            restrictionId: null,
            restrictionRevision: 2,
            incarnation,
            epoch: 1,
          },
        },
        suspectPresent: false,
        storedTotal: 4,
        storedTotalState: 'VALID_INTEGER',
      }),
    );

    expect(res).toMatchObject({
      classification: 'APPLIED',
      nextStatus: 'COMPLETED',
      canComplete: true,
      quarantineRequired: false,
      reasonCode: 'VERIFIED_APPLIED',
      receiptHash: sha256(raw),
    });
  });

  it('classifies NOT_APPLIED only when non-execution is positively established against intact pre-state', () => {
    const res = service.evaluate(
      baseInput({
        permitState: 'UNCONSUMED_PRESENT',
      }),
    );
    expect(res).toMatchObject({
      classification: 'NOT_APPLIED',
      nextStatus: 'ABORTED',
      canComplete: false,
      quarantineRequired: false,
      reasonCode: 'POSITIVELY_ESTABLISHED_NOT_APPLIED',
    });

    const abortedPreWrite = service.evaluate(
      baseInput({
        preWriteAbortVerified: true,
        control: {
          keyState: 'PRESENT',
          ttlMs: -1,
          payload: {
            version: 1,
            productId,
            state: 'CLEARANCE_STAGED',
            restrictionId,
            restrictionRevision: 1,
            incarnation,
            epoch: 1,
          },
        },
      }),
    );
    expect(abortedPreWrite.classification).toBe('NOT_APPLIED');
    expect(abortedPreWrite.nextStatus).toBe('ABORTED');
  });

  it('never treats missing or expired receipt alone as NOT_APPLIED (quarantines as UNKNOWN)', () => {
    const missingAlone = service.evaluate(
      baseInput({
        permitState: 'UNKNOWN',
        preWriteAbortVerified: false,
      }),
    );
    expect(missingAlone).toMatchObject({
      classification: 'UNKNOWN',
      nextStatus: 'AMBIGUOUS_QUARANTINED',
      canComplete: false,
      quarantineRequired: true,
      reasonCode: 'INSUFFICIENT_NON_EXECUTION_PROOF',
    });

    const expiredReceipt = service.evaluate(
      baseInput({
        receipt: { keyState: 'EXPIRED_OR_EVICTED', raw: null },
        permitState: 'UNCONSUMED_PRESENT',
      }),
    );
    expect(expiredReceipt).toMatchObject({
      classification: 'UNKNOWN',
      nextStatus: 'AMBIGUOUS_QUARANTINED',
      canComplete: false,
      quarantineRequired: true,
      reasonCode: 'EXPIRED_OR_MISSING_RECEIPT',
    });

    const missingControl = service.evaluate(
      baseInput({
        control: { keyState: 'ABSENT', ttlMs: null, payload: null },
        preWriteAbortVerified: true,
      }),
    );
    expect(missingControl.classification).toBe('UNKNOWN');
    expect(missingControl.nextStatus).toBe('AMBIGUOUS_QUARANTINED');

    const infraFail = service.evaluate(baseInput({ infrastructureError: true }));
    expect(infraFail).toMatchObject({
      classification: 'UNKNOWN',
      nextStatus: 'AMBIGUOUS_QUARANTINED',
      quarantineRequired: true,
      canComplete: false,
    });
  });

  it('quarantines contradictory, corrupt, or unreceipted physical changes as AMBIGUOUS', () => {
    const raw = baseReceipt();
    const corruptReceipt = service.evaluate(baseInput({ receipt: { keyState: 'MALFORMED', raw: '{' } }));
    expect(corruptReceipt).toMatchObject({ classification: 'AMBIGUOUS', nextStatus: 'AMBIGUOUS_QUARANTINED', canComplete: false });

    const wrongIdentityReceipt = service.evaluate(
      baseInput({
        receipt: { keyState: 'PRESENT', raw: baseReceipt({ requestId: randomUUID() }) },
      }),
    );
    expect(wrongIdentityReceipt.classification).toBe('AMBIGUOUS');
    expect(wrongIdentityReceipt.nextStatus).toBe('AMBIGUOUS_QUARANTINED');

    const validReceiptButStillSuspect = service.evaluate(
      baseInput({
        receipt: { keyState: 'PRESENT', raw },
        control: {
          keyState: 'PRESENT',
          ttlMs: -1,
          payload: {
            version: 1,
            productId,
            state: 'ALLOW',
            restrictionId: null,
            restrictionRevision: 2,
            incarnation,
            epoch: 1,
          },
        },
        suspectPresent: true,
        storedTotal: 4,
      }),
    );
    expect(validReceiptButStillSuspect).toMatchObject({
      classification: 'AMBIGUOUS',
      nextStatus: 'AMBIGUOUS_QUARANTINED',
      canComplete: false,
      reasonCode: 'RECEIPT_PHYSICAL_CONTRADICTION',
    });

    const allowWithoutReceipt = service.evaluate(
      baseInput({
        receipt: { keyState: 'ABSENT', raw: null },
        control: {
          keyState: 'PRESENT',
          ttlMs: -1,
          payload: {
            version: 1,
            productId,
            state: 'ALLOW',
            restrictionId: null,
            restrictionRevision: 2,
            incarnation,
            epoch: 1,
          },
        },
        suspectPresent: false,
        storedTotal: 4,
      }),
    );
    expect(allowWithoutReceipt).toMatchObject({
      classification: 'AMBIGUOUS',
      nextStatus: 'AMBIGUOUS_QUARANTINED',
      canComplete: false,
      reasonCode: 'PHYSICAL_APPLIED_WITHOUT_RECEIPT',
    });

    const transientTtlControl = service.evaluate(
      baseInput({
        control: {
          keyState: 'PRESENT',
          ttlMs: 5000,
          payload: {
            version: 1,
            productId,
            state: 'RESTRICTED',
            restrictionId,
            restrictionRevision: 1,
            incarnation,
            epoch: 1,
          },
        },
      }),
    );
    expect(transientTtlControl.classification).toBe('AMBIGUOUS');
    expect(transientTtlControl.quarantineRequired).toBe(true);
  });
});
