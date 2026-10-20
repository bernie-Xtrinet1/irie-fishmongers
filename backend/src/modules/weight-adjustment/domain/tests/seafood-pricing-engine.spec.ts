import Decimal from 'decimal.js';

import { SeafoodPricingEngine } from '../seafood-pricing-engine';
import {
  CeilingBelowEstimateError,
  InvalidPrecisionError,
  InvalidPreparationFeeError,
  InvalidPriceError,
  InvalidPricingBasisError,
  InvalidWeightUnitError,
  NegativeWeightError,
  PreparedWeightExceedsBillableError,
  ZeroWeightError,
} from '../seafood-pricing-engine.errors';
import {
  ApprovalReason,
  ObligationDirection,
  PreparationFeeStructure,
  SeafoodPricingBasis,
  WeightUnit,
} from '../seafood-pricing-engine.types';

describe('SeafoodPricingEngine', () => {
  describe('Mandatory Corrected Scenarios', () => {
    it('calculates corrected Dressed Kingfish scenario matching exact specifications', () => {
      // Estimated: 4.00 lb @ JMD 1,100.00/lb + JMD 50.00/lb prep fee
      // Final: 3.80 lb @ JMD 1,100.00/lb + JMD 50.00/lb prep fee
      const result = SeafoodPricingEngine.calculate({
        pricingBasis: SeafoodPricingBasis.DRESSED,
        unit: WeightUnit.POUND,
        unitPrice: '1100.00',
        estimatedWeight: '4.00',
        verifiedWeight: '3.80',
        preparation: {
          feeStructure: PreparationFeeStructure.PER_UNIT_WEIGHT,
          feeRate: '50.00',
        },
      });

      // Estimated Subtotals
      expect(result.estimatedProductSubtotal.toString()).toBe('4400');
      expect(result.estimatedPreparationFee.toString()).toBe('200');
      expect(result.estimatedItemTotal.toString()).toBe('4600');

      // Final Subtotals
      expect(result.finalProductSubtotal?.toString()).toBe('4180');
      expect(result.finalPreparationFee?.toString()).toBe('190');
      expect(result.finalItemTotal?.toString()).toBe('4370');

      // Adjustments & Differences
      expect(result.productSubtotalDifference?.toString()).toBe('-220');
      expect(result.preparationFeeDifference?.toString()).toBe('-10');
      expect(result.totalAdjustmentAmount?.toString()).toBe('-230');

      // Status & Obligation
      expect(result.obligationDirection).toBe(ObligationDirection.CREDIT_DUE_CUSTOMER);
      expect(result.requiresCustomerApproval).toBe(false);
      expect(result.approvalReason).toBe(ApprovalReason.NO_APPROVAL_REQUIRED);
      expect(result.isWithinCustomerCeiling).toBe(true);
    });

    it('calculates Whole Raw Snapper with filleting where preparation yield does not reduce billable weight', () => {
      // 5.00 lb Snapper @ JMD 800/lb + JMD 300 flat filleting fee
      // Actual whole catch is 5.20 lb; delivered fillets weigh 3.64 lb (30% yield loss)
      const result = SeafoodPricingEngine.calculate({
        pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
        unit: WeightUnit.POUND,
        unitPrice: '800.00',
        estimatedWeight: '5.00',
        verifiedWeight: '5.20',
        preparedNetWeight: '3.64',
        preparation: {
          feeStructure: PreparationFeeStructure.FLAT_FEE,
          feeRate: '300.00',
          description: 'Skinless fillets',
        },
        customerAuthorizedCeilingJmd: '4500.00',
      });

      // Billable weight is the whole raw weight (5.20 lb), NOT the prepared fillet weight (3.64 lb)
      expect(result.verifiedBillableWeight?.toString()).toBe('5.2');
      expect(result.preparedNetWeight?.toString()).toBe('3.64');

      // Yield Loss Tracking
      expect(result.yieldLossWeight?.toString()).toBe('1.56');
      expect(result.yieldLossPercentage?.toString()).toBe('30');

      // Estimated
      expect(result.estimatedProductSubtotal.toString()).toBe('4000');
      expect(result.estimatedPreparationFee.toString()).toBe('300');
      expect(result.estimatedItemTotal.toString()).toBe('4300');

      // Final Product Subtotal = 5.20 * 800 = 4,160.00
      expect(result.finalProductSubtotal?.toString()).toBe('4160');
      // Preparation fee remains flat JMD 300.00
      expect(result.finalPreparationFee?.toString()).toBe('300');
      // Final Total = 4,160 + 300 = 4,460.00
      expect(result.finalItemTotal?.toString()).toBe('4460');

      // Differences
      expect(result.totalAdjustmentAmount?.toString()).toBe('160');

      // Within customer ceiling (4,460 <= 4,500)
      expect(result.isWithinCustomerCeiling).toBe(true);
      expect(result.requiresCustomerApproval).toBe(false);
      expect(result.approvalReason).toBe(ApprovalReason.NO_APPROVAL_REQUIRED);
      expect(result.obligationDirection).toBe(ObligationDirection.SUPPLEMENTAL_PAYMENT_DUE);
    });

    it('calculates Finished Product Snapper fillets priced by net delivered weight with fee included', () => {
      const result = SeafoodPricingEngine.calculate({
        pricingBasis: SeafoodPricingBasis.FINISHED_PRODUCT,
        unit: WeightUnit.POUND,
        unitPrice: '1500.00',
        estimatedWeight: '3.00',
        verifiedWeight: '2.85',
        preparation: {
          feeStructure: PreparationFeeStructure.INCLUDED_IN_PRICE,
        },
      });

      expect(result.estimatedProductSubtotal.toString()).toBe('4500');
      expect(result.estimatedPreparationFee.toString()).toBe('0');
      expect(result.estimatedItemTotal.toString()).toBe('4500');

      expect(result.finalProductSubtotal?.toString()).toBe('4275');
      expect(result.finalPreparationFee?.toString()).toBe('0');
      expect(result.finalItemTotal?.toString()).toBe('4275');

      expect(result.totalAdjustmentAmount?.toString()).toBe('-225');
      expect(result.obligationDirection).toBe(ObligationDirection.CREDIT_DUE_CUSTOMER);
      expect(result.requiresCustomerApproval).toBe(false);
    });
  });

  describe('Customer Monetary Ceiling and Approval Gates', () => {
    it('auto-accepts overweight catch when within explicit customer ceiling', () => {
      const result = SeafoodPricingEngine.calculate({
        pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
        unit: WeightUnit.POUND,
        unitPrice: '1000.00',
        estimatedWeight: '4.00', // Estimated: JMD 4,000.00
        verifiedWeight: '4.20', // Final: JMD 4,200.00
        customerAuthorizedCeilingJmd: '4300.00',
      });

      expect(result.totalAdjustmentAmount?.toString()).toBe('200');
      expect(result.isWithinCustomerCeiling).toBe(true);
      expect(result.requiresCustomerApproval).toBe(false);
      expect(result.approvalReason).toBe(ApprovalReason.NO_APPROVAL_REQUIRED);
      expect(result.obligationDirection).toBe(ObligationDirection.SUPPLEMENTAL_PAYMENT_DUE);
    });

    it('requires customer approval when overweight catch exceeds explicit customer ceiling', () => {
      const result = SeafoodPricingEngine.calculate({
        pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
        unit: WeightUnit.POUND,
        unitPrice: '1000.00',
        estimatedWeight: '4.00', // Estimated: JMD 4,000.00
        verifiedWeight: '4.40', // Final: JMD 4,400.00
        customerAuthorizedCeilingJmd: '4250.00', // Ceiling: JMD 4,250.00 (Exceeded)
      });

      expect(result.finalItemTotal?.toString()).toBe('4400');
      expect(result.isWithinCustomerCeiling).toBe(false);
      expect(result.requiresCustomerApproval).toBe(true);
      expect(result.approvalReason).toBe(ApprovalReason.EXCEEDS_AUTHORIZED_CEILING);
      expect(result.obligationDirection).toBe(ObligationDirection.SUPPLEMENTAL_PAYMENT_DUE);
    });

    it('requires customer approval on ANY overweight catch when NO ceiling was authorized (no 10% auto-tolerance)', () => {
      const result = SeafoodPricingEngine.calculate({
        pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
        unit: WeightUnit.POUND,
        unitPrice: '1000.00',
        estimatedWeight: '4.00', // Estimated: JMD 4,000.00
        verifiedWeight: '4.05', // Final: JMD 4,050.00 (+1.25% only)
        // No customerAuthorizedCeilingJmd provided
      });

      // Even a tiny +1.25% increase requires explicit customer confirmation if no ceiling was pre-authorized
      expect(result.isWithinCustomerCeiling).toBe(false);
      expect(result.requiresCustomerApproval).toBe(true);
      expect(result.approvalReason).toBe(ApprovalReason.EXCEEDS_AUTHORIZED_CEILING);
    });

    it('rejects customer authorized ceiling if set lower than estimated item total', () => {
      expect(() =>
        SeafoodPricingEngine.calculate({
          pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
          unit: WeightUnit.POUND,
          unitPrice: '1000.00',
          estimatedWeight: '4.00', // Estimated: JMD 4,000.00
          customerAuthorizedCeilingJmd: '3900.00', // Below estimate
        }),
      ).toThrow(CeilingBelowEstimateError);
    });
  });

  describe('Precision, Rounding and Metric Units', () => {
    it('handles kilogram weights up to 3 decimal places with correct half-up rounding', () => {
      const result = SeafoodPricingEngine.calculate({
        pricingBasis: SeafoodPricingBasis.FINISHED_PRODUCT,
        unit: WeightUnit.KILOGRAM,
        unitPrice: '850.25',
        estimatedWeight: '1.000',
        verifiedWeight: '1.155', // 3 decimal places allowed for kg
      });

      // 1.155 * 850.25 = 982.03875 -> rounds to 982.04
      expect(result.finalProductSubtotal?.toString()).toBe('982.04');
    });

    it('rejects kilogram weight with more than 3 decimal places', () => {
      expect(() =>
        SeafoodPricingEngine.calculate({
          pricingBasis: SeafoodPricingBasis.FINISHED_PRODUCT,
          unit: WeightUnit.KILOGRAM,
          unitPrice: '850.00',
          estimatedWeight: '1.1555', // 4 decimal places
        }),
      ).toThrow(InvalidPrecisionError);
    });

    it('accepts pound weights with up to 2 decimal places', () => {
      const result = SeafoodPricingEngine.calculate({
        pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
        unit: WeightUnit.POUND,
        unitPrice: '600.00',
        estimatedWeight: '5.25',
        verifiedWeight: '5.75',
      });

      expect(result.estimatedProductSubtotal.toString()).toBe('3150');
      expect(result.finalProductSubtotal?.toString()).toBe('3450');
    });

    it('rejects pound weight with more than 2 decimal places', () => {
      expect(() =>
        SeafoodPricingEngine.calculate({
          pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
          unit: WeightUnit.POUND,
          unitPrice: '600.00',
          estimatedWeight: '5.255', // 3 decimal places
        }),
      ).toThrow(InvalidPrecisionError);
    });

    it('rejects unit price with more than 2 decimal places', () => {
      expect(() =>
        SeafoodPricingEngine.calculate({
          pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
          unit: WeightUnit.POUND,
          unitPrice: '600.125',
          estimatedWeight: '5.00',
        }),
      ).toThrow(InvalidPrecisionError);
    });
  });

  describe('Validation & Edge Case Rejections', () => {
    it('rejects negative estimated weight', () => {
      expect(() =>
        SeafoodPricingEngine.calculate({
          pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
          unit: WeightUnit.POUND,
          unitPrice: '500.00',
          estimatedWeight: '-2.00',
        }),
      ).toThrow(NegativeWeightError);
    });

    it('rejects zero estimated weight', () => {
      expect(() =>
        SeafoodPricingEngine.calculate({
          pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
          unit: WeightUnit.POUND,
          unitPrice: '500.00',
          estimatedWeight: '0.00',
        }),
      ).toThrow(ZeroWeightError);
    });

    it('rejects negative verified weight', () => {
      expect(() =>
        SeafoodPricingEngine.calculate({
          pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
          unit: WeightUnit.POUND,
          unitPrice: '500.00',
          estimatedWeight: '5.00',
          verifiedWeight: '-1.00',
        }),
      ).toThrow(NegativeWeightError);
    });

    it('rejects zero unit price', () => {
      expect(() =>
        SeafoodPricingEngine.calculate({
          pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
          unit: WeightUnit.POUND,
          unitPrice: '0.00',
          estimatedWeight: '5.00',
        }),
      ).toThrow(InvalidPriceError);
    });

    it('rejects negative preparation fee rate', () => {
      expect(() =>
        SeafoodPricingEngine.calculate({
          pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
          unit: WeightUnit.POUND,
          unitPrice: '500.00',
          estimatedWeight: '5.00',
          preparation: {
            feeStructure: PreparationFeeStructure.FLAT_FEE,
            feeRate: '-50.00',
          },
        }),
      ).toThrow(InvalidPreparationFeeError);
    });

    it('rejects prepared net weight exceeding whole raw weight', () => {
      expect(() =>
        SeafoodPricingEngine.calculate({
          pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
          unit: WeightUnit.POUND,
          unitPrice: '800.00',
          estimatedWeight: '5.00',
          verifiedWeight: '5.00',
          preparedNetWeight: '5.50', // Impossible: prepared weight > raw weight
        }),
      ).toThrow(PreparedWeightExceedsBillableError);
    });

    it('rejects invalid pricing basis', () => {
      expect(() =>
        SeafoodPricingEngine.calculate({
          pricingBasis: 'UNCOOKED' as any,
          unit: WeightUnit.POUND,
          unitPrice: '800.00',
          estimatedWeight: '5.00',
        }),
      ).toThrow(InvalidPricingBasisError);
    });

    it('rejects non-weight units such as PER_ITEM or PER_PACKAGE', () => {
      expect(() =>
        SeafoodPricingEngine.calculate({
          pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
          unit: 'PER_PACKAGE' as any,
          unitPrice: '800.00',
          estimatedWeight: '5.00',
        }),
      ).toThrow(InvalidWeightUnitError);
    });
  });

  describe('Estimated-Only Calculation (Pre-Weigh Mode)', () => {
    it('calculates initial checkout estimate when verified weight is absent', () => {
      const result = SeafoodPricingEngine.calculate({
        pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
        unit: WeightUnit.POUND,
        unitPrice: '750.00',
        estimatedWeight: '6.00',
        preparation: {
          feeStructure: PreparationFeeStructure.FLAT_FEE,
          feeRate: '250.00',
        },
        customerAuthorizedCeilingJmd: '5000.00',
      });

      expect(result.estimatedProductSubtotal.toString()).toBe('4500');
      expect(result.estimatedPreparationFee.toString()).toBe('250');
      expect(result.estimatedItemTotal.toString()).toBe('4750');

      expect(result.verifiedBillableWeight).toBeNull();
      expect(result.finalProductSubtotal).toBeNull();
      expect(result.finalItemTotal).toBeNull();
      expect(result.totalAdjustmentAmount).toBeNull();

      expect(result.approvalReason).toBe(ApprovalReason.PENDING_VERIFICATION);
      expect(result.obligationDirection).toBe(ObligationDirection.PENDING_VERIFICATION);
    });
  });

  describe('Immutability and Object Integrity', () => {
    it('returns a deeply frozen object that cannot be mutated', () => {
      const result = SeafoodPricingEngine.calculate({
        pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
        unit: WeightUnit.POUND,
        unitPrice: '500.00',
        estimatedWeight: '2.00',
        verifiedWeight: '2.00',
      });

      expect(Object.isFrozen(result)).toBe(true);
      expect(() => {
        (result as any).estimatedProductSubtotal = new Decimal(9999);
      }).toThrow();
    });
  });
});
