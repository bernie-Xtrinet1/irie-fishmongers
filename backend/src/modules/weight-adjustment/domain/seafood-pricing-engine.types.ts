import Decimal from 'decimal.js';

export enum SeafoodPricingBasis {
  WHOLE_RAW = 'WHOLE_RAW',
  DRESSED = 'DRESSED',
  FINISHED_PRODUCT = 'FINISHED_PRODUCT',
}

export enum WeightUnit {
  POUND = 'POUND',
  KILOGRAM = 'KILOGRAM',
}

export enum PreparationFeeStructure {
  FLAT_FEE = 'FLAT_FEE',
  PER_UNIT_WEIGHT = 'PER_UNIT_WEIGHT',
  INCLUDED_IN_PRICE = 'INCLUDED_IN_PRICE',
}

export enum ObligationDirection {
  NONE = 'NONE',
  CREDIT_DUE_CUSTOMER = 'CREDIT_DUE_CUSTOMER',
  SUPPLEMENTAL_PAYMENT_DUE = 'SUPPLEMENTAL_PAYMENT_DUE',
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
}

export enum ApprovalReason {
  NO_APPROVAL_REQUIRED = 'NO_APPROVAL_REQUIRED',
  EXCEEDS_AUTHORIZED_CEILING = 'EXCEEDS_AUTHORIZED_CEILING',
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
}

export interface PreparationConfig {
  readonly feeStructure: PreparationFeeStructure;
  readonly feeRate?: Decimal | string | number;
  readonly description?: string;
}

export interface WeightCalculationInput {
  readonly pricingBasis: SeafoodPricingBasis;
  readonly unit: WeightUnit | 'PER_POUND' | 'PER_KILOGRAM';
  readonly unitPrice: Decimal | string | number;
  readonly estimatedWeight: Decimal | string | number;
  readonly verifiedWeight?: Decimal | string | number;
  readonly preparedNetWeight?: Decimal | string | number;
  readonly preparation?: PreparationConfig;
  readonly customerAuthorizedCeilingJmd?: Decimal | string | number;
}

export interface WeightCalculationResult {
  readonly pricingBasis: SeafoodPricingBasis;
  readonly unit: WeightUnit;
  readonly unitPrice: Decimal;

  // Billable and Physical Weights
  readonly estimatedBillableWeight: Decimal;
  readonly verifiedBillableWeight: Decimal | null;
  readonly preparedNetWeight: Decimal | null;
  readonly weightDifference: Decimal | null;
  readonly yieldLossWeight: Decimal | null;
  readonly yieldLossPercentage: Decimal | null;

  // Product Subtotals
  readonly estimatedProductSubtotal: Decimal;
  readonly finalProductSubtotal: Decimal | null;
  readonly productSubtotalDifference: Decimal | null;

  // Preparation Fees
  readonly preparationFeeStructure: PreparationFeeStructure;
  readonly preparationFeeRate: Decimal;
  readonly estimatedPreparationFee: Decimal;
  readonly finalPreparationFee: Decimal | null;
  readonly preparationFeeDifference: Decimal | null;

  // Total Item Amounts (Product + Preparation Fee)
  readonly estimatedItemTotal: Decimal;
  readonly finalItemTotal: Decimal | null;
  readonly totalAdjustmentAmount: Decimal | null;

  // Ceiling and Customer Approval
  readonly customerAuthorizedCeilingJmd: Decimal | null;
  readonly isWithinCustomerCeiling: boolean | null;
  readonly requiresCustomerApproval: boolean;
  readonly approvalReason: ApprovalReason;

  // Obligation / Direction
  readonly obligationDirection: ObligationDirection;
}
