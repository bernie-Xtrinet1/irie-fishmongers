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

export class ChallengeNotFoundError extends WeightAdjustmentRepositoryError {
  constructor(public readonly identifier: string) {
    super(`CustomerWeightApprovalChallenge "${identifier}" was not found.`);
  }
}

export class ChallengeExpiredError extends WeightAdjustmentRepositoryError {
  constructor(public readonly challengeId: string, public readonly expiresAt: Date) {
    super(`Approval challenge "${challengeId}" expired at ${expiresAt.toISOString()}.`);
  }
}

export class ChallengeRevokedError extends WeightAdjustmentRepositoryError {
  constructor(public readonly challengeId: string, public readonly reason?: string) {
    super(`Approval challenge "${challengeId}" has been revoked${reason ? `: ${reason}` : '.'}`);
  }
}

export class ChallengeAlreadyConsumedError extends WeightAdjustmentRepositoryError {
  constructor(public readonly challengeId: string, public readonly consumedAt?: Date | null) {
    super(
      `Approval challenge "${challengeId}" was already consumed${consumedAt ? ` at ${consumedAt.toISOString()}` : ''}. Double-consumption prohibited.`,
    );
  }
}

export class InvalidApprovalTokenError extends WeightAdjustmentRepositoryError {
  constructor(message = 'Provided approval token is invalid, malformed, or unverifiable.') {
    super(message);
  }
}

export class CustomerApprovalMismatchError extends WeightAdjustmentRepositoryError {
  constructor(message: string) {
    super(message);
  }
}

export class CustomerApprovalChallengeConflictError extends WeightAdjustmentRepositoryError {
  constructor(
    public readonly weightAdjustmentId: string,
    public readonly measurementRevision: number,
    message?: string,
  ) {
    super(
      message ??
        `Concurrent challenge creation or renewal conflict for adjustment "${weightAdjustmentId}" revision ${measurementRevision}.`,
    );
  }
}

export class OrderItemNotFoundError extends WeightAdjustmentRepositoryError {
  constructor(public readonly orderItemId: string) {
    super(`OrderItem "${orderItemId}" was not found.`);
  }
}

export class UnlinkedSeafoodLotError extends WeightAdjustmentRepositoryError {
  constructor(public readonly lotId: string) {
    super(`Seafood lot "${lotId}" is unlinked, missing, or untraceable.`);
  }
}

export class SeafoodSafetyHoldError extends WeightAdjustmentRepositoryError {
  constructor(public readonly lotId: string, public readonly status?: string, message?: string) {
    super(
      message ??
        `Seafood lot "${lotId}" is not SAFE for fulfillment${status ? ` (current status: ${status})` : ''}.`,
    );
  }
}

export class SeafoodLotRecalledError extends WeightAdjustmentRepositoryError {
  constructor(public readonly lotId: string, public readonly recallReason?: string) {
    super(`Seafood lot "${lotId}" is subject to an active commercial recall${recallReason ? `: ${recallReason}` : '.'}`);
  }
}

export class ColdChainBreachError extends WeightAdjustmentRepositoryError {
  constructor(public readonly lotId: string, message?: string) {
    super(message ?? `Seafood lot "${lotId}" has unresolved critical cold-chain temperature violations.`);
  }
}

export class FoodSafetyIncidentActiveError extends WeightAdjustmentRepositoryError {
  constructor(public readonly lotId: string, message?: string) {
    super(message ?? `Seafood lot "${lotId}" has unresolved serious food safety incident reports.`);
  }
}

export class QualityInspectionFailedError extends WeightAdjustmentRepositoryError {
  constructor(public readonly lotId: string, public readonly inspectionResult: string) {
    super(`Seafood lot "${lotId}" failed quality inspection with blocking result "${inspectionResult}".`);
  }
}

export class ProvenanceMismatchError extends WeightAdjustmentRepositoryError {
  constructor(message: string) {
    super(message);
  }
}

export class SeafoodListingExpiredError extends WeightAdjustmentRepositoryError {
  constructor(public readonly listingId: string, public readonly expiresAt: Date) {
    super(`Daily listing "${listingId}" expired at ${expiresAt.toISOString()}.`);
  }
}

export class VendorNotEligibleError extends WeightAdjustmentRepositoryError {
  constructor(public readonly vendorId: string, message?: string) {
    super(message ?? `Vendor "${vendorId}" is not approved or licensed for commercial seafood distribution.`);
  }
}

export class AmbiguousListingProvenanceError extends WeightAdjustmentRepositoryError {
  constructor(public readonly productId: string, public readonly candidateCount: number) {
    super(
      `Ambiguous listing provenance for product "${productId}": found ${candidateCount} candidate listings. Exact historical listing identity required.`,
    );
  }
}

export class MissingListingProvenanceError extends WeightAdjustmentRepositoryError {
  constructor(public readonly productId: string, message?: string) {
    super(
      message ??
        `Listing-backed product "${productId}" lacks an authoritative active listing or traceable lot association.`,
    );
  }
}

export class MissingCheckoutConsentError extends WeightAdjustmentRepositoryError {
  constructor(message: string) {
    super(message);
  }
}

export class ConflictingReplayError extends WeightAdjustmentRepositoryError {
  constructor(public readonly orderItemId: string, message?: string) {
    super(
      message ??
        `Conflicting replay attempt for order item "${orderItemId}": provided parameters do not match existing immutable snapshot.`,
    );
  }
}

export class MissingAuthoritativeLotProvenanceError extends WeightAdjustmentRepositoryError {
  constructor(public readonly orderItemId: string, message?: string) {
    super(
      message ??
        `OrderItem "${orderItemId}" lacks authoritative, immutable persisted order-time lot and listing evidence in database. Accepting unauthenticated caller-supplied evidence or inferring provenance from mutable product records is strictly prohibited.`,
    );
  }
}

export class InvalidPreparationOptionError extends WeightAdjustmentRepositoryError {
  constructor(public readonly optionName: string, message?: string) {
    super(
      message ??
        `Selected preparation service "${optionName}" is invalid, unresolved, or malformed for the authoritative listing.`,
    );
  }
}

export class UnsupportedPreparationCurrencyError extends WeightAdjustmentRepositoryError {
  constructor(public readonly currency: string, message?: string) {
    super(
      message ??
        `Preparation fee currency "${currency}" is unsupported. Authoritative platform transactions require JMD.`,
    );
  }
}
