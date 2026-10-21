export class WeightAdjustmentRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class IdempotencyPayloadConflictError extends WeightAdjustmentRepositoryError {
  constructor(
    public readonly idempotencyKey: string,
    public readonly existingHash: string,
    public readonly incomingHash: string,
  ) {
    super(
      `Idempotency conflict for key "${idempotencyKey}": incoming payload hash does not match existing record`,
    );
  }
}

export class StaleRevisionConflictError extends WeightAdjustmentRepositoryError {
  constructor(
    public readonly weightAdjustmentId: string,
    public readonly expectedRevision: number,
    public readonly activeRevision: number,
  ) {
    super(
      `Stale revision conflict on adjustment "${weightAdjustmentId}": expected revision ${expectedRevision} but current active revision is ${activeRevision}. Silently re-sequencing is prohibited.`,
    );
  }
}

export class ImmutableAuditMutationError extends WeightAdjustmentRepositoryError {
  constructor(public readonly entityName: string, public readonly id: string) {
    super(`Mutation prohibited: "${entityName}" record with ID "${id}" is strictly append-only and cannot be updated or deleted.`);
  }
}

export class AdjustmentNotFoundError extends WeightAdjustmentRepositoryError {
  constructor(public readonly identifier: string) {
    super(`SeafoodOrderWeightAdjustment "${identifier}" was not found.`);
  }
}

export class InvalidSettlementChannelError extends WeightAdjustmentRepositoryError {
  constructor(public readonly channel: string) {
    super(`Settlement channel "${channel}" is invalid or unauthorized.`);
  }
}

export class SettlementChannelDirectionMismatchError extends WeightAdjustmentRepositoryError {
  constructor(
    public readonly channel: string,
    public readonly direction: string,
  ) {
    super(
      `Settlement channel "${channel}" is incompatible with obligation direction "${direction}".`,
    );
  }
}

export class InvalidSettlementAmountError extends WeightAdjustmentRepositoryError {
  constructor(message: string) {
    super(message);
  }
}

export class SettlementAmountExceedsObligationError extends WeightAdjustmentRepositoryError {
  constructor(
    public readonly obligationId: string,
    public readonly requestedAmount: string,
    public readonly remainingBalance: string,
  ) {
    super(
      `Settlement amount JMD ${requestedAmount} exceeds remaining balance JMD ${remainingBalance} for obligation "${obligationId}".`,
    );
  }
}

export class ObligationAlreadySettledError extends WeightAdjustmentRepositoryError {
  constructor(public readonly obligationId: string) {
    super(`Obligation "${obligationId}" is already fully settled.`);
  }
}

export class CustomerApprovalRevisionMismatchError extends WeightAdjustmentRepositoryError {
  constructor(
    public readonly weightAdjustmentId: string,
    public readonly proposedRevision: number,
    public readonly activeMeasurementRevision: number,
  ) {
    super(
      `Customer approval bound to revision ${proposedRevision} cannot be applied: active measurement revision is ${activeMeasurementRevision}.`,
    );
  }
}
