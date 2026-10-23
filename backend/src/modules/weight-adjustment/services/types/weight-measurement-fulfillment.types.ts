import {
  CustomerWeightApprovalStatus,
  Prisma,
  SeafoodOrderWeightAdjustment,
  SeafoodPreparationFulfillmentEvent,
  SeafoodPricingBasis,
  SeafoodWeightMeasurementEvent,
  UsablePartsFulfillmentOutcome,
  WeightMeasurementStatus,
  WeightUnit,
} from '@prisma/client';
import Decimal from 'decimal.js';

import { RequestUser } from '../../../../common/guards/jwt-auth.guard';
import { WeightCalculationResult } from '../../domain/seafood-pricing-engine.types';

// ============================================================================
// Domain Errors
// ============================================================================

export class WeightMeasurementServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class InvalidScaleEvidenceError extends WeightMeasurementServiceError {
  constructor(message: string) {
    super(message);
  }
}

export class UnauthorizedMeasurementOperatorError extends WeightMeasurementServiceError {
  constructor(message: string) {
    super(message);
  }
}

export class UnauthorizedPreparationOperatorError extends WeightMeasurementServiceError {
  constructor(message: string) {
    super(message);
  }
}

export class MissingCorrectionReasonError extends WeightMeasurementServiceError {
  constructor(message?: string) {
    super(
      message ??
        'A documented correction reason is required for any measurement revision beyond revision 1.',
    );
  }
}

export class MeasurementCorrectionProhibitedError extends WeightMeasurementServiceError {
  constructor(message: string) {
    super(message);
  }
}

export class PreparationCommencementIndeterminateError extends WeightMeasurementServiceError {
  constructor(public readonly weightAdjustmentId: string, message?: string) {
    super(
      message ??
        `Cannot execute WHOLE_RAW measurement correction on adjustment "${weightAdjustmentId}": the database schema lacks an authoritative preparation commencement tracker. Prohibiting correction because absence of completed preparation does not prove physical cutting has not begun.`,
    );
  }
}

export class UnmeasuredPreparationError extends WeightMeasurementServiceError {
  constructor(public readonly weightAdjustmentId: string, message?: string) {
    super(
      message ??
        `Preparation fulfillment prohibited on adjustment "${weightAdjustmentId}": order item has not received an authoritative weight measurement.`,
    );
  }
}

export class UnselectedPreparationError extends WeightMeasurementServiceError {
  constructor(public readonly weightAdjustmentId: string, message?: string) {
    super(
      message ??
        `Preparation fulfillment prohibited on adjustment "${weightAdjustmentId}": customer did not select a preparation service for this seafood item.`,
    );
  }
}

export class PreparationServiceMismatchError extends WeightMeasurementServiceError {
  constructor(message: string) {
    super(message);
  }
}

export class InvalidUsablePartsOutcomeError extends WeightMeasurementServiceError {
  constructor(message: string) {
    super(message);
  }
}

export class InvalidPreparationWeightError extends WeightMeasurementServiceError {
  constructor(message: string) {
    super(message);
  }
}

export class UnsupportedPricingBasisWorkflowError extends WeightMeasurementServiceError {
  constructor(public readonly pricingBasis: string, message?: string) {
    super(
      message ??
        `Pricing basis "${pricingBasis}" is not supported for this measurement or preparation stage.`,
    );
  }
}

// ============================================================================
// Inputs and Results
// ============================================================================

export interface RecordWeightMeasurementInput {
  readonly weightAdjustmentId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly measuredWeight: Decimal | string | number;
  readonly scalePhotoUrl: string;
  readonly scaleDeviceIdentifier?: string;
  readonly scaleCalibrationDate?: Date;
  readonly operatorUserId: string;
  readonly authenticatedActor?: RequestUser;
  readonly correctionReason?: string;
  readonly physicalLotId?: string;
  readonly tareIsolated?: boolean;
}

export interface WeightMeasurementResult {
  readonly status: 'MEASURED_WITHIN_CEILING' | 'MEASURED_EXCEEDS_CEILING' | 'IDEMPOTENT_REPLAY';
  readonly measurementEvent: SeafoodWeightMeasurementEvent;
  readonly weightAdjustment: SeafoodOrderWeightAdjustment;
  readonly isReplay: boolean;
  readonly pricingResult: WeightCalculationResult;
  readonly requiresCustomerApproval: boolean;
  readonly customerApprovalStatus: CustomerWeightApprovalStatus;
}

export interface RecordPreparationFulfillmentInput {
  readonly weightAdjustmentId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly operatorUserId: string;
  readonly authenticatedActor?: RequestUser;
  readonly preparationServiceName?: string;
  readonly unit?: WeightUnit;
  readonly partsOutcome: UsablePartsFulfillmentOutcome;
  readonly partsDisposalReason?: string;
  readonly preparedNetWeight?: Decimal | string | number;
  readonly preparedPhotoUrl?: string;
  readonly correctionReason?: string;
  readonly physicalLotId?: string;
}

export interface PreparationFulfillmentResult {
  readonly status: 'FULFILLED' | 'IDEMPOTENT_REPLAY';
  readonly preparationEvent: SeafoodPreparationFulfillmentEvent;
  readonly weightAdjustment: SeafoodOrderWeightAdjustment;
  readonly isReplay: boolean;
  readonly yieldLossWeight?: Decimal;
  readonly yieldLossPercent?: Decimal;
}
