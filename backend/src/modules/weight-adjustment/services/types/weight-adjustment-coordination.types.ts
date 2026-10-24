import {
  CustomerApprovalAction,
  CustomerWeightApprovalRecord,
  CustomerWeightApprovalStatus,
  ObligationStatus,
  PaymentObligationDirection,
  SettlementChannel,
  SeafoodOrderWeightAdjustment,
  WeightAdjustmentObligation,
  WeightAdjustmentSettlementRecord,
  WeightMeasurementStatus,
} from '@prisma/client';
import Decimal from 'decimal.js';

import { RequestUser } from '../../../../common/guards/jwt-auth.guard';
import { FinancialEvidenceClassification } from '../../repositories/weight-financial-obligation.repository';

// ============================================================================
// Domain Coordination Errors
// ============================================================================

export class WeightAdjustmentCoordinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class UnauthorizedApprovalCustomerError extends WeightAdjustmentCoordinationError {
  constructor(message: string) {
    super(message);
  }
}

export class StaleApprovalRevisionError extends WeightAdjustmentCoordinationError {
  constructor(
    public readonly weightAdjustmentId: string,
    public readonly attemptedRevision: number,
    public readonly activeRevision: number,
  ) {
    super(
      `Approval rejected on weight adjustment "${weightAdjustmentId}": submitted revision ${attemptedRevision} is superseded by active revision ${activeRevision}.`,
    );
  }
}

export class ApprovalNotRequiredError extends WeightAdjustmentCoordinationError {
  constructor(public readonly weightAdjustmentId: string) {
    super(
      `Customer approval is not required on weight adjustment "${weightAdjustmentId}": measured total does not exceed authorized ceiling.`,
    );
  }
}

export class DormantSettlementChannelError extends WeightAdjustmentCoordinationError {
  constructor(public readonly channel: SettlementChannel, message?: string) {
    super(
      message ??
        `Settlement channel "${channel}" is dormant and unsupported in WP3.4: automated secondary payment capture/verification is not available.`,
    );
  }
}

export class InvalidSettlementEvidenceError extends WeightAdjustmentCoordinationError {
  constructor(message: string) {
    super(message);
  }
}

export class UnauthorizedSettlementOperatorError extends WeightAdjustmentCoordinationError {
  constructor(message: string) {
    super(message);
  }
}

export class RegulatoryEligibilitySuspendedError extends WeightAdjustmentCoordinationError {
  constructor(message: string) {
    super(message);
  }
}

export class ReleaseReadinessBlockedError extends WeightAdjustmentCoordinationError {
  constructor(message: string) {
    super(message);
  }
}

// ============================================================================
// Customer Approval Coordination Types
// ============================================================================

export interface ProcessCustomerApprovalInput {
  readonly weightAdjustmentId: string;
  readonly measurementRevision: number;
  readonly rawApprovalToken: string;
  readonly action: CustomerApprovalAction;
  readonly authenticatedActor: RequestUser;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly rejectionReason?: string;
}

export type CustomerApprovalCoordinationStatus =
  | 'APPROVED'
  | 'REJECTED'
  | 'IDEMPOTENT_REPLAY';

export interface CustomerApprovalCoordinationResult {
  readonly status: CustomerApprovalCoordinationStatus;
  readonly weightAdjustment: SeafoodOrderWeightAdjustment;
  readonly approvalRecord?: CustomerWeightApprovalRecord;
  readonly challengeId: string;
  readonly isReplay: boolean;
}

// ============================================================================
// Financial Settlement Coordination Types
// ============================================================================

export interface RecordFinancialSettlementInput {
  readonly obligationId: string;
  readonly settlementChannel: SettlementChannel;
  readonly amountSettled: Decimal | string | number;
  readonly idempotencyKey: string;
  readonly externalReference?: string;
  readonly evidenceDocumentUrl?: string;
  readonly authenticatedActor: RequestUser;
}

export interface FinancialSettlementCoordinationResult {
  readonly settlementRecord: WeightAdjustmentSettlementRecord;
  readonly obligation: WeightAdjustmentObligation;
  readonly evidenceClassification: FinancialEvidenceClassification;
  readonly isFullySettled: boolean;
  readonly remainingBalanceJmd: string;
  readonly isReplay: boolean;
}

export interface ObligationBalanceSummary {
  readonly obligationId: string;
  readonly totalAmountJmd: string;
  readonly totalSettledJmd: string;
  readonly remainingBalanceJmd: string;
  readonly status: ObligationStatus;
  readonly isFullySettled: boolean;
}

// ============================================================================
// Release Readiness Evaluation Types
// ============================================================================

export type GateAssessmentStatus =
  | 'PASSED'
  | 'PASSED_CREDIT_QUEUED'
  | 'COD_COLLECTION_PENDING'
  | 'BLOCKED'
  | 'NOT_REQUIRED'
  | 'REJECTED'
  | 'EXPIRED';

export interface GateAssessment {
  readonly gateName: string;
  readonly status: GateAssessmentStatus;
  readonly details?: string;
}

export interface EvaluateReleaseReadinessInput {
  readonly weightAdjustmentId: string;
  readonly authenticatedActor?: RequestUser;
}

export interface ReleaseReadinessEvaluationResult {
  readonly weightAdjustmentId: string;
  readonly orderItemId: string;
  readonly dispatchReady: boolean;
  readonly handoverReady: boolean;
  readonly gate1Measurement: GateAssessment;
  readonly gate2FoodSafetyAndRegulatory: GateAssessment;
  readonly gate3CustomerApproval: GateAssessment;
  readonly gate4PreparationFulfillment: GateAssessment;
  readonly gate5FinancialSettlement: GateAssessment;
  readonly evaluatedAt: Date;
}
