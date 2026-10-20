import Decimal from 'decimal.js';

import {
  CeilingBelowEstimateError,
  InvalidPrecisionError,
  InvalidPreparationFeeError,
  InvalidPriceError,
  InvalidPricingBasisError,
  InvalidWeightUnitError,
  NegativeWeightError,
  PreparedWeightExceedsBillableError,
  WeightPricingEngineError,
  ZeroWeightError,
} from './seafood-pricing-engine.errors';
import {
  ApprovalReason,
  ObligationDirection,
  PreparationConfig,
  PreparationFeeStructure,
  SeafoodPricingBasis,
  WeightCalculationInput,
  WeightCalculationResult,
  WeightUnit,
} from './seafood-pricing-engine.types';

// Configure Decimal.js precision and rounding behavior globally for this engine
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export class SeafoodPricingEngine {
  /**
   * Calculates weight adjustments, product subtotals, preparation fees,
   * customer ceiling compliance, and settlement obligations.
   *
   * Pure, side-effect-free domain calculation returning a deeply frozen result.
   */
  static calculate(input: WeightCalculationInput): WeightCalculationResult {
    // 1. Validate Pricing Basis
    const pricingBasis = this.validatePricingBasis(input.pricingBasis);

    // 2. Validate Weight Unit
    const unit = this.validateWeightUnit(input.unit);

    // 3. Validate Unit Price
    const unitPrice = this.validateUnitPrice(input.unitPrice);

    // 4. Validate Estimated Weight
    const estimatedBillableWeight = this.validateWeight(input.estimatedWeight, unit, 'Estimated weight');

    // 5. Validate Preparation Fee Configuration
    const preparation = this.validatePreparationConfig(input.preparation);

    // 6. Calculate Estimated Subtotals & Item Total
    const estimatedProductSubtotal = estimatedBillableWeight
      .times(unitPrice)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    const estimatedPreparationFee = this.computePreparationFee(
      estimatedBillableWeight,
      preparation.feeStructure,
      preparation.feeRate,
    );

    const estimatedItemTotal = estimatedProductSubtotal.plus(estimatedPreparationFee);

    // 7. Validate Customer Authorized Ceiling (if supplied)
    const customerAuthorizedCeilingJmd = this.validateCustomerCeiling(
      input.customerAuthorizedCeilingJmd,
      estimatedItemTotal,
    );

    // 8. Handle Case where verified weight is not yet provided (estimated-only calculation)
    if (input.verifiedWeight === undefined || input.verifiedWeight === null) {
      return Object.freeze({
        pricingBasis,
        unit,
        unitPrice,
        estimatedBillableWeight,
        verifiedBillableWeight: null,
        preparedNetWeight: null,
        weightDifference: null,
        yieldLossWeight: null,
        yieldLossPercentage: null,
        estimatedProductSubtotal,
        finalProductSubtotal: null,
        productSubtotalDifference: null,
        preparationFeeStructure: preparation.feeStructure,
        preparationFeeRate: preparation.feeRate,
        estimatedPreparationFee,
        finalPreparationFee: null,
        preparationFeeDifference: null,
        estimatedItemTotal,
        finalItemTotal: null,
        totalAdjustmentAmount: null,
        customerAuthorizedCeilingJmd,
        isWithinCustomerCeiling: null,
        requiresCustomerApproval: false,
        approvalReason: ApprovalReason.PENDING_VERIFICATION,
        obligationDirection: ObligationDirection.PENDING_VERIFICATION,
      });
    }

    // 9. Validate Verified Billable Weight
    const verifiedBillableWeight = this.validateWeight(input.verifiedWeight, unit, 'Verified weight');

    // 10. Validate Prepared Net Weight (if supplied)
    let preparedNetWeight: Decimal | null = null;
    let yieldLossWeight: Decimal | null = null;
    let yieldLossPercentage: Decimal | null = null;

    if (input.preparedNetWeight !== undefined && input.preparedNetWeight !== null) {
      preparedNetWeight = this.validateWeight(input.preparedNetWeight, unit, 'Prepared net weight');

      if (pricingBasis === SeafoodPricingBasis.WHOLE_RAW) {
        if (preparedNetWeight.greaterThan(verifiedBillableWeight)) {
          throw new PreparedWeightExceedsBillableError(
            `Prepared net weight (${preparedNetWeight.toString()}) cannot exceed whole raw catch weight (${verifiedBillableWeight.toString()})`,
          );
        }
        yieldLossWeight = verifiedBillableWeight.minus(preparedNetWeight);
        yieldLossPercentage = yieldLossWeight
          .dividedBy(verifiedBillableWeight)
          .times(100)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      } else if (pricingBasis === SeafoodPricingBasis.DRESSED) {
        if (preparedNetWeight.greaterThan(verifiedBillableWeight)) {
          throw new PreparedWeightExceedsBillableError(
            `Prepared net weight (${preparedNetWeight.toString()}) cannot exceed dressed catch weight (${verifiedBillableWeight.toString()})`,
          );
        }
        yieldLossWeight = verifiedBillableWeight.minus(preparedNetWeight);
        yieldLossPercentage = yieldLossWeight
          .dividedBy(verifiedBillableWeight)
          .times(100)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      }
    }

    // 11. Calculate Weight Difference
    const weightDifference = verifiedBillableWeight.minus(estimatedBillableWeight);

    // 12. Calculate Final Product Subtotal using Verified Billable Weight
    // NOTE: For WHOLE_RAW, verifiedBillableWeight is the whole raw weight. Preparation yield loss does not reduce it.
    const finalProductSubtotal = verifiedBillableWeight
      .times(unitPrice)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    const productSubtotalDifference = finalProductSubtotal.minus(estimatedProductSubtotal);

    // 13. Calculate Final Preparation Fee
    const finalPreparationFee = this.computePreparationFee(
      verifiedBillableWeight,
      preparation.feeStructure,
      preparation.feeRate,
    );

    const preparationFeeDifference = finalPreparationFee.minus(estimatedPreparationFee);

    // 14. Calculate Final Total Item Amount & Total Adjustment
    const finalItemTotal = finalProductSubtotal.plus(finalPreparationFee);
    const totalAdjustmentAmount = finalItemTotal.minus(estimatedItemTotal);

    // 15. Determine Ceiling Compliance, Customer Approval Requirement, and Obligation Direction
    let isWithinCustomerCeiling: boolean;
    let requiresCustomerApproval: boolean;
    let approvalReason: ApprovalReason;
    let obligationDirection: ObligationDirection;

    if (totalAdjustmentAmount.isZero()) {
      isWithinCustomerCeiling = true;
      requiresCustomerApproval = false;
      approvalReason = ApprovalReason.NO_APPROVAL_REQUIRED;
      obligationDirection = ObligationDirection.NONE;
    } else if (totalAdjustmentAmount.isNegative()) {
      // Lower weight is in the customer's favor; no customer approval required
      isWithinCustomerCeiling = true;
      requiresCustomerApproval = false;
      approvalReason = ApprovalReason.NO_APPROVAL_REQUIRED;
      obligationDirection = ObligationDirection.CREDIT_DUE_CUSTOMER;
    } else {
      // Catch is heavier than estimated: supplemental payment is due
      obligationDirection = ObligationDirection.SUPPLEMENTAL_PAYMENT_DUE;

      if (customerAuthorizedCeilingJmd !== null) {
        if (finalItemTotal.lessThanOrEqualTo(customerAuthorizedCeilingJmd)) {
          isWithinCustomerCeiling = true;
          requiresCustomerApproval = false;
          approvalReason = ApprovalReason.NO_APPROVAL_REQUIRED;
        } else {
          isWithinCustomerCeiling = false;
          requiresCustomerApproval = true;
          approvalReason = ApprovalReason.EXCEEDS_AUTHORIZED_CEILING;
        }
      } else {
        // Without an explicit pre-authorized monetary ceiling, any increase requires explicit customer approval
        isWithinCustomerCeiling = false;
        requiresCustomerApproval = true;
        approvalReason = ApprovalReason.EXCEEDS_AUTHORIZED_CEILING;
      }
    }

    return Object.freeze({
      pricingBasis,
      unit,
      unitPrice,
      estimatedBillableWeight,
      verifiedBillableWeight,
      preparedNetWeight,
      weightDifference,
      yieldLossWeight,
      yieldLossPercentage,
      estimatedProductSubtotal,
      finalProductSubtotal,
      productSubtotalDifference,
      preparationFeeStructure: preparation.feeStructure,
      preparationFeeRate: preparation.feeRate,
      estimatedPreparationFee,
      finalPreparationFee,
      preparationFeeDifference,
      estimatedItemTotal,
      finalItemTotal,
      totalAdjustmentAmount,
      customerAuthorizedCeilingJmd,
      isWithinCustomerCeiling,
      requiresCustomerApproval,
      approvalReason,
      obligationDirection,
    });
  }

  // --- Validation Helpers ---

  private static validatePricingBasis(basis: unknown): SeafoodPricingBasis {
    if (!basis || typeof basis !== 'string') {
      throw new InvalidPricingBasisError('Seafood pricing basis is required');
    }
    const normalized = basis.trim().toUpperCase();
    if (
      normalized !== SeafoodPricingBasis.WHOLE_RAW &&
      normalized !== SeafoodPricingBasis.DRESSED &&
      normalized !== SeafoodPricingBasis.FINISHED_PRODUCT
    ) {
      throw new InvalidPricingBasisError(
        `Invalid pricing basis: '${basis}'. Must be WHOLE_RAW, DRESSED, or FINISHED_PRODUCT`,
      );
    }
    return normalized as SeafoodPricingBasis;
  }

  private static validateWeightUnit(unit: unknown): WeightUnit {
    if (!unit || typeof unit !== 'string') {
      throw new InvalidWeightUnitError('Weight unit is required');
    }
    const normalized = unit.trim().toUpperCase();
    if (normalized === WeightUnit.POUND || normalized === 'PER_POUND') {
      return WeightUnit.POUND;
    }
    if (normalized === WeightUnit.KILOGRAM || normalized === 'PER_KILOGRAM') {
      return WeightUnit.KILOGRAM;
    }
    throw new InvalidWeightUnitError(
      `Invalid weight unit: '${unit}'. Only POUND (PER_POUND) and KILOGRAM (PER_KILOGRAM) are supported for weight pricing`,
    );
  }

  private static validateUnitPrice(val: unknown): Decimal {
    const d = this.toDecimal(val, 'Unit price');
    if (!d.isFinite()) {
      throw new InvalidPriceError('Unit price must be a finite number');
    }
    if (d.lessThanOrEqualTo(0)) {
      throw new InvalidPriceError(`Unit price must be greater than zero. Received: ${d.toString()}`);
    }
    if (d.decimalPlaces() > 2) {
      throw new InvalidPrecisionError(
        `Unit price cannot have more than 2 decimal places. Received: ${d.toString()}`,
      );
    }
    return d;
  }

  private static validateWeight(val: unknown, unit: WeightUnit, fieldName: string): Decimal {
    const d = this.toDecimal(val, fieldName);
    if (!d.isFinite()) {
      throw new WeightPricingEngineError(`${fieldName} must be a finite number`, 'INVALID_WEIGHT');
    }
    if (d.isNegative()) {
      throw new NegativeWeightError(`${fieldName} cannot be negative. Received: ${d.toString()}`);
    }
    if (d.isZero()) {
      throw new ZeroWeightError(`${fieldName} must be greater than zero. Received: ${d.toString()}`);
    }

    if (unit === WeightUnit.POUND) {
      if (d.decimalPlaces() > 2) {
        throw new InvalidPrecisionError(
          `${fieldName} in pounds cannot have more than 2 decimal places. Received: ${d.toString()}`,
        );
      }
    } else if (unit === WeightUnit.KILOGRAM) {
      if (d.decimalPlaces() > 3) {
        throw new InvalidPrecisionError(
          `${fieldName} in kilograms cannot have more than 3 decimal places. Received: ${d.toString()}`,
        );
      }
    }

    return d;
  }

  private static validatePreparationConfig(prep?: PreparationConfig): {
    feeStructure: PreparationFeeStructure;
    feeRate: Decimal;
  } {
    if (!prep) {
      return {
        feeStructure: PreparationFeeStructure.INCLUDED_IN_PRICE,
        feeRate: new Decimal(0),
      };
    }

    const structure = prep.feeStructure;
    if (
      structure !== PreparationFeeStructure.FLAT_FEE &&
      structure !== PreparationFeeStructure.PER_UNIT_WEIGHT &&
      structure !== PreparationFeeStructure.INCLUDED_IN_PRICE
    ) {
      throw new InvalidPreparationFeeError(
        `Unsupported preparation fee structure: '${String(structure)}'`,
      );
    }

    if (structure === PreparationFeeStructure.INCLUDED_IN_PRICE) {
      return {
        feeStructure: structure,
        feeRate: new Decimal(0),
      };
    }

    const rate = this.toDecimal(prep.feeRate ?? 0, 'Preparation fee rate');
    if (!rate.isFinite()) {
      throw new InvalidPreparationFeeError('Preparation fee rate must be a finite number');
    }
    if (rate.isNegative()) {
      throw new InvalidPreparationFeeError('Preparation fee rate cannot be negative');
    }
    if (rate.decimalPlaces() > 2) {
      throw new InvalidPrecisionError(
        `Preparation fee rate cannot have more than 2 decimal places. Received: ${rate.toString()}`,
      );
    }

    return {
      feeStructure: structure,
      feeRate: rate,
    };
  }

  private static validateCustomerCeiling(
    ceilingVal: unknown,
    estimatedTotal: Decimal,
  ): Decimal | null {
    if (ceilingVal === undefined || ceilingVal === null) {
      return null;
    }

    const ceiling = this.toDecimal(ceilingVal, 'Customer authorized ceiling');
    if (!ceiling.isFinite()) {
      throw new WeightPricingEngineError(
        'Customer authorized ceiling must be a finite number',
        'INVALID_CEILING',
      );
    }
    if (ceiling.isNegative() || ceiling.isZero()) {
      throw new WeightPricingEngineError(
        'Customer authorized ceiling must be greater than zero',
        'INVALID_CEILING',
      );
    }
    if (ceiling.decimalPlaces() > 2) {
      throw new InvalidPrecisionError(
        `Customer authorized ceiling cannot have more than 2 decimal places. Received: ${ceiling.toString()}`,
      );
    }
    if (ceiling.lessThan(estimatedTotal)) {
      throw new CeilingBelowEstimateError(
        `Customer authorized ceiling (${ceiling.toString()}) cannot be less than estimated item total (${estimatedTotal.toString()})`,
      );
    }

    return ceiling;
  }

  private static computePreparationFee(
    billableWeight: Decimal,
    structure: PreparationFeeStructure,
    feeRate: Decimal,
  ): Decimal {
    if (structure === PreparationFeeStructure.INCLUDED_IN_PRICE) {
      return new Decimal(0);
    }
    if (structure === PreparationFeeStructure.FLAT_FEE) {
      return feeRate.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }
    if (structure === PreparationFeeStructure.PER_UNIT_WEIGHT) {
      return billableWeight.times(feeRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }
    return new Decimal(0);
  }

  private static toDecimal(val: unknown, fieldName: string): Decimal {
    if (val instanceof Decimal) {
      return val;
    }
    if (typeof val === 'number' || typeof val === 'string') {
      try {
        return new Decimal(val);
      } catch {
        throw new WeightPricingEngineError(
          `${fieldName} must be a valid numeric value. Received: ${String(val)}`,
          'INVALID_NUMERIC',
        );
      }
    }
    throw new WeightPricingEngineError(
      `${fieldName} must be a number, string, or Decimal. Received: ${typeof val}`,
      'INVALID_NUMERIC',
    );
  }
}
